/*
 * Codex GUI 安装程序
 *
 * 单文件安装包：exe 本体 + 尾部追加的 payload.zip（内含 app/ 与 codex/ 两个目录）。
 * 安装过程：解压 payload -> 写便携标记与默认配置 -> 可选写 PATH、建快捷方式 -> 注册卸载信息。
 *
 * 命令行：
 *   CodexGuiSetup.exe                       图形界面安装
 *   CodexGuiSetup.exe /silent [/dir=路径]    静默安装（默认装到 %LOCALAPPDATA%\Programs\CodexGui）
 *   可选开关：/nopath /noshortcut /nolaunch
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
#include <shlwapi.h>
#include <stdio.h>
#include <stdarg.h>

#define APP_NAME        L"Codex GUI"
#define APP_VERSION     L"1.0.0"
#define APP_EXE         L"CodexGui.exe"
#define APP_SUBDIR      L"app"
#define UNINSTALL_NAME  L"uninstall.exe"
#define PAYLOAD_MAGIC   "CGXGUIPL"
#define PAYLOAD_TRAILER 16   /* 8 字节长度 + 8 字节 magic */

#define IDC_DIR         1001
#define IDC_BROWSE      1002
#define IDC_PATH        1003
#define IDC_SHORTCUT    1004
#define IDC_LAUNCH      1005
#define IDC_INSTALL     1006
#define IDC_CANCEL      1007
#define IDC_PROGRESS    1008
#define IDC_STATUS      1009
#define WM_APP_DONE     (WM_APP + 1)

static const wchar_t *kWindowClass = L"CodexGuiSetupWindow";

static HWND g_hwnd;
static HWND g_edit;
static HWND g_progress;
static HWND g_status;
static HWND g_installButton;
static HWND g_checkPath;
static HWND g_checkShortcut;
static HWND g_checkLaunch;
static HFONT g_font;
static HANDLE g_thread;
static int g_result;
static int g_launchAfterInstall;
static int g_running;
static int g_silentMode;
static FILE *g_log;
static wchar_t g_initialDir[MAX_PATH];

/* ------------------------------------------------------------------ 日志 */

static void LogLine(const wchar_t *format, ...)
{
    if (!g_log) return;

    wchar_t buffer[2048];
    va_list args;
    va_start(args, format);
    _vsnwprintf_s(buffer, 2048, _TRUNCATE, format, args);
    va_end(args);

    char utf8[4096];
    int len = WideCharToMultiByte(CP_UTF8, 0, buffer, -1, utf8, sizeof(utf8), NULL, NULL);
    if (len > 1) fwrite(utf8, 1, (size_t)(len - 1), g_log);
    fwrite("\r\n", 1, 2, g_log);
    fflush(g_log);
}

static void LogOpen(void)
{
    wchar_t path[MAX_PATH];
    if (GetTempPathW(MAX_PATH, path) == 0) return;
    wcsncat_s(path, MAX_PATH, L"CodexGuiSetup.log", _TRUNCATE);

    g_log = _wfopen(path, L"ab");
    if (!g_log) return;

    SYSTEMTIME now;
    GetLocalTime(&now);
    LogLine(L"==== Codex GUI 安装程序 %04d-%02d-%02d %02d:%02d:%02d ====",
            now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond);
}

/* ------------------------------------------------------------------ 小工具 */

static void SetStatus(const wchar_t *text)
{
    SetWindowTextW(g_status, text);
    UpdateWindow(g_status);
}

static void ShowError(const wchar_t *text)
{
    LogLine(L"[错误] %s", text);
    if (g_silentMode) return;   /* 静默安装不弹窗，错误只写日志 */
    MessageBoxW(g_hwnd, text, APP_NAME, MB_OK | MB_ICONERROR);
}

static int FileExists(const wchar_t *path)
{
    DWORD attr = GetFileAttributesW(path);
    return attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY);
}

static int DirExists(const wchar_t *path)
{
    DWORD attr = GetFileAttributesW(path);
    return attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY);
}

static void JoinPath(wchar_t *out, size_t count, const wchar_t *dir, const wchar_t *name)
{
    wcsncpy_s(out, count, dir, _TRUNCATE);
    size_t len = wcslen(out);
    if (len > 0 && out[len - 1] != L'\\' && out[len - 1] != L'/')
    {
        wcsncat_s(out, count, L"\\", _TRUNCATE);
    }
    wcsncat_s(out, count, name, _TRUNCATE);
}

static int EnsureDir(const wchar_t *path)
{
    if (DirExists(path)) return 1;
    int rc = SHCreateDirectoryExW(NULL, path, NULL);
    return rc == ERROR_SUCCESS || rc == ERROR_ALREADY_EXISTS || rc == ERROR_FILE_EXISTS;
}

