using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Threading;
using CodexGui.Services;
using Microsoft.Web.WebView2.Core;

namespace CodexGui;

public partial class MainWindow : Window
{
    private const string VirtualHost = "codexgui.local";
    private static readonly Uri AppUri = new($"https://{VirtualHost}/index.html");

    private readonly AppConfig _config;
    private readonly SessionStore _store = new();

    private JsonObject? _active;
    private string? _activeId;

    /// <summary>
    /// 每个会话各自可以同时运行一轮 codex，按会话 id 索引，互不干扰；
    /// 同一个会话同一时刻只允许一轮，避免同一个 thread 被并发续接。
    /// </summary>
    private readonly Dictionary<string, Turn> _turns = new(StringComparer.Ordinal);

    private sealed class Turn
    {
        public string SessionId = "";
        public string WorkDir = "";
        public CodexRunner? Runner;
        public readonly Dictionary<string, JsonObject> Items = new(StringComparer.Ordinal);
        public readonly List<string> Order = new();
        public readonly List<string> Logs = new();
        public JsonObject? Usage;
        public string? Error;
        public bool Stopped;
        public bool Running;
        public DateTime Started;
    }

    private List<JsonObject> _models = new();
    private string? _configDefaultModel;
    private string? _configDefaultEffort;
    private string? _codexVersion;
    private bool _ready;

    /// <summary>WebView2 是否支持把 CSS app-region: drag 当成窗口标题栏（Win10/11 上的新版运行时都支持）。</summary>
    private bool _nativeChrome;

    /// <summary>普通状态下最近一次的位置与大小（最大化时用它回写 config）。</summary>
    private Rect _normalBounds = Rect.Empty;
    private DispatcherTimer? _boundsTimer;

    /// <summary>--autorun 传入的提示词，页面就绪后自动发送一次（仅用于自动化测试）。</summary>
    public static string? StartupPrompt;

