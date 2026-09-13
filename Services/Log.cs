using System.IO;
using System.Text;

namespace CodexGui.Services;

/// <summary>极简诊断日志：%APPDATA%\CodexGui\log.txt</summary>
public static class Log
{
    private static readonly object Gate = new();

    public static void Write(string message)
    {
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(AppConfig.DataDir);
                var path = StoragePaths.LogPath;
                var text = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + message + Environment.NewLine;
                File.AppendAllText(path, text, Encoding.UTF8);
            }
        }
        catch
        {
            // 日志失败不能影响主流程
        }
    }
}