/* 提示：文件放 %TEMP%，避免污染安装目录 */
static int BuildTempFilePath(wchar_t *out, size_t count, const wchar_t *name)
{
    wchar_t temp[MAX_PATH];
    if (GetTempPathW(MAX_PATH, temp) == 0) return 0;
    JoinPath(out, count, temp, name);
    return 1;
}

/* ------------------------------------------------------------- 载荷（zip） */

static int LocatePayload(HANDLE file, unsigned long long *offset, unsigned long long *length)
{
    LARGE_INTEGER size;
    if (!GetFileSizeEx(file, &size)) return 0;
    if (size.QuadPart <= PAYLOAD_TRAILER) return 0;

    unsigned char trailer[PAYLOAD_TRAILER];
    LARGE_INTEGER pos;
    pos.QuadPart = size.QuadPart - PAYLOAD_TRAILER;
    if (!SetFilePointerEx(file, pos, NULL, FILE_BEGIN)) return 0;

    DWORD read = 0;
    if (!ReadFile(file, trailer, PAYLOAD_TRAILER, &read, NULL) || read != PAYLOAD_TRAILER) return 0;
    if (memcmp(trailer + 8, PAYLOAD_MAGIC, 8) != 0) return 0;

    unsigned long long len = 0;
    memcpy(&len, trailer, 8);
    if (len == 0 || len + PAYLOAD_TRAILER > (unsigned long long)size.QuadPart) return 0;

    *length = len;
    *offset = (unsigned long long)size.QuadPart - PAYLOAD_TRAILER - len;
    return 1;
}

