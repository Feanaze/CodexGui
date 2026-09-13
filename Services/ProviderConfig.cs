using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodexGui.Services;

/// <summary>服务商配置的当前状态（给界面回显用，不包含密钥明文）。</summary>
public sealed class ProviderState
{
    public bool Configured { get; init; }
    public string ProviderId { get; init; } = "deepseek";
    public string BaseUrl { get; init; } = "";
    public string Model { get; init; } = "";
    public string WireApi { get; init; } = "responses";
    public bool HasApiKey { get; init; }
    public string ConfigPath { get; init; } = "";
}

/// <summary>
/// 直接读写 Codex CLI 的 <c>codex-home\config.toml</c> 与 <c>auth.json</c>：
/// 界面上填的 API 链接、模型、密钥最终交给 CLI 自己使用，GUI 不参与转发。
/// </summary>
public static class ProviderConfig
{
    public static string HomeDir => CodexEnvironment.CodexHome ?? StoragePaths.CodexHomeDir;

    public static string ConfigPath => Path.Combine(HomeDir, "config.toml");

    public static string AuthPath => Path.Combine(HomeDir, "auth.json");

    private static readonly Regex ModelRegex = new(@"(?m)^\s*model\s*=\s*""([^""]+)""", RegexOptions.Compiled);
    private static readonly Regex ProviderRegex = new(@"(?m)^\s*model_provider\s*=\s*""([^""]+)""", RegexOptions.Compiled);
    private static readonly Regex BaseUrlRegex = new(@"(?m)^\s*base_url\s*=\s*""([^""]*)""", RegexOptions.Compiled);
    private static readonly Regex WireApiRegex = new(@"(?m)^\s*wire_api\s*=\s*""([^""]*)""", RegexOptions.Compiled);
    private static readonly Regex BearerRegex = new(@"(?m)^\s*experimental_bearer_token\s*=\s*""([^""]*)""", RegexOptions.Compiled);
    private static readonly Regex EnvKeyRegex = new(@"(?m)^\s*env_key\s*=\s*""([^""]*)""", RegexOptions.Compiled);

    public static ProviderState Read()
    {
        var text = ReadConfigText();
        var providerId = Match(ProviderRegex, text) ?? "deepseek";
        var section = SectionText(text, $"[model_providers.{providerId}]");

        var hasKey = false;
        var envKey = Match(EnvKeyRegex, section);
        if (!string.IsNullOrWhiteSpace(envKey)
            && !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(envKey)))
        {
            hasKey = true;
        }
        if (!string.IsNullOrWhiteSpace(Match(BearerRegex, section))) hasKey = true;
        if (!hasKey && File.Exists(AuthPath))
        {
            try
            {
                var auth = JsonNode.Parse(File.ReadAllText(AuthPath)) as JsonObject;
                hasKey = !string.IsNullOrWhiteSpace(auth?["OPENAI_API_KEY"]?.GetValue<string>());
            }
            catch
            {
                // 认证文件损坏就当没有密钥。
            }
        }

