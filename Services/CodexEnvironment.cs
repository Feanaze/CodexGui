using System.Diagnostics;
using System.IO;

namespace CodexGui.Services;

/// <summary>
/// codex CLI 在缺少 HOME / CODEX_HOME 时可能直接启动失败，
/// 这里统一补齐它启动所需的家目录环境。
/// </summary>
public static class CodexEnvironment
{
    public static string? HomeDirectory
    {
        get
        {
            var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (!string.IsNullOrWhiteSpace(profile)) return profile;

            var drive = Environment.GetEnvironmentVariable("HOMEDRIVE");
            var path = Environment.GetEnvironmentVariable("HOMEPATH");
            return !string.IsNullOrWhiteSpace(drive) && !string.IsNullOrWhiteSpace(path)
                ? drive + path
                : null;
        }
    }

    public static string? CodexHome
    {
        get
        {
            // 高级用途可显式覆盖；默认始终使用 D 盘数据目录。
            var configured = Environment.GetEnvironmentVariable("CODEXGUI_CODEX_HOME");
            if (!string.IsNullOrWhiteSpace(configured)) return configured!.Trim().Trim('"');
            return StoragePaths.CodexHomeDir;
        }
    }

    public static void Apply(ProcessStartInfo psi)
    {
        var home = HomeDirectory;
        if (!string.IsNullOrWhiteSpace(home)
            && (!psi.Environment.TryGetValue("HOME", out var currentHome) || string.IsNullOrWhiteSpace(currentHome)))
            psi.Environment["HOME"] = home;

        var codexHome = EnsureHome();
        if (string.IsNullOrWhiteSpace(codexHome)) return;

        psi.Environment["CODEX_HOME"] = codexHome;
    }

    /// <summary>
    /// 首次使用时从用户原来的 ~/.codex 复制认证和配置文件，
    /// 避免旧版本数据留在 C 盘，同时让新目录可以直接启动 codex。
    /// </summary>
    public static string EnsureHome()
    {
        var codexHome = CodexHome!;
        Directory.CreateDirectory(codexHome);

        var legacyHome = HomeDirectory is null ? null : Path.Combine(HomeDirectory, ".codex");
        if (string.IsNullOrWhiteSpace(legacyHome) || !Directory.Exists(legacyHome)) return codexHome;
        if (string.Equals(Path.GetFullPath(legacyHome), Path.GetFullPath(codexHome), StringComparison.OrdinalIgnoreCase))
            return codexHome;

        foreach (var file in new[]
                 {
                     "auth.json", "config.toml", "models.json", "installation_id", "version.json",
                     ".sandbox_migration", "cap_sid", "session_index.jsonl", "history.jsonl",
                 })
        {
            CopyFileIfMissing(Path.Combine(legacyHome, file), Path.Combine(codexHome, file));
        }

        foreach (var dir in new[] { "rules", "skills", "backup-deepseek" })
        {
            CopyDirectoryIfMissing(Path.Combine(legacyHome, dir), Path.Combine(codexHome, dir));
        }

        return codexHome;
    }

    private static void CopyFileIfMissing(string source, string destination)
    {
        try
        {
            if (!File.Exists(source) || File.Exists(destination)) return;
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            File.Copy(source, destination, overwrite: false);
        }
        catch
        {
            // 缺少某个可选文件时，codex 仍可能自行创建。
        }
    }

    private static void CopyDirectoryIfMissing(string sourceDir, string destinationDir)
    {
        if (!Directory.Exists(sourceDir)) return;
        try
        {
            foreach (var source in Directory.EnumerateFiles(sourceDir, "*", SearchOption.AllDirectories))
            {
                var relative = Path.GetRelativePath(sourceDir, source);
                CopyFileIfMissing(source, Path.Combine(destinationDir, relative));
            }
        }
        catch
        {
            // 可选目录复制失败不影响启动。
        }
    }
}