static int WritePayloadToTemp(const wchar_t *zipPath)
{
    wchar_t self[MAX_PATH];
    if (GetModuleFileNameW(NULL, self, MAX_PATH) == 0) { ShowError(L"无法定位安装程序自身路径。"); return 0; }

    HANDLE in = CreateFileW(self, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (in == INVALID_HANDLE_VALUE) { ShowError(L"无法读取安装程序文件。"); return 0; }

    unsigned long long offset = 0, length = 0;
    if (!LocatePayload(in, &offset, &length))
    {
        CloseHandle(in);
        ShowError(L"安装包数据不完整（找不到内置的安装载荷）。\n\n请重新下载安装包。");
        return 0;
    }

    LARGE_INTEGER pos;
    pos.QuadPart = (LONGLONG)offset;
    SetFilePointerEx(in, pos, NULL, FILE_BEGIN);

    HANDLE out = CreateFileW(zipPath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_TEMPORARY, NULL);
    if (out == INVALID_HANDLE_VALUE)
    {
        CloseHandle(in);
        ShowError(L"无法写入临时文件（磁盘空间不足或权限受限）。");
        return 0;
    }

    unsigned char *buffer = (unsigned char *)malloc(1 << 20);
    if (!buffer)
    {
        CloseHandle(in);
        CloseHandle(out);
        ShowError(L"内存不足。");
        return 0;
    }

    unsigned long long remaining = length;
    int ok = 1;
    while (remaining > 0)
    {
        DWORD chunk = (DWORD)(remaining > (1 << 20) ? (1 << 20) : remaining);
        DWORD read = 0, written = 0;
        if (!ReadFile(in, buffer, chunk, &read, NULL) || read == 0) { ok = 0; break; }
        if (!WriteFile(out, buffer, read, &written, NULL) || written != read) { ok = 0; break; }
        remaining -= read;
    }

    free(buffer);
    CloseHandle(in);
    CloseHandle(out);

    if (!ok)
    {
        DeleteFileW(zipPath);
        ShowError(L"释放安装数据失败（磁盘空间不足？）。");
        return 0;
    }
    return 1;
}

static int RunHidden(const wchar_t *commandLine, DWORD timeoutMs)
{
    wchar_t cmdline[32768];
    wcsncpy_s(cmdline, 32768, commandLine, _TRUNCATE);

    LogLine(L"执行：%s", commandLine);

    STARTUPINFOW si = { 0 };
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi = { 0 };
    if (!CreateProcessW(NULL, cmdline, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) return -1;

    DWORD wait = WaitForSingleObject(pi.hProcess, timeoutMs);
    DWORD code = (DWORD)-1;
    if (wait == WAIT_OBJECT_0) GetExitCodeProcess(pi.hProcess, &code);
    else TerminateProcess(pi.hProcess, 1);

    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    LogLine(L"退出码=%d（%s）", (int)code, wait == WAIT_OBJECT_0 ? L"正常结束" : L"超时被终止");
    return wait == WAIT_OBJECT_0 ? (int)code : -1;
}

/* 用系统自带的 tar 解压；老系统没有 tar 时退回到 PowerShell。 */
static int ExtractPayload(const wchar_t *zipPath, const wchar_t *targetDir)
{
    wchar_t command[32768];
    wchar_t systemDir[MAX_PATH];

    if (GetSystemDirectoryW(systemDir, MAX_PATH) > 0)
    {
        wchar_t tarExe[MAX_PATH];
        JoinPath(tarExe, MAX_PATH, systemDir, L"tar.exe");
        if (FileExists(tarExe))
        {
            _snwprintf_s(command, 32768, _TRUNCATE,
                         L"\"%s\" -x -f \"%s\" -C \"%s\"", tarExe, zipPath, targetDir);
            int rc = RunHidden(command, 30 * 60 * 1000);
            if (rc == 0) return 1;
        }
    }

    wchar_t ps[MAX_PATH];
    JoinPath(ps, MAX_PATH, systemDir, L"WindowsPowerShell\\v1.0\\powershell.exe");
    if (FileExists(ps))
    {
        _snwprintf_s(command, 32768, _TRUNCATE,
                     L"\"%s\" -NoProfile -ExecutionPolicy Bypass -Command "
                     L"\"Expand-Archive -LiteralPath '%s' -DestinationPath '%s' -Force\"",
                     ps, zipPath, targetDir);
        int rc = RunHidden(command, 30 * 60 * 1000);
        if (rc == 0) return 1;
    }

    return 0;
}

/* ------------------------------------------------------------ 配置与注册表 */

static void WriteJsonStringEscaped(FILE *file, const wchar_t *text)
{
    for (const wchar_t *p = text; *p; ++p)
    {
        if (*p == L'\\' || *p == L'"') fputc('\\', file);
        fputc((int)(*p < 128 ? *p : L'?'), file);
    }
}

/* 默认工作目录 = 安装目录；数据目录 = <安装目录>\data */
static int WriteDefaultConfig(const wchar_t *installDir)
{
    wchar_t dataDir[MAX_PATH], configPath[MAX_PATH];
    JoinPath(dataDir, MAX_PATH, installDir, L"data");
    if (!EnsureDir(dataDir)) return 0;
    JoinPath(configPath, MAX_PATH, dataDir, L"config.json");

    FILE *file = _wfopen(configPath, L"wb");
    if (!file) return 0;
    fputs("{\n  \"WorkDir\": \"", file);
    WriteJsonStringEscaped(file, installDir);
    fputs("\"\n}\n", file);
    fclose(file);
    return 1;
}

static int WritePortableMarker(const wchar_t *installDir)
{
    wchar_t appDir[MAX_PATH], dataDir[MAX_PATH], marker[MAX_PATH];
    JoinPath(appDir, MAX_PATH, installDir, APP_SUBDIR);
    JoinPath(dataDir, MAX_PATH, installDir, L"data");
    if (!EnsureDir(appDir)) return 0;
    JoinPath(marker, MAX_PATH, appDir, L"portable.marker");

    FILE *file = _wfopen(marker, L"wb");
    if (!file) return 0;
    fwrite("\xEF\xBB\xBF", 1, 3, file);   /* UTF-8 BOM：Windows 记事本打开中文路径不乱码 */
    char utf8[MAX_PATH * 3];
    int len = WideCharToMultiByte(CP_UTF8, 0, dataDir, -1, utf8, sizeof(utf8), NULL, NULL);
    if (len > 1) fwrite(utf8, 1, (size_t)(len - 1), file);
    fclose(file);
    return 1;
}

static int AddToUserPath(const wchar_t *dir)
{
    HKEY key;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, L"Environment", 0, KEY_READ | KEY_WRITE, &key) != ERROR_SUCCESS) return 0;

    wchar_t current[32768] = { 0 };
    DWORD type = 0, size = sizeof(current);
    RegQueryValueExW(key, L"Path", NULL, &type, (LPBYTE)current, &size);

    if (wcsstr(current, dir) != NULL)
    {
        RegCloseKey(key);
        return 1;   /* 已经在 PATH 里 */
    }

    wchar_t updated[32768];
    size_t len = wcslen(current);
    if (len > 0 && current[len - 1] == L';')
    {
        _snwprintf_s(updated, 32768, _TRUNCATE, L"%s%s", current, dir);
    }
    else if (len > 0)
    {
        _snwprintf_s(updated, 32768, _TRUNCATE, L"%s;%s", current, dir);
    }
    else
    {
        _snwprintf_s(updated, 32768, _TRUNCATE, L"%s", dir);
    }

    DWORD bytes = (DWORD)((wcslen(updated) + 1) * sizeof(wchar_t));
    LONG rc = RegSetValueExW(key, L"Path", 0,
                             type == REG_EXPAND_SZ ? REG_EXPAND_SZ : REG_SZ,
                             (const BYTE *)updated, bytes);
    RegCloseKey(key);

    if (rc == ERROR_SUCCESS)
    {
        DWORD_PTR result = 0;
        SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, (LPARAM)L"Environment",
                            SMTO_ABORTIFHUNG, 5000, &result);
        return 1;
    }
    return 0;
}

