using System.IO;

namespace CodexGui.Services;

/// <summary>
/// 客户端所有可写数据（配置、会话、codex-home、WebView2 用户数据）统一放在同一个数据目录下，
/// 默认落在 %LOCALAPPDATA%\CodexGui，避免污染安装目录和 C 盘用户目录之外的任何位置。
///
/// 目录解析顺序：
///   1. 环境变量 CODEXGUI_DATA_DIR（自定义部署 / 测试用）
///   2. exe 同目录存在 portable.marker → &lt;exe 目录&gt;\data（便携模式，数据跟着程序走）
///   3. 已存在 config.json 的 %LOCALAPPDATA%\CodexGui
///   4. 早期开发版本使用的 D:\Codex\CodexGuiData（存在则沿用，避免老用户数据丢失）
///   5. 默认 %LOCALAPPDATA%\CodexGui
/// </summary>
public static class StoragePaths
{
    private const string PortableMarker = "portable.marker";

    /// <summary>早期开发版本写死的数据目录，仅作为兼容保留。</summary>
    private const string LegacyDefaultRoot = @"D:\Codex\CodexGuiData";

    /// <summary>数据目录，进程启动时解析一次。</summary>
    public static string Root { get; } = ResolveRoot();

    public static string DataDir => Ensure(Root);
    public static string SessionsDir => Ensure(Path.Combine(DataDir, "sessions"));
    public static string WebView2Dir => Ensure(Path.Combine(DataDir, "WebView2"));
    public static string AttachmentsDir => Ensure(Path.Combine(DataDir, "attachments"));
    public static string CodexHomeDir => Ensure(Path.Combine(DataDir, "codex-home"));

    public static string ConfigPath => Path.Combine(DataDir, "config.json");
    public static string LogPath => Path.Combine(DataDir, "log.txt");

    /// <summary>便携模式标记文件路径（放在 exe 同目录即生效）。</summary>
    public static string PortableMarkerPath => Path.Combine(AppContext.BaseDirectory, PortableMarker);

    /// <summary>旧数据搬迁的一次性标记；存在就说明已经搬过了。</summary>
    private static string MigrationMarkerPath => Path.Combine(DataDir, "legacy-migration.done");

    public static void Initialize()
    {
        Directory.CreateDirectory(DataDir);
        Directory.CreateDirectory(SessionsDir);
        Directory.CreateDirectory(WebView2Dir);
        Directory.CreateDirectory(AttachmentsDir);
        Directory.CreateDirectory(CodexHomeDir);
        MigrateLegacyAppDataOnce();
    }

    private static string ResolveRoot()
    {
        var custom = Environment.GetEnvironmentVariable("CODEXGUI_DATA_DIR");
        if (!string.IsNullOrWhiteSpace(custom))
        {
            try
            {
                return Path.GetFullPath(custom.Trim().Trim('"'));
            }
            catch
            {
                // 环境变量不合法时继续走默认逻辑。
            }
        }

        try
        {
            var baseDir = AppContext.BaseDirectory;
            if (File.Exists(Path.Combine(baseDir, PortableMarker)))
                return Path.Combine(baseDir, "data");
        }
        catch
        {
            // 只读目录等异常忽略，继续走默认逻辑。
        }

        var localAppData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexGui");
        if (File.Exists(Path.Combine(localAppData, "config.json"))) return localAppData;

        try
        {
            if (Directory.Exists(LegacyDefaultRoot)) return LegacyDefaultRoot;
        }
        catch
        {
            // 忽略。
        }

        return localAppData;
    }

    /// <summary>
    /// 旧数据只搬迁一次。以前每次启动都搬，只要 %APPDATA%\CodexGui 里还留着旧的
    /// 会话文件，用户删掉的对话下一次启动就会被重新搬回来，看起来就像「删不掉」。
    /// 搬完写一个标记文件，之后不再搬。
    /// </summary>
    private static void MigrateLegacyAppDataOnce()
    {
        try
        {
            if (File.Exists(MigrationMarkerPath)) return;
            MigrateLegacyAppData();
            File.WriteAllText(MigrationMarkerPath,
                "legacy migration done at " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
        }
        catch
        {
            // 标记写不进去也不该挡住启动。
        }
    }

    private static string Ensure(string path)
    {
        Directory.CreateDirectory(path);
        return path;
    }

    /// <summary>把旧版本放在 %APPDATA%\CodexGui 的配置与会话复制过来，不删除旧文件。</summary>
    private static void MigrateLegacyAppData()
    {
        var legacyRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "CodexGui");
        if (!Directory.Exists(legacyRoot)) return;

        CopyFileIfMissing(Path.Combine(legacyRoot, "config.json"), ConfigPath);
        CopyFileIfMissing(Path.Combine(legacyRoot, "log.txt"), LogPath);
        CopyDirectoryFiles(Path.Combine(legacyRoot, "sessions"), SessionsDir, "*.json");
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
            // 迁移失败不阻塞启动。
        }
    }

    private static void CopyDirectoryFiles(string sourceDir, string destinationDir, string pattern)
    {
        if (!Directory.Exists(sourceDir)) return;
        try
        {
            Directory.CreateDirectory(destinationDir);
            foreach (var source in Directory.EnumerateFiles(sourceDir, pattern))
            {
                var destination = Path.Combine(destinationDir, Path.GetFileName(source));
                CopyFileIfMissing(source, destination);
            }
        }
        catch
        {
            // 迁移失败不阻塞启动。
        }
    }
}
