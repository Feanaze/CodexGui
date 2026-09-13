/*
 * Codex GUI 卸载程序
 *
 * 放在 <安装目录>\uninstall.exe，由安装程序注册到「应用和功能」。
 *
 * 命令行：
 *   uninstall.exe                图形界面确认
 *   uninstall.exe /silent        静默卸载（保留 data 目录）
 *   uninstall.exe /silent /purge 静默卸载并删除 data 目录
 *
 * 卸载行为：删除 app/ 与 codex/、删除快捷方式、移除 PATH 条目、删除注册表项。
 * 默认保留 <安装目录>\data（会话记录、配置、codex-home），除非显式要求一起删除。
 */

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN

#include <windows.h>
#include <shlobj.h>
#include <shellapi.h>
#include <commctrl.h>
#include <stdio.h>

#define APP_NAME L"Codex GUI"

static const wchar_t *kWindowClass = L"CodexGuiUninstallWindow";

static HWND g_hwnd;
static HWND g_status;
static HWND g_purge;
static HFONT g_font;
static int g_silent;
static int g_succeeded;

/* ------------------------------------------------------------------ 工具 */

static void JoinPath(wchar_t *out, size_t count, const wchar_t *dir, const wchar_t *name)
{
    wcsncpy_s(out, count, dir, _TRUNCATE);
    size_t len = wcslen(out);
    if (len > 0 && out[len - 1] != L'\\' && out[len - 1] != L'/') wcsncat_s(out, count, L"\\", _TRUNCATE);
    wcsncat_s(out, count, name, _TRUNCATE);
}

/* 取自身所在目录（= 安装目录） */
static void GetInstallDir(wchar_t *out, size_t count)
{
    wchar_t self[MAX_PATH];
    GetModuleFileNameW(NULL, self, MAX_PATH);
    wcsncpy_s(out, count, self, _TRUNCATE);
    wchar_t *slash = wcsrchr(out, L'\\');
    if (slash) *slash = 0;
}

/*
 * 递归删除目录内容。
 * skipName 不为空时跳过该名字的顶层条目（用来保留 data 目录）。
 */
static void DeleteDirectoryContents(const wchar_t *dir, const wchar_t *selfPath,
                                    const wchar_t *skipName, int topLevel)
{
    wchar_t pattern[MAX_PATH];
    JoinPath(pattern, MAX_PATH, dir, L"*");

    WIN32_FIND_DATAW data;
    HANDLE find = FindFirstFileW(pattern, &data);
    if (find == INVALID_HANDLE_VALUE) return;

    do
    {
        if (wcscmp(data.cFileName, L".") == 0 || wcscmp(data.cFileName, L"..") == 0) continue;
        if (topLevel && skipName && _wcsicmp(data.cFileName, skipName) == 0) continue;

        wchar_t path[MAX_PATH];
        JoinPath(path, MAX_PATH, dir, data.cFileName);
        if (selfPath && selfPath[0] && _wcsicmp(path, selfPath) == 0) continue;

        if (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
        {
            DeleteDirectoryContents(path, selfPath, skipName, 0);
            SetFileAttributesW(path, FILE_ATTRIBUTE_NORMAL);
            RemoveDirectoryW(path);
        }
        else
        {
            SetFileAttributesW(path, FILE_ATTRIBUTE_NORMAL);
            DeleteFileW(path);
        }
    } while (FindNextFileW(find, &data));

    FindClose(find);
}

static void RemoveUserPathEntry(const wchar_t *dir)
{
    HKEY key;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, L"Environment", 0, KEY_READ | KEY_WRITE, &key) != ERROR_SUCCESS) return;

    wchar_t current[32768] = { 0 };
    DWORD type = 0, size = sizeof(current);
    if (RegQueryValueExW(key, L"Path", NULL, &type, (LPBYTE)current, &size) != ERROR_SUCCESS)
    {
        RegCloseKey(key);
        return;
    }

    wchar_t updated[32768] = { 0 };
    wchar_t *context = NULL;
    wchar_t *token = wcstok_s(current, L";", &context);
    int removed = 0;
    while (token)
    {
        if (_wcsicmp(token, dir) != 0)
        {
            if (updated[0]) wcsncat_s(updated, 32768, L";", _TRUNCATE);
            wcsncat_s(updated, 32768, token, _TRUNCATE);
        }
        else
        {
            removed = 1;
        }
        token = wcstok_s(NULL, L";", &context);
    }

    if (removed)
    {
        RegSetValueExW(key, L"Path", 0, type == REG_EXPAND_SZ ? REG_EXPAND_SZ : REG_SZ,
                       (const BYTE *)updated, (DWORD)((wcslen(updated) + 1) * sizeof(wchar_t)));
        DWORD_PTR result = 0;
        SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, (LPARAM)L"Environment",
                            SMTO_ABORTIFHUNG, 5000, &result);
    }

    RegCloseKey(key);
}

