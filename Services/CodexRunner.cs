using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json.Nodes;

namespace CodexGui.Services;

public sealed class TurnOptions
{
    public string? Model { get; init; }
    public string? ReasoningEffort { get; init; }
    public string Sandbox { get; init; } = "workspace-write";
    public List<string> Images { get; init; } = new();
}

/// <summary>
/// 负责一次 codex 调用（`codex exec --json`），把事件流按行回调出去。
/// 一次「发送」= 一个进程；多轮对话靠 codex exec resume &lt;threadId&gt; 续接。
/// </summary>
public sealed class CodexRunner : IDisposable
{
    private readonly CodexLaunch _launch;
    private Process? _proc;
    private readonly object _gate = new();

    public bool IsRunning { get; private set; }
    public int Pid { get; private set; }

    public event Action<JsonNode>? EventReceived;
    public event Action<string>? LogReceived;

    public CodexRunner(CodexLaunch launch) => _launch = launch;

    public string Display => _launch.Display;

    public void StartNew(string workDir, string prompt, TurnOptions options)
    {
        var args = new List<string>
        {
            "exec",
            "--json",
            "--skip-git-repo-check",
            "-C", workDir,
            "-s", options.Sandbox,
        };
        AppendCommon(args, options);
        args.Add("-");
        CodexLocator.ApplyPrefix(_launch, args);
        Start(args, workDir, prompt);
    }

    public void StartResume(string workDir, string threadId, string prompt, TurnOptions options)
    {
        var args = new List<string>
        {
            "exec",
            "resume",
            threadId,
            "--json",
            "--skip-git-repo-check",
            "-c", $"sandbox_mode=\"{options.Sandbox}\"",
        };
        AppendCommon(args, options);
        args.Add("-");
        CodexLocator.ApplyPrefix(_launch, args);
        Start(args, workDir, prompt);
    }

    private static void AppendCommon(List<string> args, TurnOptions options)
    {
        if (!string.IsNullOrWhiteSpace(options.Model))
        {
            args.Add("-m");
            args.Add(options.Model!);
        }

        if (!string.IsNullOrWhiteSpace(options.ReasoningEffort))
        {
            args.Add("-c");
            args.Add($"model_reasoning_effort=\"{options.ReasoningEffort}\"");
        }

        foreach (var image in options.Images)
        {
            if (File.Exists(image))
            {
                args.Add("-i");
                args.Add(image);
            }
        }
    }

    private void Start(List<string> args, string workDir, string prompt)
    {
        lock (_gate)
        {
            if (IsRunning) throw new InvalidOperationException("上一条消息还在处理中。");

            var psi = new ProcessStartInfo
            {
                FileName = _launch.FileName,
                WorkingDirectory = Directory.Exists(workDir) ? workDir : AppConfig.DefaultWorkDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = new UTF8Encoding(false),
                StandardErrorEncoding = new UTF8Encoding(false),
                StandardInputEncoding = new UTF8Encoding(false),
            };

            foreach (var a in args) psi.ArgumentList.Add(a);

            CodexEnvironment.Apply(psi);

            var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            proc.Exited += (_, _) => { };
            _proc = proc;
            proc.Start();
            Pid = proc.Id;
            IsRunning = true;

            try
            {
                proc.StandardInput.Write(prompt);
                if (!prompt.EndsWith("\n", StringComparison.Ordinal)) proc.StandardInput.Write('\n');
                proc.StandardInput.Close();
            }
            catch
            {
                // 写入失败时会紧接着读到进程退出事件。
            }

            var stdout = new Thread(() => PumpStdout(proc)) { IsBackground = true, Name = "codex-stdout" };
            var stderr = new Thread(() => PumpStderr(proc)) { IsBackground = true, Name = "codex-stderr" };
            stdout.Start();
            stderr.Start();
        }
    }

    private void PumpStdout(Process proc)
    {
        try
        {
            string? line;
            while ((line = proc.StandardOutput.ReadLine()) is not null)
            {
                line = line.Trim();
                if (line.Length == 0) continue;
                if (line[0] != '{')
                {
                    LogReceived?.Invoke(line);
                    continue;
                }

                JsonNode? node = null;
                try { node = JsonNode.Parse(line); }
                catch { /* 非 JSON 行忽略 */ }
                if (node is not null) EventReceived?.Invoke(node);
            }
        }
        catch
        {
            // 进程被强制结束时会抛异常，属于正常路径。
        }
    }

    private void PumpStderr(Process proc)
    {
        try
        {
            string? line;
            while ((line = proc.StandardError.ReadLine()) is not null)
            {
                line = line.Trim();
                if (line.Length == 0) continue;
                if (line.Contains("Reading additional input from stdin", StringComparison.OrdinalIgnoreCase)) continue;
                if (line.StartsWith("WARNING: proceeding, even though we could not create PATH aliases",
                        StringComparison.OrdinalIgnoreCase)) continue;
                LogReceived?.Invoke(line);
            }
        }
        catch
        {
            // ignored
        }
    }

    public void Stop()
    {
        Process? proc;
        lock (_gate)
        {
            proc = _proc;
        }

        if (proc is null) return;
        try
        {
            if (!proc.HasExited) proc.Kill(entireProcessTree: true);
        }
        catch
        {
            // ignored
        }
    }

    /// <summary>等待进程收尾并返回退出码（由调用方在后台线程使用）。</summary>
    public int WaitForExit()
    {
        var proc = _proc;
        if (proc is null) return -1;
        try
        {
            proc.WaitForExit();
            return proc.ExitCode;
        }
        catch
        {
            return -1;
        }
        finally
        {
            IsRunning = false;
        }
    }

    public void Dispose()
    {
        Stop();
        try { _proc?.Dispose(); } catch { /* ignored */ }
    }
}