static int RemoveFromUserPath(const wchar_t *dir)
{
    HKEY key;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, L"Environment", 0, KEY_READ | KEY_WRITE, &key) != ERROR_SUCCESS) return 0;

    wchar_t current[32768] = { 0 };
    DWORD type = 0, size = sizeof(current);
    if (RegQueryValueExW(key, L"Path", NULL, &type, (LPBYTE)current, &size) != ERROR_SUCCESS)
    {
        RegCloseKey(key);
        return 0;
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
        DWORD bytes = (DWORD)((wcslen(updated) + 1) * sizeof(wchar_t));
        RegSetValueExW(key, L"Path", 0, type == REG_EXPAND_SZ ? REG_EXPAND_SZ : REG_SZ,
                       (const BYTE *)updated, bytes);
        DWORD_PTR result = 0;
        SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, (LPARAM)L"Environment",
                            SMTO_ABORTIFHUNG, 5000, &result);
    }

    RegCloseKey(key);
    return removed;
}

static int CreateShortcut(const wchar_t *linkPath, const wchar_t *target, const wchar_t *workDir,
                          const wchar_t *description)
{
    IShellLinkW *link = NULL;
    IPersistFile *file = NULL;
    int ok = 0;

    if (SUCCEEDED(CoCreateInstance(&CLSID_ShellLink, NULL, CLSCTX_INPROC_SERVER, &IID_IShellLinkW, (void **)&link)))
    {
        link->lpVtbl->SetPath(link, target);
        link->lpVtbl->SetWorkingDirectory(link, workDir);
        link->lpVtbl->SetDescription(link, description);
        link->lpVtbl->SetIconLocation(link, target, 0);

        if (SUCCEEDED(link->lpVtbl->QueryInterface(link, &IID_IPersistFile, (void **)&file)))
        {
            ok = SUCCEEDED(file->lpVtbl->Save(file, linkPath, TRUE));
            file->lpVtbl->Release(file);
        }
        link->lpVtbl->Release(link);
    }
    return ok;
}

static int CreateShortcuts(const wchar_t *installDir)
{
    wchar_t target[MAX_PATH], workDir[MAX_PATH], linkPath[MAX_PATH];
    JoinPath(target, MAX_PATH, installDir, APP_SUBDIR);
    JoinPath(target, MAX_PATH, target, APP_EXE);
    wcsncpy_s(workDir, MAX_PATH, installDir, _TRUNCATE);

    /* 桌面 */
    wchar_t desktop[MAX_PATH] = { 0 };
    if (SUCCEEDED(SHGetFolderPathW(NULL, CSIDL_DESKTOPDIRECTORY, NULL, 0, desktop)))
    {
        JoinPath(linkPath, MAX_PATH, desktop, L"Codex GUI.lnk");
        CreateShortcut(linkPath, target, workDir, L"Codex GUI");
    }

    /* 开始菜单 */
    wchar_t startMenu[MAX_PATH] = { 0 };
    if (SUCCEEDED(SHGetFolderPathW(NULL, CSIDL_PROGRAMS, NULL, 0, startMenu)))
    {
        JoinPath(linkPath, MAX_PATH, startMenu, L"Codex GUI.lnk");
        CreateShortcut(linkPath, target, workDir, L"Codex GUI");
    }
    return 1;
}

static void RemoveShortcuts(void)
{
    wchar_t path[MAX_PATH];
    wchar_t desktop[MAX_PATH] = { 0 };
    if (SUCCEEDED(SHGetFolderPathW(NULL, CSIDL_DESKTOPDIRECTORY, NULL, 0, desktop)))
    {
        JoinPath(path, MAX_PATH, desktop, L"Codex GUI.lnk");
        DeleteFileW(path);
    }
    wchar_t startMenu[MAX_PATH] = { 0 };
    if (SUCCEEDED(SHGetFolderPathW(NULL, CSIDL_PROGRAMS, NULL, 0, startMenu)))
    {
        JoinPath(path, MAX_PATH, startMenu, L"Codex GUI.lnk");
        DeleteFileW(path);
    }
}