    public MainWindow()
    {
        _config = AppConfig.Load();
        InitializeComponent();
        _boundsTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(700) };
        _boundsTimer.Tick += (_, _) =>
        {
            _boundsTimer.Stop();
            SaveWindowBounds();
        };
        LocationChanged += (_, _) => RememberNormalBounds();
        SizeChanged += (_, _) => RememberNormalBounds();
        RestoreWindowBounds();
        LoadModels();
        Loaded += async (_, _) => await InitWebAsync();
        Closing += OnClosing;
        StateChanged += (_, _) => PostWindowState();
    }

    // ---------------------------------------------------------------- 窗口

    private void RestoreWindowBounds()
    {
        Width = Math.Max(MinWidth, _config.WindowWidth);
        Height = Math.Max(MinHeight, _config.WindowHeight);
        if (!double.IsNaN(_config.WindowLeft) && !double.IsNaN(_config.WindowTop))
        {
            var virtualScreen = new Rect(
                SystemParameters.VirtualScreenLeft, SystemParameters.VirtualScreenTop,
                SystemParameters.VirtualScreenWidth, SystemParameters.VirtualScreenHeight);
            var target = new Rect(_config.WindowLeft, _config.WindowTop, Width, Height);
            if (virtualScreen.IntersectsWith(target))
            {
                WindowStartupLocation = WindowStartupLocation.Manual;
                Left = _config.WindowLeft;
                Top = _config.WindowTop;
            }
        }

        if (_config.WindowMaximized) WindowState = WindowState.Maximized;
    }

    private void RememberNormalBounds()
    {
        if (_boundsTimer is null || WindowState != WindowState.Normal) return;
        if (double.IsNaN(Left) || double.IsNaN(Top)) return;
        _normalBounds = new Rect(Left, Top, Width, Height);
        _boundsTimer.Stop();
        _boundsTimer.Start();
    }

    private void SaveWindowBounds()
    {
        try
        {
            var bounds = WindowState == WindowState.Normal
                ? new Rect(Left, Top, Width, Height)
                : (_normalBounds.IsEmpty ? RestoreBounds : _normalBounds);

            if (!bounds.IsEmpty)
            {
                if (bounds.Width >= MinWidth && bounds.Height >= MinHeight)
                {
                    _config.WindowWidth = bounds.Width;
                    _config.WindowHeight = bounds.Height;
                }

                if (!double.IsNaN(bounds.Left) && !double.IsNaN(bounds.Top))
                {
                    _config.WindowLeft = bounds.Left;
                    _config.WindowTop = bounds.Top;
                }
            }

            _config.WindowMaximized = WindowState == WindowState.Maximized;
            _config.Save();
        }
        catch
        {
            // 配置写入失败不应该影响窗口操作
        }
    }

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        var handle = new WindowInteropHelper(this).Handle;
        HwndSource.FromHwnd(handle)?.AddHook(WndProc);
    }

    /// <summary>无边框窗口最大化时不要遮住任务栏。</summary>
    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == 0x0024) // WM_GETMINMAXINFO
        {
            WmGetMinMaxInfo(hwnd, lParam);
            handled = true;
        }

        return IntPtr.Zero;
    }

    private static void WmGetMinMaxInfo(IntPtr hwnd, IntPtr lParam)
    {
        var mmi = Marshal.PtrToStructure<MINMAXINFO>(lParam);
        const int MONITOR_DEFAULTTONEAREST = 0x00000002;
        var monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if (monitor != IntPtr.Zero)
        {
            var info = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
            if (GetMonitorInfo(monitor, ref info))
            {
                var work = info.rcWork;
                var full = info.rcMonitor;
                mmi.ptMaxPosition.x = work.left - full.left;
                mmi.ptMaxPosition.y = work.top - full.top;
                mmi.ptMaxSize.x = work.right - work.left;
                mmi.ptMaxSize.y = work.bottom - work.top;
                mmi.ptMinTrackSize.x = 920;
                mmi.ptMinTrackSize.y = 560;
            }
        }

        Marshal.StructureToPtr(mmi, lParam, true);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MINMAXINFO
    {
        public POINT ptReserved;
        public POINT ptMaxSize;
        public POINT ptMaxPosition;
        public POINT ptMinTrackSize;
        public POINT ptMaxTrackSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int left;
        public int top;
        public int right;
        public int bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public int dwFlags;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, int flags);

    [DllImport("user32.dll")]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO info);

    private const int WM_NCLBUTTONDOWN = 0x00A1;
    private const int HTCAPTION = 2;
    private const int HTLEFT = 10;
    private const int HTRIGHT = 11;
    private const int HTTOP = 12;
    private const int HTTOPLEFT = 13;
    private const int HTTOPRIGHT = 14;
    private const int HTBOTTOM = 15;
    private const int HTBOTTOMLEFT = 16;
    private const int HTBOTTOMRIGHT = 17;

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    // ------------------------------------------------------------ WebView2

    private async Task InitWebAsync()
    {
        var userData = StoragePaths.WebView2Dir;
        try
        {
            Directory.CreateDirectory(userData);
            var env = await CoreWebView2Environment.CreateAsync(null, userData, null);
            Web.DefaultBackgroundColor = IsDarkTheme() ? System.Drawing.Color.FromArgb(0x1c, 0x1c, 0x1c)
                                                        : System.Drawing.Color.FromArgb(0xff, 0xff, 0xff);
            await Web.EnsureCoreWebView2Async(env);

            var core = Web.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = true;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsSwipeNavigationEnabled = false;
            // 让页面里的 app-region: drag 区域变成真正的标题栏：拖动、双击最大化、
            // 右键系统菜单都由系统处理，比在 JS 里自己拖动稳得多。
            try
            {
                core.Settings.IsNonClientRegionSupportEnabled = true;
                _nativeChrome = true;
            }
            catch
            {
                _nativeChrome = false;
            }

            core.WebMessageReceived += OnWebMessage;
            core.NewWindowRequested += (_, e) => { e.Handled = true; OpenExternal(e.Uri); };
            core.WebResourceRequested += OnWebResourceRequested;
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            await core.AddScriptToExecuteOnDocumentCreatedAsync(
                "window.__CODEX_BOOT__ = " + BuildBoot().ToJsonString() + ";");
            core.Navigate(AppUri.ToString());
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "WebView2 运行时初始化失败，Codex GUI 无法显示界面。\n\n" +
                "请安装 Microsoft Edge WebView2 Runtime 后重试。\n\n" + ex.Message,
                "Codex GUI", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private static bool IsDarkTheme()
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            var value = key?.GetValue("AppsUseLightTheme");
            return value is int i && i == 0;
        }
        catch
        {
            return true;
        }
    }

    private void OnWebResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        try
        {
            var uri = new Uri(e.Request.Uri);
            if (!string.Equals(uri.Host, VirtualHost, StringComparison.OrdinalIgnoreCase)) return;

            var path = uri.AbsolutePath;
            var bytes = WebAssets.Read(path);
            var environment = Web.CoreWebView2.Environment;
            if (bytes is null)
            {
                e.Response = environment.CreateWebResourceResponse(
                    Stream.Null, 404, "Not Found", "Content-Type: text/plain; charset=utf-8");
                return;
            }

            var headers = "Content-Type: " + WebAssets.ContentTypeFor(path) + "\r\nCache-Control: no-store";
            e.Response = environment.CreateWebResourceResponse(new MemoryStream(bytes), 200, "OK", headers);
        }
        catch
        {
            // 交给 WebView2 默认处理
        }
    }

    private JsonObject BuildBoot() => new()
    {
        ["config"] = _config.ToJson(),
        ["models"] = new JsonArray(_models.Select(m => (JsonNode)m.DeepClone()).ToArray()),
        ["defaultModel"] = _configDefaultModel,
        ["defaultEffort"] = _configDefaultEffort,
        ["version"] = _codexVersion,
        ["dark"] = IsDarkTheme(),
        ["nativeDrag"] = _nativeChrome,
    };

    // ------------------------------------------------------------ 消息桥

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        JsonObject? msg;
        try
        {
            var node = JsonNode.Parse(e.WebMessageAsJson);
            // JS 端如果传的是字符串（JSON.stringify），这里再解析一次
            msg = node as JsonObject
                ?? (node is JsonValue value && value.TryGetValue<string>(out var text)
                        ? JsonNode.Parse(text) as JsonObject
                        : null);
        }
        catch { return; }
        if (msg is null) return;

        var type = msg["t"]?.GetValue<string>() ?? "";
        try
        {
            switch (type)
            {
                case "init": HandleInit(); break;
                case "send": HandleSend(msg); break;
                case "stop": StopTurn(msg["sessionId"]?.GetValue<string>()); break;
                case "turn.snapshot": HandleTurnSnapshot(msg); break;
                case "session.new": HandleNewSession(msg); break;
                case "session.load": HandleLoadSession(msg); break;
                case "session.delete": HandleDeleteSession(msg); break;
                case "session.rename": HandleRenameSession(msg); break;
                case "session.draft": HandleDraft(msg); break;
                case "config.patch": HandleConfigPatch(msg); break;
                case "dialog.workdir": HandlePickWorkDir(msg); break;
                case "codex.refresh": HandleCodexRefresh(); break;
                case "shell.open": OpenPath(msg["path"]?.GetValue<string>()); break;
                case "link.open": OpenExternal(msg["url"]?.GetValue<string>()); break;
                case "clipboard.write": WriteClipboard(msg["text"]?.GetValue<string>()); break;
                case "image.read": HandleImageRead(msg); break;
                case "window": HandleWindow(msg); break;
            }
        }
        catch (Exception ex)
        {
            Toast("error", "操作失败：" + ex.Message);
        }
    }

    private void PostJson(JsonNode node)
    {
        if (!_ready) return;
        try { Web.CoreWebView2?.PostWebMessageAsJson(node.ToJsonString()); }
        catch { /* 窗口正在关闭 */ }
    }

    private void Post(JsonObject payload) => PostJson(payload);

    private void Toast(string level, string text) => Post(new JsonObject
    {
        ["t"] = "toast",
        ["level"] = level,
        ["text"] = text,
    });

    // ------------------------------------------------------------ 会话处理

    private void HandleInit()
    {
        _ready = true;
        var state = new JsonObject
        {
            ["t"] = "state",
            ["config"] = _config.ToJson(),
            ["sessions"] = new JsonArray(_store.List().Select(s => (JsonNode)s).ToArray()),
            ["codex"] = BuildCodexInfo(),
            ["models"] = new JsonArray(_models.Select(m => (JsonNode)m.DeepClone()).ToArray()),
            ["defaultModel"] = _configDefaultModel,
            ["defaultEffort"] = _configDefaultEffort,
            ["runningSessions"] = RunningSessionIds(),
        };
        Post(state);

        var requested = _activeId ?? _config.LastSessionId;
        var session = requested is null ? null : _store.Load(requested);
        if (session is not null)
        {
            _active = session;
            _activeId = session["id"]?.GetValue<string>();
            Post(new JsonObject { ["t"] = "session", ["session"] = session.DeepClone() });
        }

        // 页面重新加载时，把正在跑的对话状态补回去（含已产出的内容）。
        foreach (var turn in _turns.Values.ToArray())
        {
            if (turn.SessionId == _activeId) PostTurnSnapshot(turn);
        }

        var prompt = StartupPrompt;
        if (!string.IsNullOrWhiteSpace(prompt))
        {
            StartupPrompt = null;
            var literal = JsonSerializer.Serialize(prompt);
            Dispatcher.BeginInvoke(async () =>
            {
                try
                {
                    await Web.CoreWebView2.ExecuteScriptAsync(
                        "window.__autorun && window.__autorun(" + literal + ")");
                }
                catch (Exception ex)
                {
                    Log.Write("autorun 失败：" + ex.Message);
                }
            });
        }
    }

    private JsonObject? EnsureSession(string? sessionId, bool createIfMissing = true)
    {
        if (!string.IsNullOrEmpty(sessionId))
        {
            var loaded = SessionFor(sessionId!);
            if (loaded is not null)
            {
                _active = loaded;
                _activeId = sessionId;
                return loaded;
            }
        }

        if (!createIfMissing) return null;

        var session = _store.Create(_config.WorkDir, _config.Model, _config.Sandbox);
        _active = session;
        _activeId = session["id"]?.GetValue<string>();
        return session;
    }

    /// <summary>
    /// 从磁盘读取会话；如果它正是当前显示的会话，就让 _active 指向这份最新对象，
    /// 避免并发轮次写盘后内存里还留着旧副本。
    /// </summary>
    private JsonObject? SessionFor(string id)
    {
        var session = _store.Load(id);
        if (session is null) return null;
        if (_activeId == id) _active = session;
        return session;
    }

    private bool IsRunning(string? sessionId) =>
        !string.IsNullOrEmpty(sessionId) && _turns.ContainsKey(sessionId!);

    private JsonArray RunningSessionIds() =>
        new(_turns.Keys.Select(id => (JsonNode)JsonValue.Create(id)!).ToArray());

    private void PostRunningTurns() => Post(new JsonObject
    {
        ["t"] = "turns",
        ["sessions"] = RunningSessionIds(),
    });

    private void HandleNewSession(JsonObject msg)
    {
        // 页面点「新建对话」：先解除当前会话绑定，会话本身等到第一次发送再落盘，
        // 这样在草稿状态下切工作目录只会改默认目录，不会动到正在跑的那个对话。
        if (msg["create"]?.GetValue<bool>() == false)
        {
            _active = null;
            _activeId = null;
            return;
        }

        var workDir = msg["workDir"]?.GetValue<string>();
        if (!string.IsNullOrWhiteSpace(workDir) && Directory.Exists(workDir))
        {
            _config.WorkDir = workDir!.Trim().Trim('"');
            _config.PushRecentDir(_config.WorkDir);
            _config.Save();
            Post(new JsonObject { ["t"] = "config", ["config"] = _config.ToJson() });
        }

        var session = _store.Create(_config.WorkDir, _config.Model, _config.Sandbox);
        _active = session;
        _activeId = session["id"]?.GetValue<string>();
        _config.LastSessionId = _activeId;
        _config.Save();
        Post(new JsonObject { ["t"] = "session", ["session"] = session.DeepClone() });
        Post(new JsonObject { ["t"] = "sessions", ["sessions"] = new JsonArray(_store.List().Select(s => (JsonNode)s).ToArray()) });
    }

    private void HandleLoadSession(JsonObject msg)
    {
        var id = msg["id"]?.GetValue<string>();
        if (string.IsNullOrEmpty(id)) return;

        var session = _store.Load(id!);
        if (session is null)
        {
            Toast("error", "这个会话的文件找不到了。");
            return;
        }

        _active = session;
        _activeId = id;
        _config.LastSessionId = id;
        _config.Save();
        Post(new JsonObject { ["t"] = "session", ["session"] = session.DeepClone() });
    }

    private void HandleDeleteSession(JsonObject msg)
    {
        var id = msg["id"]?.GetValue<string>();
        if (string.IsNullOrEmpty(id)) return;
        if (IsRunning(id))
        {
            Toast("warn", "当前任务还在运行，先停止再删除这个对话。");
            return;
        }

        _store.Delete(id!);
        if (_activeId == id)
        {
            _active = null;
            _activeId = null;
            _config.LastSessionId = null;
            _config.Save();
            Post(new JsonObject { ["t"] = "session", ["session"] = null });
        }

        Post(new JsonObject { ["t"] = "sessions", ["sessions"] = new JsonArray(_store.List().Select(s => (JsonNode)s).ToArray()) });
    }

    private void HandleRenameSession(JsonObject msg)
    {
        var id = msg["id"]?.GetValue<string>();
        var title = (msg["title"]?.GetValue<string>() ?? "").Trim();
        if (string.IsNullOrEmpty(id)) return;
        var session = _store.Load(id!);
        if (session is null) return;
        session["title"] = title;
        _store.Save(session);
        if (_activeId == id && _active is not null) _active["title"] = title;
        Post(new JsonObject { ["t"] = "sessions", ["sessions"] = new JsonArray(_store.List().Select(s => (JsonNode)s).ToArray()) });
    }

    private void HandleDraft(JsonObject msg)
    {
        var id = msg["id"]?.GetValue<string>();
        var draft = msg["draft"]?.GetValue<string>() ?? "";
        if (string.IsNullOrEmpty(id)) return;
        var session = _activeId == id ? _active : _store.Load(id!);
        if (session is null) return;
        session["draft"] = draft;
        _store.Save(session, touchTimestamp: false);
    }

    // ------------------------------------------------------------ 配置

    private void HandleConfigPatch(JsonObject msg)
    {
        if (msg["patch"] is not JsonObject patch) return;
        var safePatch = (JsonObject)patch.DeepClone();
        var workDirSelected = false;
        if (safePatch.TryGetPropertyValue("workDir", out var workDirNode))
        {
            var requested = workDirNode?.GetValue<string>()?.Trim().Trim('"') ?? "";
            if (IsRunning(_activeId))
            {
                safePatch.Remove("workDir");
                Toast("warn", "这个对话还在运行，先停止它再切换工作目录。");
            }
            else if (string.IsNullOrWhiteSpace(requested) || !Directory.Exists(requested))
            {
                safePatch.Remove("workDir");
                Toast("error", "工作目录不存在：" + requested);
            }
            else
            {
                workDirSelected = true;
            }
        }

        _config.Patch(safePatch);
        if (workDirSelected)
        {
            _config.PushRecentDir(_config.WorkDir);
            BindWorkDirToSession(_config.WorkDir);
        }
        _config.Save();
        Post(new JsonObject { ["t"] = "config", ["config"] = _config.ToJson() });
    }

    /// <summary>
    /// 工作目录属于会话上下文：空会话直接改；已有内容或已有 threadId 时会新建会话，
    /// 避免用旧 thread 在新目录里续接。
    /// </summary>
    private void BindWorkDirToSession(string workDir)
    {
        if (_active is null || _activeId is null) return;
        var current = _active["workDir"]?.GetValue<string>();
        if (string.Equals(current, workDir, StringComparison.OrdinalIgnoreCase)) return;

        var messages = _active["messages"] as JsonArray;
        var threadId = _active["threadId"]?.GetValue<string>();
        if ((messages?.Count ?? 0) == 0 && string.IsNullOrWhiteSpace(threadId))
        {
            _active["workDir"] = workDir;
            _store.Save(_active, touchTimestamp: false);
            Post(new JsonObject { ["t"] = "session", ["session"] = _active.DeepClone() });
            return;
        }

        var session = _store.Create(workDir, _config.Model, _config.Sandbox);
        _active = session;
        _activeId = session["id"]?.GetValue<string>();
        _config.LastSessionId = _activeId;
        Post(new JsonObject { ["t"] = "session", ["session"] = session.DeepClone() });
        Post(new JsonObject { ["t"] = "sessions", ["sessions"] = new JsonArray(_store.List().Select(s => (JsonNode)s).ToArray()) });
        Toast("info", "已切换工作目录，并为新目录新建了一个对话。");
    }

    private void HandlePickWorkDir(JsonObject msg)
    {
        if (IsRunning(_activeId))
        {
            Toast("warn", "这个对话还在运行，先停止它再切换工作目录。");
            return;
        }

        var start = msg["start"]?.GetValue<string>();
        var current = _active?["workDir"]?.GetValue<string>() ?? _config.WorkDir;
        var initial = !string.IsNullOrWhiteSpace(start) && Directory.Exists(start) ? start! : current;
        using var dialog = new System.Windows.Forms.FolderBrowserDialog
        {
            Description = "选择 Codex 的工作目录",
            UseDescriptionForTitle = true,
            ShowNewFolderButton = true,
            SelectedPath = Directory.Exists(initial) ? initial : AppConfig.DefaultWorkDir,
        };

        if (dialog.ShowDialog() != System.Windows.Forms.DialogResult.OK) return;
        var picked = dialog.SelectedPath;
        _config.WorkDir = picked;
        _config.PushRecentDir(picked);
        BindWorkDirToSession(picked);
        _config.Save();
        Post(new JsonObject { ["t"] = "config", ["config"] = _config.ToJson() });
        Toast("info", "工作目录已切换到 " + picked);
    }

    private JsonObject BuildCodexInfo()
    {
        var launch = CodexLocator.Resolve(_config.CodexPath);
        return new JsonObject
        {
            ["found"] = launch is not null,
            ["path"] = launch?.Display,
            ["version"] = _codexVersion,
            ["admin"] = IsAdministrator(),
            ["workDir"] = _config.WorkDir,
            ["workDirExists"] = Directory.Exists(_config.WorkDir),
        };
    }

    private static bool IsAdministrator()
    {
        try
        {
            using var identity = WindowsIdentity.GetCurrent();
            return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
        }
        catch
        {
            return false;
        }
    }

    private void HandleCodexRefresh()
    {
        _codexVersion = DetectCodexVersion();
        LoadModels();
        Post(new JsonObject
        {
            ["t"] = "codex",
            ["codex"] = BuildCodexInfo(),
            ["models"] = new JsonArray(_models.Select(m => (JsonNode)m.DeepClone()).ToArray()),
            ["defaultModel"] = _configDefaultModel,
            ["defaultEffort"] = _configDefaultEffort,
        });
    }

    private string? DetectCodexVersion()
    {
        try
        {
            var launch = CodexLocator.Resolve(_config.CodexPath);
            if (launch is null) return null;
            var psi = new ProcessStartInfo
            {
                FileName = launch.FileName,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = new UTF8Encoding(false),
            };
            CodexEnvironment.Apply(psi);
            var args = new List<string> { "--version" };
            CodexLocator.ApplyPrefix(launch, args);
            foreach (var a in args) psi.ArgumentList.Add(a);
            using var proc = Process.Start(psi);
            if (proc is null) return null;
            var output = proc.StandardOutput.ReadToEnd().Trim();
            if (!proc.WaitForExit(4000))
            {
                try { proc.Kill(true); } catch { /* ignored */ }
                return null;
            }

            return string.IsNullOrWhiteSpace(output) ? null : output;
        }
        catch
        {
            return null;
        }
    }

    private static string CodexHome()
    {
        return CodexEnvironment.CodexHome
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
    }

    private void LoadModels()
    {
        _models = new List<JsonObject>();
        try
        {
            var home = CodexHome();
            var modelsFile = Path.Combine(home, "models.json");
            if (File.Exists(modelsFile))
            {
                var root = JsonNode.Parse(File.ReadAllText(modelsFile)) as JsonObject;
                if (root?["models"] is JsonArray arr)
                {
                    foreach (var entry in arr)
                    {
                        if (entry is not JsonObject model) continue;
                        var slug = model["slug"]?.GetValue<string>();
                        if (string.IsNullOrWhiteSpace(slug)) continue;
                        var levels = new JsonArray();
                        if (model["supported_reasoning_levels"] is JsonArray list)
                        {
                            foreach (var level in list)
                            {
                                if (level is not JsonObject obj) continue;
                                levels.Add(new JsonObject
                                {
                                    ["effort"] = obj["effort"]?.GetValue<string>(),
                                    ["description"] = obj["description"]?.GetValue<string>(),
                                });
                            }
                        }

                        _models.Add(new JsonObject
                        {
                            ["slug"] = slug,
                            ["displayName"] = model["display_name"]?.GetValue<string>() ?? slug,
                            ["description"] = model["description"]?.GetValue<string>(),
                            ["defaultEffort"] = model["default_reasoning_level"]?.GetValue<string>(),
                            ["levels"] = levels,
                        });
                    }
                }
            }

            var configFile = Path.Combine(home, "config.toml");
            if (File.Exists(configFile))
            {
                var text = File.ReadAllText(configFile);
                var modelMatch = Regex.Match(text, @"(?m)^\s*model\s*=\s*""([^""]+)""");
                if (modelMatch.Success) _configDefaultModel = modelMatch.Groups[1].Value;
                var effortMatch = Regex.Match(text, @"(?m)^\s*model_reasoning_effort\s*=\s*""([^""]+)""");
                if (effortMatch.Success) _configDefaultEffort = effortMatch.Groups[1].Value;
            }

            _codexVersion ??= DetectCodexVersion();
        }
        catch
        {
            // 模型清单只是锦上添花，失败时界面仍可用。
        }
    }

    // ------------------------------------------------------------ 一轮对话

    /// <summary>
    /// 每次发给 codex 的提示词前面都带上这句，让它用中文回答。
    /// 只影响发给 codex 的内容，界面上显示的仍是用户原本输入的那句话。
    /// </summary>
    private const string ChineseReplyInstruction =
        "【语言要求】请全程使用简体中文回答（包括说明、思考和总结）；" +
        "代码块、命令、文件路径、标识符和报错信息保持原文即可。";

    private static string BuildPrompt(string text)
    {
        var body = (text ?? "").Trim();
        return body.Length == 0 ? ChineseReplyInstruction : ChineseReplyInstruction + "\n\n" + body;
    }

    private void HandleSend(JsonObject msg)
    {
        var text = msg["text"]?.GetValue<string>() ?? "";
        var sessionId = msg["sessionId"]?.GetValue<string>();
        var attachments = SaveAttachments(msg["images"] as JsonArray);
        if (string.IsNullOrWhiteSpace(text) && attachments.Count == 0) return;

        var launch = CodexLocator.Resolve(_config.CodexPath);
        if (launch is null)
        {
            Toast("error", "没有找到 codex 命令，请在「设置」里手动指定 codex.exe 的位置。");
            return;
        }

        var existed = !string.IsNullOrEmpty(sessionId) && _store.Load(sessionId!) is not null;
        var session = EnsureSession(sessionId);
        if (session is null) return;
        var sid = session["id"]?.GetValue<string>() ?? _activeId;
        if (string.IsNullOrEmpty(sid)) return;
        if (IsRunning(sid))
        {
            Toast("warn", "这个对话还在运行，等它结束或先点停止，再发下一条。");
            return;
        }

        var workDir = session["workDir"]?.GetValue<string>() ?? _config.WorkDir;
        if (!Directory.Exists(workDir))
        {
            Toast("error", "工作目录不存在：" + workDir + "，请在左上角切换目录。");
            return;
        }

        // 草稿状态下发出的第一条消息：先把「还没有消息的会话」告诉页面。
        // 必须赶在这条用户消息写进 session 之前发，否则页面会先收到一份已经包含
        // 这条消息的完整会话、紧接着又收到 turn.user，同一条消息就会显示两遍
        // （切到别的对话再切回来时才恢复正常，因为那时是重新读的磁盘）。
        if (!existed) Post(new JsonObject { ["t"] = "session", ["session"] = session.DeepClone() });

        var now = DateTimeOffset.Now.ToUnixTimeMilliseconds();
        var userMessage = new JsonObject
        {
            ["role"] = "user",
            ["ts"] = now,
            ["text"] = text,
            ["images"] = new JsonArray(attachments.Select(a => (JsonNode)JsonValue.Create(a)!).ToArray()),
        };
        (session["messages"] as JsonArray)?.Add(userMessage);
        if (string.IsNullOrWhiteSpace(session["title"]?.GetValue<string>()))
        {
            var title = text.Replace("\r", " ").Replace("\n", " ").Trim();
            if (title.Length > 32) title = title[..32];
            session["title"] = string.IsNullOrWhiteSpace(title) ? "图片对话" : title;
        }
        _store.Save(session);
        _config.LastSessionId = sid;
        _config.Save();

        var turn = new Turn
        {
            SessionId = sid!,
            WorkDir = workDir,
            Started = DateTime.Now,
            Running = true,
        };
        _turns[sid!] = turn;

        Post(new JsonObject
        {
            ["t"] = "turn.user",
            ["sessionId"] = sid,
            ["message"] = userMessage.DeepClone(),
            ["title"] = session["title"]?.GetValue<string>(),
        });
        // 发出去的消息要立刻反映到左侧对话列表，不然新对话（以及它的标题）得等
        // 这一轮跑完才会出现。
        Post(new JsonObject { ["t"] = "sessions", ["sessions"] = new JsonArray(_store.List().Select(s => (JsonNode)s).ToArray()) });
        Post(new JsonObject { ["t"] = "turn.status", ["sessionId"] = sid, ["status"] = "running" });
        PostRunningTurns();

        var options = new TurnOptions
        {
            Model = string.IsNullOrWhiteSpace(_config.Model) ? _configDefaultModel : _config.Model,
            ReasoningEffort = string.IsNullOrWhiteSpace(_config.ReasoningEffort) ? null : _config.ReasoningEffort,
            Sandbox = _config.Sandbox,
            Images = attachments,
        };

        var runner = new CodexRunner(launch);
        turn.Runner = runner;
        runner.EventReceived += node => OnCodexEvent(turn, node);
        runner.LogReceived += line => Dispatcher.BeginInvoke(() => HandleCodexLog(turn, line));

        try
        {
            var threadId = session["threadId"]?.GetValue<string>();
            var prompt = BuildPrompt(text);
            if (string.IsNullOrEmpty(threadId)) runner.StartNew(workDir, prompt, options);
            else runner.StartResume(workDir, threadId!, prompt, options);
        }
        catch (Exception ex)
        {
            turn.Running = false;
            _turns.Remove(sid!);
            runner.Dispose();
            Toast("error", "启动 codex 失败：" + ex.Message);
            Post(new JsonObject { ["t"] = "turn.status", ["sessionId"] = sid, ["status"] = "error", ["error"] = ex.Message });
            PostRunningTurns();
            return;
        }

        Task.Run(() =>
        {
            var code = runner.WaitForExit();
            Dispatcher.BeginInvoke(() => FinishTurn(turn, code));
        });
    }

    private void OnCodexEvent(Turn turn, JsonNode node)
    {
        if (node is not JsonObject obj) return;
        Dispatcher.BeginInvoke(() =>
        {
            if (!turn.Running || !_turns.ContainsKey(turn.SessionId)) return;
            var type = obj["type"]?.GetValue<string>() ?? "";
            switch (type)
            {
                case "thread.started":
                    if (obj["thread_id"]?.GetValue<string>() is { Length: > 0 } threadId)
                    {
                        var session = SessionFor(turn.SessionId);
                        if (session is not null)
                        {
                            session["threadId"] = threadId;
                            _store.Save(session, touchTimestamp: false);
                        }
                    }
                    break;
                case "item.started":
                case "item.updated":
                case "item.completed":
                    if (obj["item"] is JsonObject item) UpsertItem(turn, item);
                    break;
                case "turn.completed":
                    turn.Usage = obj["usage"]?.DeepClone() as JsonObject;
                    break;
                case "turn.failed":
                    turn.Error = obj["error"]?["message"]?.GetValue<string>() ?? obj["error"]?.ToJsonString();
                    break;
                case "error":
                    turn.Error ??= obj["message"]?.GetValue<string>();
                    break;
            }

            Post(new JsonObject
            {
                ["t"] = "turn.event",
                ["sessionId"] = turn.SessionId,
                ["event"] = obj.DeepClone(),
            });
        });
    }

    private static void UpsertItem(Turn turn, JsonObject item)
    {
        var id = item["id"]?.GetValue<string>();
        if (string.IsNullOrEmpty(id)) id = Guid.NewGuid().ToString("N");
        if (!turn.Items.ContainsKey(id!)) turn.Order.Add(id!);
        turn.Items[id!] = (JsonObject)item.DeepClone();
    }

    private void HandleCodexLog(Turn turn, string line)
    {
        if (!turn.Running || !_turns.ContainsKey(turn.SessionId)) return;
        turn.Logs.Add(line);
        if (turn.Logs.Count > 40) turn.Logs.RemoveAt(0);
        Post(new JsonObject
        {
            ["t"] = "turn.log",
            ["sessionId"] = turn.SessionId,
            ["text"] = line,
        });
    }

    private void FinishTurn(Turn turn, int exitCode)
    {
        if (!_turns.TryGetValue(turn.SessionId, out var current) || !ReferenceEquals(current, turn)) return;
        _turns.Remove(turn.SessionId);
        var wasRunning = turn.Running;
        turn.Running = false;

        var items = new JsonArray();
        foreach (var id in turn.Order)
        {
            if (turn.Items.TryGetValue(id, out var item)) items.Add(item.DeepClone());
        }

        if (wasRunning && (items.Count > 0 || turn.Error is not null))
        {
            var session = SessionFor(turn.SessionId);
            if (session is not null)
            {
                var message = new JsonObject
                {
                    ["role"] = "assistant",
                    ["ts"] = DateTimeOffset.Now.ToUnixTimeMilliseconds(),
                    ["items"] = items,
                    ["usage"] = turn.Usage?.DeepClone(),
                    ["error"] = turn.Error,
                    ["durationMs"] = (int)(DateTime.Now - turn.Started).TotalMilliseconds,
                    ["exitCode"] = exitCode,
                };
                (session["messages"] as JsonArray)?.Add(message);
                _store.Save(session);
            }
        }

        var status = turn.Stopped
            ? "stopped"
            : turn.Error is not null || (exitCode != 0 && items.Count == 0) ? "error" : "done";
        var errorText = turn.Error;
        if (status == "error" && string.IsNullOrWhiteSpace(errorText))
        {
            errorText = "codex 进程退出码 " + exitCode;
        }

        Post(new JsonObject
        {
            ["t"] = "turn.status",
            ["sessionId"] = turn.SessionId,
            ["status"] = status,
            ["error"] = errorText,
            ["usage"] = turn.Usage?.DeepClone(),
            ["durationMs"] = (int)(DateTime.Now - turn.Started).TotalMilliseconds,
        });
        Post(new JsonObject { ["t"] = "sessions", ["sessions"] = new JsonArray(_store.List().Select(s => (JsonNode)s).ToArray()) });
        PostRunningTurns();

        turn.Runner?.Dispose();
        turn.Runner = null;
        turn.Items.Clear();
        turn.Order.Clear();
        turn.Logs.Clear();
    }

    /// <summary>停止某个会话正在跑的那一轮；sessionId 为空时停止当前显示的会话。</summary>
    private void StopTurn(string? sessionId)
    {
        var id = string.IsNullOrEmpty(sessionId) ? _activeId : sessionId;
        if (string.IsNullOrEmpty(id) || !_turns.TryGetValue(id!, out var turn)) return;
        turn.Stopped = true;
        turn.Runner?.Stop();
        Toast("info", "已请求停止这个对话的任务。");
    }

    /// <summary>页面切回某个正在运行的对话时，按需索取一次当前产出。</summary>
    private void HandleTurnSnapshot(JsonObject msg)
    {
        var id = msg["sessionId"]?.GetValue<string>();
        if (string.IsNullOrEmpty(id) || !_turns.TryGetValue(id!, out var turn)) return;
        PostTurnSnapshot(turn);
    }

    /// <summary>把某轮正在进行的产出补发给页面（页面刷新或切回该对话时用）。</summary>
    private void PostTurnSnapshot(Turn turn)
    {
        Post(new JsonObject
        {
            ["t"] = "turn.status",
            ["sessionId"] = turn.SessionId,
            ["status"] = "running",
        });

        Post(new JsonObject
        {
            ["t"] = "turn.snapshot",
            ["sessionId"] = turn.SessionId,
            ["workDir"] = turn.WorkDir,
            ["items"] = new JsonArray(turn.Order
                .Where(id => turn.Items.ContainsKey(id))
                .Select(id => (JsonNode)turn.Items[id].DeepClone())
                .ToArray()),
            ["usage"] = turn.Usage?.DeepClone(),
            ["logs"] = new JsonArray(turn.Logs.Select(l => (JsonNode)JsonValue.Create(l)!).ToArray()),
        });
    }

    private List<string> SaveAttachments(JsonArray? images)
    {
        var saved = new List<string>();
        if (images is null) return saved;
        var dir = StoragePaths.AttachmentsDir;
        try { Directory.CreateDirectory(dir); }
        catch { return saved; }

        foreach (var node in images)
        {
            if (node is not JsonObject obj) continue;
            var name = obj["name"]?.GetValue<string>() ?? "image.png";
            var dataUrl = obj["data"]?.GetValue<string>() ?? "";
            var marker = dataUrl.IndexOf("base64,", StringComparison.OrdinalIgnoreCase);
            if (marker < 0) continue;
            byte[] bytes;
            try { bytes = Convert.FromBase64String(dataUrl[(marker + 7)..]); }
            catch { continue; }
            if (bytes.Length is 0 or > 16_000_000) continue;

            var ext = Path.GetExtension(name);
            if (string.IsNullOrWhiteSpace(ext)) ext = ".png";
            var file = Path.Combine(dir,
                DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N")[..6] + ext);
            try
            {
                File.WriteAllBytes(file, bytes);
                saved.Add(file);
            }
            catch
            {
                // 写不进临时目录就跳过这张图
            }
        }

        return saved;
    }

    private void HandleImageRead(JsonObject msg)
    {
        var path = msg["path"]?.GetValue<string>();
        var requestId = msg["id"]?.GetValue<string>();
        string? dataUrl = null;
        if (!string.IsNullOrEmpty(path))
        {
            try
            {
                var info = new FileInfo(path!);
                if (info.Exists && info.Length <= 8_000_000)
                {
                    var mime = info.Extension.ToLowerInvariant() switch
                    {
                        ".jpg" or ".jpeg" => "image/jpeg",
                        ".webp" => "image/webp",
                        ".gif" => "image/gif",
                        ".bmp" => "image/bmp",
                        _ => "image/png",
                    };
                    dataUrl = $"data:{mime};base64,{Convert.ToBase64String(File.ReadAllBytes(path!))}";
                }
            }
            catch
            {
                dataUrl = null;
            }
        }

        Post(new JsonObject
        {
            ["t"] = "image.data",
            ["id"] = requestId,
            ["path"] = path,
            ["data"] = dataUrl,
        });
    }

    // ------------------------------------------------------------ 杂项

    private void HandleWindow(JsonObject msg)
    {
        switch (msg["action"]?.GetValue<string>() ?? "")
        {
            case "minimize": WindowState = WindowState.Minimized; break;
            case "maximize":
                WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
                break;
            case "close": Close(); break;
            case "drag": BeginSystemLoop(HTCAPTION); break;
            case "resize": BeginSystemLoop(HitTestFor(msg["edge"]?.GetValue<string>() ?? "")); break;
        }
    }

    private static int HitTestFor(string edge) => edge switch
    {
        "left" => HTLEFT,
        "right" => HTRIGHT,
        "top" => HTTOP,
        "bottom" => HTBOTTOM,
        "topleft" => HTTOPLEFT,
        "topright" => HTTOPRIGHT,
        "bottomleft" => HTBOTTOMLEFT,
        "bottomright" => HTBOTTOMRIGHT,
        _ => 0,
    };

    /// <summary>
    /// 无边框窗口的拖动和缩放。
    /// WebView2 是子窗口并且铺满整个客户区，WPF 既收不到标题栏的双击/拖动，
    /// 也做不了非客户区命中测试（WindowChrome 的缩放边框同样点不到），
    /// 所以由页面发消息，这里先把鼠标捕获拿回来，再让系统跑它自己的移动/缩放
    /// 循环——贴边吸附、双屏 DPI 切换这些都和系统窗口一致。
    /// </summary>
    private void BeginSystemLoop(int hitTest)
    {
        if (hitTest == 0) return;
        if (hitTest != HTCAPTION && WindowState == WindowState.Maximized) return;

        var handle = new WindowInteropHelper(this).Handle;
        if (handle == IntPtr.Zero) return;
        try
        {
            ReleaseCapture();
            SendMessage(handle, WM_NCLBUTTONDOWN, (IntPtr)hitTest, IntPtr.Zero);
        }
        catch
        {
            // 鼠标已经松开时系统会立刻退出循环，无需处理
        }
    }

    private void PostWindowState()
    {
        Post(new JsonObject
        {
            ["t"] = "window",
            ["maximized"] = WindowState == WindowState.Maximized,
        });
    }

    private static void OpenPath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        try
        {
            var target = Directory.Exists(path) ? path : Path.GetDirectoryName(path);
            if (string.IsNullOrEmpty(target)) target = path;
            Process.Start(new ProcessStartInfo
            {
                FileName = "explorer.exe",
                ArgumentList = { target! },
                UseShellExecute = true,
            });
        }
        catch
        {
            // ignored
        }
    }

    private static void OpenExternal(string? url)
    {
        if (string.IsNullOrWhiteSpace(url)) return;
        try
        {
            Process.Start(new ProcessStartInfo { FileName = url!, UseShellExecute = true });
        }
        catch
        {
            // ignored
        }
    }

    private static void WriteClipboard(string? text)
    {
        if (string.IsNullOrEmpty(text)) return;
        try { System.Windows.Clipboard.SetText(text); }
        catch { /* 剪贴板被占用 */ }
    }

    private void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        try
        {
            _boundsTimer?.Stop();
            SaveWindowBounds();
        }
        catch
        {
            // ignored
        }

        foreach (var turn in _turns.Values.ToArray())
        {
            try { turn.Runner?.Stop(); } catch { /* ignored */ }
        }
    }
}
