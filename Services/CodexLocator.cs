using System.IO;

namespace CodexGui.Services;

/// <summary>找到 codex 可执行文件（原生 exe 优先，其次 npm 的 .cmd 包装）。</summary>
public sealed class CodexLaunch
{
    public required string FileName { get; init; }
    public required string Display { get; init; }
    public bool ThroughCmd { get; init; }
}

public static class CodexLocator
{
    private static readonly string[] ShimDirs =
    {
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "npm"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "npm"),
    };

    public static CodexLaunch? Resolve(string? configured)
    {
        if (!string.IsNullOrWhiteSpace(configured))
        {
            var path = configured.Trim().Trim('"');
            if (File.Exists(path))
            {
                var native = TryNativeFromShim(path);
                if (native is not null) return native;
                return FromPath(path);
            }
        }

        foreach (var candidate in EnumerateBundledCandidates())
        {
            if (!File.Exists(candidate)) continue;
            var native = TryNativeFromShim(candidate);
            if (native is not null && File.Exists(native.FileName)) return native;
            return FromPath(candidate);
        }

        foreach (var candidate in EnumeratePathCandidates())
        {
            if (File.Exists(candidate))
            {
                var native = TryNativeFromShim(candidate);
                if (native is not null && File.Exists(native.FileName)) return native;
                return FromPath(candidate);
            }
        }

        foreach (var dir in ShimDirs)
        {
            foreach (var name in new[] { "codex.exe", "codex.cmd", "codex.bat" })
            {
                var candidate = Path.Combine(dir, name);
                if (!File.Exists(candidate)) continue;
                var native = TryNativeFromShim(candidate);
                if (native is not null && File.Exists(native.FileName)) return native;
                return FromPath(candidate);
            }
        }

        return null;
    }

    /// <summary>
    /// 随程序一起分发的 codex（便携包/安装包会把它放在 &lt;程序目录&gt;\codex 下），
    /// 优先使用它，这样即使用户没有装 Node/npm、PATH 里也没有 codex 也能直接用。
    /// 布局与 npm 包一致：codex\bin\codex.exe 与 codex\codex-path、codex\codex-resources 同级。
    /// </summary>
    private static IEnumerable<string> EnumerateBundledCandidates()
    {
        var baseDir = AppContext.BaseDirectory;
        yield return Path.Combine(baseDir, "codex", "bin", "codex.exe");
        yield return Path.Combine(baseDir, "codex", "codex.exe");

        // 允许 app\ 子目录布局：<程序目录>\app\CodexGui.exe + <程序目录>\codex\...
        var parent = Path.GetDirectoryName(Path.TrimEndingDirectorySeparator(baseDir));
        if (!string.IsNullOrEmpty(parent))
        {
            yield return Path.Combine(parent, "codex", "bin", "codex.exe");
            yield return Path.Combine(parent, "codex", "codex.exe");
        }
    }

    private static IEnumerable<string> EnumeratePathCandidates()
    {
        var pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var raw in pathVar.Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            var dir = raw.Trim().Trim('"');
            if (dir.Length == 0) continue;
            yield return Path.Combine(dir, "codex.exe");
        }

        foreach (var raw in pathVar.Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            var dir = raw.Trim().Trim('"');
            if (dir.Length == 0) continue;
            yield return Path.Combine(dir, "codex.cmd");
            yield return Path.Combine(dir, "codex.bat");
        }
    }

    private static CodexLaunch FromPath(string path)
    {
        var ext = Path.GetExtension(path).ToLowerInvariant();
        var throughCmd = ext is ".cmd" or ".bat";
        return new CodexLaunch
        {
            FileName = throughCmd ? Path.Combine(Environment.SystemDirectory, "cmd.exe") : path,
            Display = path,
            ThroughCmd = throughCmd,
        };
    }

    /// <summary>
    /// npm 的 codex.cmd 会再去调用 @openai/codex 的原生可执行文件。
    /// 能直接找到原生 exe 就跳过 cmd 包装，启动更快也不需要额外进程。
    /// </summary>
    private static CodexLaunch? TryNativeFromShim(string shimPath)
    {
        try
        {
            var dir = Path.GetDirectoryName(shimPath);
            if (string.IsNullOrEmpty(dir)) return null;
            var pkgRoot = Path.Combine(dir, "node_modules", "@openai", "codex", "node_modules", "@openai");
            if (!Directory.Exists(pkgRoot)) return null;

            foreach (var platformDir in Directory.EnumerateDirectories(pkgRoot, "codex-win32-*"))
            {
                var vendorRoot = Path.Combine(platformDir, "vendor");
                if (!Directory.Exists(vendorRoot)) continue;
                foreach (var vendor in Directory.EnumerateDirectories(vendorRoot))
                {
                    var exe = Path.Combine(vendor, "bin", "codex.exe");
                    if (File.Exists(exe))
                        return new CodexLaunch { FileName = exe, Display = exe, ThroughCmd = false };
                }
            }
        }
        catch
        {
            // ignored
        }

        return null;
    }

    /// <summary>把 launch 信息转成一批前缀参数（cmd 包装时需要 "cmd /c shim"）。</summary>
    public static void ApplyPrefix(CodexLaunch launch, List<string> args)
    {
        if (!launch.ThroughCmd) return;
        args.Insert(0, "/c");
        args.Insert(1, launch.Display);
    }
}