static int RegisterUninstall(const wchar_t *installDir)
{
    HKEY key;
    if (RegCreateKeyExW(HKEY_CURRENT_USER,
                        L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CodexGui",
                        0, NULL, 0, KEY_WRITE, NULL, &key, NULL) != ERROR_SUCCESS)
    {
        return 0;
    }

    wchar_t appExe[MAX_PATH], uninstaller[MAX_PATH], uninstallCmd[MAX_PATH], size[32];
    JoinPath(appExe, MAX_PATH, installDir, APP_SUBDIR);
    JoinPath(appExe, MAX_PATH, appExe, APP_EXE);
    JoinPath(uninstaller, MAX_PATH, installDir, UNINSTALL_NAME);
    _snwprintf_s(uninstallCmd, MAX_PATH, _TRUNCATE, L"\"%s\"", uninstaller);
    _snwprintf_s(size, 32, _TRUNCATE, L"%u", 1);

    const wchar_t *names[] = { L"DisplayName", L"DisplayVersion", L"Publisher", L"InstallLocation",
                               L"DisplayIcon", L"UninstallString", L"QuietUninstallString", L"NoModify", L"NoRepair" };
    const wchar_t *values[] = { L"Codex GUI", APP_VERSION, L"Codex GUI", installDir,
                                appExe, uninstallCmd, uninstallCmd, L"1", L"1" };

    for (int i = 0; i < 9; i++)
    {
        DWORD bytes = (DWORD)((wcslen(values[i]) + 1) * sizeof(wchar_t));
        RegSetValueExW(key, names[i], 0, REG_SZ, (const BYTE *)values[i], bytes);
    }
    RegCloseKey(key);
    return 1;
}

/* --------------------------------------------------------------- 安装主流程 */

struct InstallOptions
{
    wchar_t dir[MAX_PATH];
    int addPath;
    int shortcut;
    int launch;
};

static struct InstallOptions g_options;

static int DoInstall(void)
{
    wchar_t status[512];

    LogLine(L"安装目录=%s（PATH=%d 快捷方式=%d 完成后启动=%d）",
            g_options.dir, g_options.addPath, g_options.shortcut, g_options.launch);

    if (!EnsureDir(g_options.dir))
    {
        ShowError(L"无法创建安装目录：\n\n权限不足或路径不可写。\n可以换一个目录，或右键以管理员身份运行。");
        return 0;
    }

    /* 写一个探针文件，提前暴露权限问题 */
    wchar_t probe[MAX_PATH];
    JoinPath(probe, MAX_PATH, g_options.dir, L".codexgui-write-test");
    HANDLE test = CreateFileW(probe, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_TEMPORARY, NULL);
    if (test == INVALID_HANDLE_VALUE)
    {
        ShowError(L"没有写入权限：\n\n安装目录需要可写权限，请换一个目录（例如默认的本地应用目录），"
                  L"或以管理员身份重新运行安装程序。");
        return 0;
    }
    CloseHandle(test);
    DeleteFileW(probe);

    SetStatus(L"正在释放安装数据…");
    LogLine(L"开始释放安装载荷");

    wchar_t zipPath[MAX_PATH];
    wchar_t zipName[64];
    _snwprintf_s(zipName, 64, _TRUNCATE, L"codexgui-setup-%u.zip", (unsigned)GetCurrentProcessId());
    if (!BuildTempFilePath(zipPath, MAX_PATH, zipName)) return 0;

    if (!WritePayloadToTemp(zipPath)) return 0;

    SetStatus(L"正在解压（约 1 分钟，请稍候）…");
    LogLine(L"开始解压 %s -> %s", zipPath, g_options.dir);
    int extracted = ExtractPayload(zipPath, g_options.dir);
    DeleteFileW(zipPath);
    LogLine(L"解压结果=%d", extracted);

    if (!extracted)
    {
        ShowError(L"解压失败。\n\n请确认系统里有 tar.exe（Windows 10 1803 及以上自带）"
                  L"或 PowerShell，并检查磁盘空间。");
        return 0;
    }

    wchar_t appExe[MAX_PATH];
    JoinPath(appExe, MAX_PATH, g_options.dir, APP_SUBDIR);
    JoinPath(appExe, MAX_PATH, appExe, APP_EXE);
    if (!FileExists(appExe))
    {
        ShowError(L"解压后没有找到 CodexGui.exe，安装包可能已损坏。");
        return 0;
    }

    SetStatus(L"正在写入配置…");
    LogLine(L"便携标记=%d 默认配置=%d",
            WritePortableMarker(g_options.dir), WriteDefaultConfig(g_options.dir));

    if (g_options.addPath)
    {
        SetStatus(L"正在配置 PATH…");
        wchar_t codexBin[MAX_PATH];
        JoinPath(codexBin, MAX_PATH, g_options.dir, L"codex\\bin");
        AddToUserPath(codexBin);
    }

    if (g_options.shortcut)
    {
        SetStatus(L"正在创建快捷方式…");
        CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
        CreateShortcuts(g_options.dir);
        CoUninitialize();
    }

    RegisterUninstall(g_options.dir);

    LogLine(L"安装完成：%s", g_options.dir);
    _snwprintf_s(status, 512, _TRUNCATE, L"安装完成：%s", g_options.dir);
    SetStatus(status);
    return 1;
}

