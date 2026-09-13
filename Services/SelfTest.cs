using System.IO;
using System.Text;

namespace CodexGui.Services;

/// <summary>
/// 不开界面的自检：确认能找到 codex、能把提示词送进去、能收到 JSONL 事件。
/// 用法：CodexGui.exe --selftest "只回复：pong" [工作目录]
/// </summary>
public static class SelfTest
{
    public static bool Run(string prompt, string workDir)
    {
        var config = AppConfig.Load();
        var launch = CodexLocator.Resolve(config.CodexPath);
        if (launch is null)
        {
            Console.WriteLine("[selftest] 没有找到 codex 可执行文件");
            return false;
        }

        Console.WriteLine("[selftest] codex = " + launch.Display + (launch.ThroughCmd ? " (通过 cmd 包装)" : ""));
        Console.WriteLine("[selftest] workDir = " + workDir);

        var options = new TurnOptions
        {
            Model = string.IsNullOrWhiteSpace(config.Model) ? null : config.Model,
            ReasoningEffort = string.IsNullOrWhiteSpace(config.ReasoningEffort) ? null : config.ReasoningEffort,
            Sandbox = config.Sandbox,
        };

        using var runner = new CodexRunner(launch);
        var ok = true;
        runner.EventReceived += node => Console.WriteLine("[event] " + node.ToJsonString());
        runner.LogReceived += line => Console.WriteLine("[log] " + line);

        try
        {
            runner.StartNew(workDir, prompt, options);
        }
        catch (Exception ex)
        {
            Console.Out.Flush();
            Console.WriteLine("[selftest] 启动失败：" + ex.Message);
            return false;
        }

        var code = runner.WaitForExit();
        Console.WriteLine("[selftest] exit code = " + code);
        return code == 0 && ok;
    }
}