        var baseUrl = Match(BaseUrlRegex, section) ?? "";
        return new ProviderState
        {
            Configured = !string.IsNullOrWhiteSpace(baseUrl),
            ProviderId = providerId,
            BaseUrl = baseUrl,
            Model = Match(ModelRegex, text) ?? "",
            WireApi = Match(WireApiRegex, section) ?? "responses",
            HasApiKey = hasKey,
            ConfigPath = ConfigPath,
        };
    }

    /// <summary>
    /// 写入服务商配置。密钥始终留在本机（config.toml 的 experimental_bearer_token 与 auth.json），
    /// 不会以任何形式回传或写进程序目录之外。
    /// </summary>
    public static ProviderState Save(string providerId, string baseUrl, string model, string apiKey, string? workDir)
    {
        providerId = NormalizeId(providerId);
        baseUrl = (baseUrl ?? "").Trim();
        model = (model ?? "").Trim();
        apiKey = (apiKey ?? "").Trim();

        Directory.CreateDirectory(HomeDir);
        var lines = ReadConfigText().Replace("\r\n", "\n").Split('\n').ToList();
        if (lines.Count == 1 && lines[0].Length == 0) lines.Clear();

        UpsertTopLevel(lines, "model", model);
        UpsertTopLevel(lines, "model_provider", providerId);
        UpsertTopLevel(lines, "preferred_auth_method", "apikey");
        UpsertTopLevel(lines, "forced_login_method", "api");
        if (!Regex.IsMatch(string.Join('\n', lines), @"(?m)^\s*web_search\s*="))
        {
            lines.Add("web_search = \"disabled\"");
        }

        var sectionName = $"[model_providers.{providerId}]";
        UpsertInSection(lines, sectionName, "name", providerId);
        UpsertInSection(lines, sectionName, "base_url", baseUrl);
        // 本机 CLI 只支持 Responses 协议（chat 已被移除）。
        UpsertInSection(lines, sectionName, "wire_api", "responses");
        if (apiKey.Length > 0) UpsertInSection(lines, sectionName, "experimental_bearer_token", apiKey);

        if (!string.IsNullOrWhiteSpace(workDir) && Directory.Exists(workDir))
        {
            EnsureProjectTrust(lines, workDir!);
        }

        File.WriteAllText(ConfigPath, string.Join('\n', lines).TrimEnd('\n') + "\n", new UTF8Encoding(false));

        if (apiKey.Length > 0)
        {
            var auth = new JsonObject
            {
                ["auth_mode"] = "apikey",
                ["OPENAI_API_KEY"] = apiKey,
            };
            File.WriteAllText(AuthPath,
                auth.ToJsonString(new JsonSerializerOptions { WriteIndented = true }),
                new UTF8Encoding(false));
        }

        return Read();
    }

    /// <summary>把工作目录标记为受信任，避免非交互模式下每次都要确认。</summary>
    public static void EnsureTrusted(string? workDir)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(workDir) || !Directory.Exists(workDir)) return;
            var lines = ReadConfigText().Replace("\r\n", "\n").Split('\n').ToList();
            if (lines.Count == 1 && lines[0].Length == 0) lines.Clear();

            var before = lines.Count;
            EnsureProjectTrust(lines, workDir!);
            if (lines.Count == before) return;

            Directory.CreateDirectory(HomeDir);
            File.WriteAllText(ConfigPath, string.Join('\n', lines).TrimEnd('\n') + "\n", new UTF8Encoding(false));
        }
        catch
        {
            // 信任标记是可选项，失败不影响使用。
        }
    }

    private static void EnsureProjectTrust(List<string> lines, string workDir)
    {
        var key = workDir.Trim().TrimEnd('\\', '/').ToLowerInvariant();
        var header = "[projects." + TomlKey(key) + "]";
        if (lines.Any(l => l.Trim().Equals(header, StringComparison.OrdinalIgnoreCase))) return;

        if (lines.Count > 0 && lines[^1].Trim().Length != 0) lines.Add("");
        lines.Add(header);
        lines.Add("trust_level = \"trusted\"");
    }

    private static string TomlKey(string path)
    {
        // 路径里没有单引号时用字面量字符串（Windows 路径必然含反斜杠）
        if (!path.Contains('\'')) return "'" + path + "'";
        return "\"" + path.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    private static string NormalizeId(string providerId)
    {
        var id = (providerId ?? "").Trim().ToLowerInvariant();
        if (id.Length == 0) return "deepseek";
        var chars = id.Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '-').ToArray();
        return new string(chars);
    }

    private static string ReadConfigText()
    {
        try
        {
            return File.Exists(ConfigPath) ? File.ReadAllText(ConfigPath) : "";
        }
        catch
        {
            return "";
        }
    }

    private static string? Match(Regex regex, string text)
    {
        var match = regex.Match(text);
        return match.Success ? match.Groups[1].Value : null;
    }

    /// <summary>取某个 [section] 到下一个 [ 之间的文本。</summary>
    private static string SectionText(string text, string sectionHeader)
    {
        var start = text.IndexOf(sectionHeader, StringComparison.OrdinalIgnoreCase);
        if (start < 0) return "";
        var rest = text[(start + sectionHeader.Length)..];
        var end = rest.IndexOf("\n[", StringComparison.Ordinal);
        return end < 0 ? rest : rest[..end];
    }

    private static bool IsSectionHeader(string line)
    {
        var trimmed = line.Trim();
        return trimmed.StartsWith('[') && trimmed.EndsWith(']');
    }

    private static void UpsertTopLevel(List<string> lines, string key, string value)
    {
        var pattern = new Regex(@"^\s*" + Regex.Escape(key) + @"\s*=", RegexOptions.IgnoreCase);
        var rendered = key + " = \"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";

        for (var i = 0; i < lines.Count; i++)
        {
            if (IsSectionHeader(lines[i])) break;
            if (!pattern.IsMatch(lines[i])) continue;
            lines[i] = rendered;
            return;
        }

        // 插到第一个 section 之前；全是 section 就插到最前面
        var index = lines.FindIndex(IsSectionHeader);
        if (index < 0) lines.Add(rendered);
        else lines.Insert(index, rendered);
    }

    private static void UpsertInSection(List<string> lines, string sectionHeader, string key, string value)
    {
        var start = lines.FindIndex(l => l.Trim().Equals(sectionHeader, StringComparison.OrdinalIgnoreCase));
        var rendered = key + " = \"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";

        if (start < 0)
        {
            if (lines.Count > 0 && lines[^1].Trim().Length != 0) lines.Add("");
            lines.Add(sectionHeader);
            lines.Add(rendered);
            return;
        }

        var end = lines.Count;
        for (var i = start + 1; i < lines.Count; i++)
        {
            if (!IsSectionHeader(lines[i])) continue;
            end = i;
            break;
        }

        var pattern = new Regex(@"^\s*" + Regex.Escape(key) + @"\s*=", RegexOptions.IgnoreCase);
        for (var i = start + 1; i < end; i++)
        {
            if (!pattern.IsMatch(lines[i])) continue;
            lines[i] = rendered;
            return;
        }

        lines.Insert(end, rendered);
    }
}