static DWORD WINAPI InstallThreadProc(LPVOID param)
{
    (void)param;
    g_result = DoInstall();
    PostMessageW(g_hwnd, WM_APP_DONE, 0, 0);
    return 0;
}

static void SetBusy(int busy)
{
    g_running = busy;
    EnableWindow(g_edit, !busy);
    EnableWindow(GetDlgItem(g_hwnd, IDC_BROWSE), !busy);
    EnableWindow(g_checkPath, !busy);
    EnableWindow(g_checkShortcut, !busy);
    EnableWindow(g_checkLaunch, !busy);
    EnableWindow(g_installButton, !busy);
    EnableWindow(GetDlgItem(g_hwnd, IDC_CANCEL), !busy);
}

static const wchar_t *DefaultInstallDir(wchar_t *buffer, size_t count)
{
    wchar_t local[MAX_PATH] = { 0 };
    if (FAILED(SHGetFolderPathW(NULL, CSIDL_LOCAL_APPDATA, NULL, 0, local))) return NULL;
    JoinPath(buffer, count, local, L"Programs\\CodexGui");
    return buffer;
}

static void StartInstall(void)
{
    if (g_running) return;

    wchar_t dir[MAX_PATH];
    GetWindowTextW(g_edit, dir, MAX_PATH);
    while (wcslen(dir) > 3 && (dir[wcslen(dir) - 1] == L'\\' || dir[wcslen(dir) - 1] == L'/'))
    {
        dir[wcslen(dir) - 1] = 0;
    }

    if (wcslen(dir) < 4 || dir[1] != L':' || dir[2] != L'\\')
    {
        ShowError(L"请输入完整的安装路径，例如 D:\\CodexGui。");
        return;
    }
    if (wcslen(dir) == 3)
    {
        ShowError(L"请不要直接装到盘符根目录，换一个子目录，例如 D:\\CodexGui。");
        return;
    }

    wcsncpy_s(g_options.dir, MAX_PATH, dir, _TRUNCATE);
    g_options.addPath = SendMessageW(g_checkPath, BM_GETCHECK, 0, 0) == BST_CHECKED;
    g_options.shortcut = SendMessageW(g_checkShortcut, BM_GETCHECK, 0, 0) == BST_CHECKED;
    g_options.launch = SendMessageW(g_checkLaunch, BM_GETCHECK, 0, 0) == BST_CHECKED;
    g_launchAfterInstall = g_options.launch;

    SetBusy(1);
    SetStatus(L"正在准备…");
    SendMessageW(g_progress, PBM_SETMARQUEE, TRUE, 40);
    g_thread = CreateThread(NULL, 0, InstallThreadProc, NULL, 0, NULL);
    if (!g_thread)
    {
        SetBusy(0);
        ShowError(L"无法启动安装线程。");
    }
}

static void FinishInstall(int success)
{
    SendMessageW(g_progress, PBM_SETMARQUEE, FALSE, 0);
    SendMessageW(g_progress, PBM_SETPOS, success ? 100 : 0, 0);
    SetBusy(0);

    if (!success)
    {
        SetStatus(L"安装失败，请查看上面的提示。");
        return;
    }

    if (g_launchAfterInstall)
    {
        wchar_t appExe[MAX_PATH];
        JoinPath(appExe, MAX_PATH, g_options.dir, APP_SUBDIR);
        JoinPath(appExe, MAX_PATH, appExe, APP_EXE);
        ShellExecuteW(NULL, L"open", appExe, NULL, g_options.dir, SW_SHOWNORMAL);
    }

    MessageBoxW(g_hwnd,
                L"Codex GUI 已安装完成。\n\n"
                L"首次启动会打开设置面板，填上你的 API 链接和密钥就能开始对话。",
                APP_NAME, MB_OK | MB_ICONINFORMATION);
    DestroyWindow(g_hwnd);
}

/* ------------------------------------------------------------------ 界面 */

