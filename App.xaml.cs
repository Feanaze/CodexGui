using System.Threading;
using System.Windows;
using CodexGui.Services;

namespace CodexGui;

public partial class App : Application
{
    private Mutex? _singleInstance;

    protected override void OnStartup(StartupEventArgs e)
    {
        try
        {
            StoragePaths.Initialize();
            CodexEnvironment.EnsureHome();
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "无法初始化数据目录 D:\\Codex\\CodexGuiData。\n\n" + ex.Message,
                "Codex GUI", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
            return;
        }

        // 命令行自检：CodexGui.exe --selftest "提示词" [工作目录]
        if (e.Args.Length > 0 && string.Equals(e.Args[0], "--selftest", StringComparison.OrdinalIgnoreCase))
        {
            Shutdown(SelfTest.Run(
                e.Args.Length > 1 ? e.Args[1] : "只回复：pong",
                e.Args.Length > 2 ? e.Args[2] : AppConfig.DefaultWorkDir) ? 0 : 1);
            return;
        }

        // --autorun "提示词"：启动后自动发一条消息，用于自动化验证界面链路
        if (e.Args.Length > 1 && string.Equals(e.Args[0], "--autorun", StringComparison.OrdinalIgnoreCase))
        {
            CodexGui.MainWindow.StartupPrompt = e.Args[1];
        }

        _singleInstance = new Mutex(true, @"Local\CodexGui.SingleInstance", out var isNew);
        if (!isNew)
        {
            MessageBox.Show("Codex GUI 已经在运行了，请在任务栏中切换过去。", "Codex GUI",
                MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown();
            return;
        }

        base.OnStartup(e);
        DispatcherUnhandledException += (_, args) =>
        {
            Services.Log.Write("未处理异常：" + args.Exception);
            MessageBox.Show("出现了未处理的错误：\n\n" + args.Exception.Message,
                "Codex GUI", MessageBoxButton.OK, MessageBoxImage.Error);
            args.Handled = true;
        };
        var window = new MainWindow();
        window.Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        try { _singleInstance?.ReleaseMutex(); } catch { /* ignored */ }
        _singleInstance?.Dispose();
        base.OnExit(e);
    }
}
