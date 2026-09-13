using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CodexGui.Services;

/// <summary>
/// 所有设置都落在 &lt;数据目录&gt;\config.json（见 <see cref="StoragePaths"/>），启动时直接读取，
/// 不需要任何交互式询问（包括工作目录）。
/// </summary>
public sealed class AppConfig
{
    /// <summary>
    /// 未配置工作目录时的默认值：当前用户主目录。
    /// 便携版/安装版可以在首启时把 WorkDir 写成安装目录（见 docs/CONFIGURATION.md）。
    /// </summary>
    public static string DefaultWorkDir => SafeProfileDir();

    private static string SafeProfileDir()
    {
        try
        {
            var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (!string.IsNullOrWhiteSpace(profile) && Directory.Exists(profile)) return profile;
        }
        catch
        {
            // 忽略，继续用兜底目录。
        }

        return AppContext.BaseDirectory;
    }

    public string WorkDir { get; set; } = DefaultWorkDir;
    public string? CodexPath { get; set; }
    public string Model { get; set; } = "";
    public string ReasoningEffort { get; set; } = "";
    public string Sandbox { get; set; } = "workspace-write";
    public string Approval { get; set; } = "never";
    public string Theme { get; set; } = "dark";
    public double FontSize { get; set; } = 15;
    public bool ShowReasoning { get; set; } = true;
    public bool AutoCollapseTools { get; set; } = true;
    public bool SendOnEnter { get; set; } = true;
    public List<string> RecentDirs { get; set; } = new();
    public double WindowWidth { get; set; } = 1360;
    public double WindowHeight { get; set; } = 860;
    public double WindowLeft { get; set; } = double.NaN;
    public double WindowTop { get; set; } = double.NaN;
    public bool WindowMaximized { get; set; }
    public double SidebarWidth { get; set; } = 272;
    public string? LastSessionId { get; set; }

    public static string DataDir => StoragePaths.DataDir;

    public static string SessionsDir => StoragePaths.SessionsDir;

    private static string ConfigPath => StoragePaths.ConfigPath;

    private static readonly JsonSerializerOptions WriteOptions = new()
    {
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        // WindowLeft / WindowTop 未设置时是 NaN，默认序列化会抛异常
        NumberHandling = System.Text.Json.Serialization.JsonNumberHandling.AllowNamedFloatingPointLiterals,
    };

    private static readonly JsonSerializerOptions ReadOptions = new()
    {
        NumberHandling = System.Text.Json.Serialization.JsonNumberHandling.AllowNamedFloatingPointLiterals,
        PropertyNameCaseInsensitive = true,
    };

    public static AppConfig Load()
    {
        try
        {
            Directory.CreateDirectory(DataDir);
            if (File.Exists(ConfigPath))
            {
                var json = File.ReadAllText(ConfigPath);
                var cfg = JsonSerializer.Deserialize<AppConfig>(json, ReadOptions);
                if (cfg is not null)
                {
                    cfg.Normalize();
                    return cfg;
                }
            }
        }
        catch (Exception ex)
        {
            Log.Write("读取配置失败：" + ex.Message);
        }

        var fresh = new AppConfig();
        fresh.Normalize();
        fresh.Save();
        return fresh;
    }

    private void Normalize()
    {
        if (string.IsNullOrWhiteSpace(WorkDir)) WorkDir = DefaultWorkDir;
        WorkDir = WorkDir.Trim().Trim('"');
        if (RecentDirs is null) RecentDirs = new List<string>();
        RecentDirs = RecentDirs.Where(d => !string.IsNullOrWhiteSpace(d)).Distinct(StringComparer.OrdinalIgnoreCase)
                               .Take(10).ToList();
        if (FontSize is < 11 or > 24) FontSize = 15;
        if (SidebarWidth is < 200 or > 520) SidebarWidth = 272;
        if (double.IsNaN(WindowWidth) || WindowWidth < 900) WindowWidth = 1360;
        if (double.IsNaN(WindowHeight) || WindowHeight < 560) WindowHeight = 860;
        if (Sandbox is not ("read-only" or "workspace-write" or "danger-full-access"))
            Sandbox = "workspace-write";
        if (Theme is not ("dark" or "light" or "system")) Theme = "dark";
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(DataDir);
            File.WriteAllText(ConfigPath, JsonSerializer.Serialize(this, WriteOptions));
        }
        catch (Exception ex)
        {
            Log.Write("保存配置失败：" + ex.Message);
        }
    }

    /// <summary>把界面传来的部分字段合并进配置。</summary>
    public void Patch(JsonObject patch)
    {
        foreach (var kv in patch)
        {
            var name = kv.Key;
            var value = kv.Value;
            try
            {
                switch (name)
                {
                    case "workDir": WorkDir = value?.GetValue<string>() ?? WorkDir; break;
                    case "codexPath": CodexPath = string.IsNullOrWhiteSpace(value?.GetValue<string>()) ? null : value!.GetValue<string>(); break;
                    case "model": Model = value?.GetValue<string>() ?? ""; break;
                    case "reasoningEffort": ReasoningEffort = value?.GetValue<string>() ?? ""; break;
                    case "sandbox": Sandbox = value?.GetValue<string>() ?? Sandbox; break;
                    case "theme": Theme = value?.GetValue<string>() ?? Theme; break;
                    case "fontSize": FontSize = value?.GetValue<double>() ?? FontSize; break;
                    case "showReasoning": ShowReasoning = value?.GetValue<bool>() ?? ShowReasoning; break;
                    case "autoCollapseTools": AutoCollapseTools = value?.GetValue<bool>() ?? AutoCollapseTools; break;
                    case "sendOnEnter": SendOnEnter = value?.GetValue<bool>() ?? SendOnEnter; break;
                    case "sidebarWidth": SidebarWidth = value?.GetValue<double>() ?? SidebarWidth; break;
                    case "lastSessionId": LastSessionId = value?.GetValue<string>(); break;
                    case "recentDirs":
                        if (value is JsonArray arr)
                            RecentDirs = arr.Select(x => x?.GetValue<string>() ?? "")
                                            .Where(s => !string.IsNullOrWhiteSpace(s)).Distinct(StringComparer.OrdinalIgnoreCase)
                                            .Take(10).ToList();
                        break;
                }
            }
            catch
            {
                // 单个字段解析失败不影响其它字段。
            }
        }

        Normalize();
    }

    public void PushRecentDir(string dir)
    {
        if (string.IsNullOrWhiteSpace(dir)) return;
        RecentDirs.RemoveAll(d => string.Equals(d, dir, StringComparison.OrdinalIgnoreCase));
        RecentDirs.Insert(0, dir);
        while (RecentDirs.Count > 10) RecentDirs.RemoveAt(RecentDirs.Count - 1);
    }

    public JsonObject ToJson() => new()
    {
        ["workDir"] = WorkDir,
        ["codexPath"] = CodexPath,
        ["model"] = Model,
        ["reasoningEffort"] = ReasoningEffort,
        ["sandbox"] = Sandbox,
        ["theme"] = Theme,
        ["fontSize"] = FontSize,
        ["showReasoning"] = ShowReasoning,
        ["autoCollapseTools"] = AutoCollapseTools,
        ["sendOnEnter"] = SendOnEnter,
        ["sidebarWidth"] = SidebarWidth,
        ["recentDirs"] = new JsonArray(RecentDirs.Select(d => (JsonNode)JsonValue.Create(d)!).ToArray()),
        ["lastSessionId"] = LastSessionId,
        ["dataDir"] = DataDir,
    };
}
