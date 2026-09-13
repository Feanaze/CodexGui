using System.IO;
using System.Reflection;

namespace CodexGui.Services;

/// <summary>把 wwwroot 下的前端文件作为嵌入资源提供，保证最终只有一个 exe。</summary>
public static class WebAssets
{
    private static readonly Dictionary<string, string> ContentTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        [".html"] = "text/html; charset=utf-8",
        [".css"] = "text/css; charset=utf-8",
        [".js"] = "application/javascript; charset=utf-8",
        [".svg"] = "image/svg+xml",
        [".png"] = "image/png",
        [".woff2"] = "font/woff2",
        [".json"] = "application/json; charset=utf-8",
    };

    private static readonly Dictionary<string, string> Map = Build();

    private static Dictionary<string, string> Build()
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var assembly = Assembly.GetExecutingAssembly();
        foreach (var name in assembly.GetManifestResourceNames())
        {
            var marker = name.IndexOf(".wwwroot.", StringComparison.OrdinalIgnoreCase);
            if (marker < 0) continue;
            var suffix = name[(marker + ".wwwroot.".Length)..];
            var lastDot = suffix.LastIndexOf('.');
            if (lastDot <= 0) continue;
            // 资源名里的点都被替换成了下划线式分隔，这里还原最后一段扩展名。
            var relative = suffix[..lastDot].Replace('.', '/') + suffix[lastDot..];
            map[relative] = name;
        }

        return map;
    }

    public static byte[]? Read(string relativePath)
    {
        relativePath = relativePath.TrimStart('/');
        if (relativePath.Length == 0) relativePath = "index.html";
        if (!Map.TryGetValue(relativePath, out var resourceName)) return null;

        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName);
        if (stream is null) return null;
        using var ms = new MemoryStream();
        stream.CopyTo(ms);
        return ms.ToArray();
    }

    public static string ContentTypeFor(string relativePath)
    {
        var ext = Path.GetExtension(relativePath);
        return ContentTypes.TryGetValue(ext, out var type) ? type : "application/octet-stream";
    }

    public static IEnumerable<string> KnownPaths => Map.Keys;
}