static HWND CreateControl(const wchar_t *className, const wchar_t *text, DWORD style,
                          int x, int y, int w, int h, int id)
{
    HWND control = CreateWindowExW(0, className, text, WS_CHILD | WS_VISIBLE | style,
                                   x, y, w, h, g_hwnd, (HMENU)(INT_PTR)id, NULL, NULL);
    if (control && g_font) SendMessageW(control, WM_SETFONT, (WPARAM)g_font, TRUE);
    return control;
}

static void BrowseForDir(void)
{
    BROWSEINFOW bi = { 0 };
    bi.hwndOwner = g_hwnd;
    bi.lpszTitle = L"选择 Codex GUI 的安装目录";
    bi.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE | BIF_USENEWUI;

    LPITEMIDLIST idl = SHBrowseForFolderW(&bi);
    if (!idl) return;

    wchar_t path[MAX_PATH];
    if (SHGetPathFromIDListW(idl, path))
    {
        wchar_t merged[MAX_PATH];
        _snwprintf_s(merged, MAX_PATH, _TRUNCATE, L"%s\\CodexGui", path);
        SetWindowTextW(g_edit, DirExists(merged) ? merged : merged);
    }
    CoTaskMemFree(idl);
}

static void CreateUi(void)
{
    RECT work;
    SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
    int width = 620, height = 430;
    int x = work.left + ((work.right - work.left) - width) / 2;
    int y = work.top + ((work.bottom - work.top) - height) / 2;

    g_hwnd = CreateWindowExW(WS_EX_APPWINDOW, kWindowClass, L"Codex GUI 安装程序",
                             WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
                             x, y, width, height, NULL, NULL, GetModuleHandleW(NULL), NULL);
    if (!g_hwnd) return;

    g_font = (HFONT)GetStockObject(DEFAULT_GUI_FONT);

    CreateControl(L"STATIC", L"安装 Codex GUI", SS_LEFT, 24, 18, 400, 26, 0);
    CreateControl(L"STATIC",
                  L"一个调用 Codex CLI 的桌面界面，支持自备 API（DeepSeek 等）。\n"
                  L"安装包内不含任何密钥或对话记录。",
                  SS_LEFT, 24, 48, 560, 40, 0);

    CreateControl(L"STATIC", L"安装位置", SS_LEFT, 24, 100, 100, 20, 0);
    g_edit = CreateControl(L"EDIT", L"", WS_BORDER | ES_AUTOHSCROLL, 24, 122, 470, 26, IDC_DIR);
    CreateControl(L"BUTTON", L"浏览…", BS_PUSHBUTTON, 504, 122, 80, 26, IDC_BROWSE);

    g_checkPath = CreateControl(L"BUTTON", L"把 codex 命令加入 PATH（命令行里也能直接用）",
                                BS_AUTOCHECKBOX, 26, 164, 560, 22, IDC_PATH);
    g_checkShortcut = CreateControl(L"BUTTON", L"创建桌面和开始菜单快捷方式",
                                    BS_AUTOCHECKBOX, 26, 190, 560, 22, IDC_SHORTCUT);
    g_checkLaunch = CreateControl(L"BUTTON", L"安装完成后立刻启动",
                                  BS_AUTOCHECKBOX, 26, 216, 560, 22, IDC_LAUNCH);
    SendMessageW(g_checkPath, BM_SETCHECK, BST_CHECKED, 0);
    SendMessageW(g_checkShortcut, BM_SETCHECK, BST_CHECKED, 0);
    SendMessageW(g_checkLaunch, BM_SETCHECK, BST_CHECKED, 0);

    g_progress = CreateControl(PROGRESS_CLASSW, L"", WS_BORDER, 24, 262, 560, 16, IDC_PROGRESS);
    SendMessageW(g_progress, PBM_SETRANGE, 0, MAKELPARAM(0, 100));
    SendMessageW(g_progress, PBM_SETMARQUEE, FALSE, 0);

    g_status = CreateControl(L"STATIC", L"准备就绪。", SS_LEFT, 24, 288, 560, 20, IDC_STATUS);
    CreateControl(L"STATIC",
                  L"安装程序会：释放程序文件 → 把数据目录放在 <安装目录>\\data → 写默认工作目录。",
                  SS_LEFT, 24, 312, 560, 20, 0);

    g_installButton = CreateControl(L"BUTTON", L"开始安装", BS_DEFPUSHBUTTON, 404, 348, 180, 32, IDC_INSTALL);
    CreateControl(L"BUTTON", L"取消", BS_PUSHBUTTON, 318, 348, 80, 32, IDC_CANCEL);

    wchar_t buffer[MAX_PATH];
    if (g_initialDir[0])
    {
        SetWindowTextW(g_edit, g_initialDir);   /* 命令行 /dir= 指定的目录优先 */
    }
    else if (DefaultInstallDir(buffer, MAX_PATH))
    {
        SetWindowTextW(g_edit, buffer);
    }

    ShowWindow(g_hwnd, SW_SHOW);
    UpdateWindow(g_hwnd);
}