static void RemoveShortcuts(void)
{
    wchar_t path[MAX_PATH], folder[MAX_PATH] = { 0 };
    if (SUCCEEDED(SHGetFolderPathW(NULL, CSIDL_DESKTOPDIRECTORY, NULL, 0, folder)))
    {
        JoinPath(path, MAX_PATH, folder, L"Codex GUI.lnk");
        DeleteFileW(path);
    }
    if (SUCCEEDED(SHGetFolderPathW(NULL, CSIDL_PROGRAMS, NULL, 0, folder)))
    {
        JoinPath(path, MAX_PATH, folder, L"Codex GUI.lnk");
        DeleteFileW(path);
    }
}

/* ------------------------------------------------------------------ 卸载 */

static void PerformUninstall(int purgeData)
{
    wchar_t self[MAX_PATH], installDir[MAX_PATH], codexBin[MAX_PATH], dataDir[MAX_PATH];
    GetModuleFileNameW(NULL, self, MAX_PATH);
    GetInstallDir(installDir, MAX_PATH);
    JoinPath(codexBin, MAX_PATH, installDir, L"codex\\bin");
    JoinPath(dataDir, MAX_PATH, installDir, L"data");

    RemoveUserPathEntry(codexBin);
    RemoveShortcuts();
    RegDeleteTreeW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CodexGui");

    if (purgeData)
    {
        DeleteDirectoryContents(installDir, self, NULL, 1);
        RemoveDirectoryW(installDir);
    }
    else
    {
        /* 保留 data 目录，其余删掉；目录本身留着，方便用户找到自己的会话记录 */
        DeleteDirectoryContents(installDir, self, L"data", 1);
    }

    /* 自己删不掉自己：重启后删除，并用 cmd 清理残留 */
    MoveFileExW(self, NULL, MOVEFILE_DELAY_UNTIL_REBOOT);
    wchar_t command[1024];
    if (purgeData)
    {
        _snwprintf_s(command, 1024, _TRUNCATE,
                     L"cmd.exe /c ping -n 2 127.0.0.1 >nul & del /f /q \"%s\" & rmdir /s /q \"%s\"",
                     self, installDir);
    }
    else
    {
        _snwprintf_s(command, 1024, _TRUNCATE,
                     L"cmd.exe /c ping -n 2 127.0.0.1 >nul & del /f /q \"%s\"", self);
    }

    STARTUPINFOW si = { 0 };
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi = { 0 };
    if (CreateProcessW(NULL, command, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi))
    {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }

    g_succeeded = 1;
}

/* ------------------------------------------------------------------ 界面 */

static HWND MakeControl(const wchar_t *cls, const wchar_t *text, DWORD style,
                        int x, int y, int w, int h, int id)
{
    HWND control = CreateWindowExW(0, cls, text, WS_CHILD | WS_VISIBLE | style,
                                   x, y, w, h, g_hwnd, (HMENU)(INT_PTR)id, NULL, NULL);
    if (control && g_font) SendMessageW(control, WM_SETFONT, (WPARAM)g_font, TRUE);
    return control;
}

static LRESULT CALLBACK WindowProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam)
{
    switch (message)
    {
        case WM_COMMAND:
            if (LOWORD(wParam) == 1)   /* 卸载 */
            {
                int purge = SendMessageW(g_purge, BM_GETCHECK, 0, 0) == BST_CHECKED;
                SetWindowTextW(g_status, L"正在删除…");
                PerformUninstall(purge);
                MessageBoxW(hwnd,
                            purge ? L"Codex GUI 已卸载，data 目录也一并删除。"
                                  : L"Codex GUI 已卸载。\n\n为保留会话记录，data 目录没有删除。",
                            APP_NAME, MB_OK | MB_ICONINFORMATION);
                DestroyWindow(hwnd);
            }
            else if (LOWORD(wParam) == 2)
            {
                DestroyWindow(hwnd);
            }
            return 0;

        case WM_CLOSE:
            DestroyWindow(hwnd);
            return 0;

        case WM_DESTROY:
            PostQuitMessage(0);
            return 0;
    }
    return DefWindowProcW(hwnd, message, wParam, lParam);
}

static int CreateUi(HINSTANCE instance)
{
    WNDCLASSEXW wc = { 0 };
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = WindowProc;
    wc.hInstance = instance;
    wc.hCursor = LoadCursorW(NULL, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
    wc.lpszClassName = kWindowClass;
    wc.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(1));
    wc.hIconSm = wc.hIcon;
    RegisterClassExW(&wc);

    int width = 520, height = 268;
    RECT work;
    SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
    g_hwnd = CreateWindowExW(WS_EX_APPWINDOW, kWindowClass, L"卸载 Codex GUI",
                             WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU,
                             work.left + ((work.right - work.left) - width) / 2,
                             work.top + ((work.bottom - work.top) - height) / 2,
                             width, height, NULL, NULL, instance, NULL);
    if (!g_hwnd) return 0;

    g_font = (HFONT)GetStockObject(DEFAULT_GUI_FONT);

    wchar_t installDir[MAX_PATH], text[1024];
    GetInstallDir(installDir, MAX_PATH);

    MakeControl(L"STATIC", L"将从下面的目录删除 Codex GUI：", SS_LEFT, 22, 16, 480, 20, 0);
    _snwprintf_s(text, 1024, _TRUNCATE, L"%s", installDir);
    MakeControl(L"STATIC", text, SS_LEFT | SS_PATHELLIPSIS, 22, 38, 480, 20, 0);
    MakeControl(L"STATIC",
                L"会一并删除程序文件、快捷方式以及 PATH 里的相关条目。",
                SS_LEFT, 22, 64, 480, 20, 0);

    g_purge = MakeControl(L"BUTTON", L"同时删除 data 目录（会话记录、配置、API 密钥）",
                          BS_AUTOCHECKBOX, 22, 96, 480, 24, 0);
    MakeControl(L"STATIC", L"不勾选则保留 data 目录，之后重装还能继续用。",
                SS_LEFT, 42, 122, 460, 20, 0);

    g_status = MakeControl(L"STATIC", L"", SS_LEFT, 22, 152, 480, 20, 0);
    MakeControl(L"BUTTON", L"卸载", BS_DEFPUSHBUTTON, 322, 186, 170, 32, 1);
    MakeControl(L"BUTTON", L"取消", BS_PUSHBUTTON, 232, 186, 80, 32, 2);

    ShowWindow(g_hwnd, SW_SHOW);
    UpdateWindow(g_hwnd);
    return 1;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, LPWSTR commandLine, int show)
{
    (void)previous;
    (void)show;
    (void)commandLine;

    int purge = 0;
    int argc = 0;
    /* wWinMain 的 lpCmdLine 不含程序名，统一用完整命令行 */
    LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (argv)
    {
        for (int i = 1; i < argc; i++)
        {
            if (_wcsicmp(argv[i], L"/silent") == 0 || _wcsicmp(argv[i], L"/s") == 0) g_silent = 1;
            else if (_wcsicmp(argv[i], L"/purge") == 0) purge = 1;
        }
        LocalFree(argv);
    }

    if (g_silent)
    {
        PerformUninstall(purge);
        return g_succeeded ? 0 : 1;
    }

    InitCommonControlsEx(&(INITCOMMONCONTROLSEX){ sizeof(INITCOMMONCONTROLSEX), ICC_STANDARD_CLASSES });
    SetProcessDPIAware();
    if (!CreateUi(instance)) return 1;

    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0))
    {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    return 0;
}