static LRESULT CALLBACK WindowProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam)
{
    switch (message)
    {
        case WM_COMMAND:
            switch (LOWORD(wParam))
            {
                case IDC_BROWSE: BrowseForDir(); return 0;
                case IDC_INSTALL: StartInstall(); return 0;
                case IDC_CANCEL: DestroyWindow(hwnd); return 0;
            }
            return 0;

        case WM_APP_DONE: FinishInstall(g_result); return 0;

        case WM_CLOSE:
            if (g_running) return 0;   /* 安装过程中不允许关窗 */
            DestroyWindow(hwnd);
            return 0;

        case WM_DESTROY:
            PostQuitMessage(0);
            return 0;
    }
    return DefWindowProcW(hwnd, message, wParam, lParam);
}

/* ------------------------------------------------------------------ 入口 */

static int ParseSwitches(const wchar_t *commandLine, wchar_t *dirOut, int *silent,
                         int *addPath, int *shortcut, int *launch)
{
    *silent = 0; *addPath = 1; *shortcut = 1; *launch = 0;
    (void)commandLine;

    /* wWinMain 的 lpCmdLine 不含程序名，这里统一用完整命令行，跳过 argv[0] */
    LPWSTR full = GetCommandLineW();
    if (!full) return 1;

    int argc = 0;
    LPWSTR *argv = CommandLineToArgvW(full, &argc);
    if (!argv) return 1;

    for (int i = 1; i < argc; i++)
    {
        const wchar_t *arg = argv[i];
        if (_wcsicmp(arg, L"/silent") == 0 || _wcsicmp(arg, L"/s") == 0) *silent = 1;
        else if (_wcsicmp(arg, L"/nopath") == 0) *addPath = 0;
        else if (_wcsicmp(arg, L"/noshortcut") == 0) *shortcut = 0;
        else if (_wcsicmp(arg, L"/nolaunch") == 0) *launch = 0;
        else if (_wcsicmp(arg, L"/launch") == 0) *launch = 1;
        else if (wcsncmp(arg, L"/dir=", 5) == 0) wcsncpy_s(dirOut, MAX_PATH, arg + 5, _TRUNCATE);
        else if (wcsncmp(arg, L"/D=", 3) == 0) wcsncpy_s(dirOut, MAX_PATH, arg + 3, _TRUNCATE);
    }

    LocalFree(argv);
    return 1;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, LPWSTR commandLine, int show)
{
    (void)previous;
    (void)show;

    INITCOMMONCONTROLSEX controls = { sizeof(controls), ICC_PROGRESS_CLASS | ICC_STANDARD_CLASSES };
    InitCommonControlsEx(&controls);
    SetProcessDPIAware();
    LogOpen();

    wchar_t dir[MAX_PATH] = { 0 };
    int silent = 0, addPath = 1, shortcut = 1, launch = 0;
    ParseSwitches(commandLine, dir, &silent, &addPath, &shortcut, &launch);
    g_silentMode = silent;
    if (dir[0]) wcsncpy_s(g_initialDir, MAX_PATH, dir, _TRUNCATE);
    LogLine(L"参数：silent=%d dir=%s path=%d shortcut=%d launch=%d",
            silent, dir, addPath, shortcut, launch);

    if (dir[0] == 0 && !DefaultInstallDir(dir, MAX_PATH))
    {
        MessageBoxW(NULL, L"无法确定默认安装目录。", APP_NAME, MB_OK | MB_ICONERROR);
        return 1;
    }

    if (silent)
    {
        wcsncpy_s(g_options.dir, MAX_PATH, dir, _TRUNCATE);
        g_options.addPath = addPath;
        g_options.shortcut = shortcut;
        g_options.launch = launch;
        int ok = DoInstall();
        if (ok && launch)
        {
            wchar_t appExe[MAX_PATH];
            JoinPath(appExe, MAX_PATH, dir, APP_SUBDIR);
            JoinPath(appExe, MAX_PATH, appExe, APP_EXE);
            ShellExecuteW(NULL, L"open", appExe, NULL, dir, SW_SHOWNORMAL);
        }
        return ok ? 0 : 1;
    }

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

    CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    CreateUi();

    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0))
    {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    CoUninitialize();
    return 0;
}
