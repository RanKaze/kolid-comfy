// KolidCtxMenu — KolidUI > PNG 的 Win11 现代(一级)右键菜单命令。
//
// 原生 x64 COM DLL,由 win11_menu/AppxManifest.xml 以 com:SurrogateServer 声明。
// 资源管理器构建现代菜单时经打包身份激活本类(宿主 dllhost),Invoke 里把选中的
// .cud 全路径交给 CudPng.exe(与经典菜单走同一个转换器):先找 DLL 同目录(MSIX
// 包根会携带一份),再退到上一级目录(仓库内松散注册调试的 ..\CudPng.exe)。
//
// 结构:父命令 "KolidUI"(ECF_HASSUBCOMMANDS,EnumSubCommands 给一枚子命令)→
// 子命令 "PNG"(执行导出)。清单 ItemType 只能写 "*"(官方只支持 * / Directory /
// Directory\Background),.cud 过滤靠 GetState:对非 .cud 选择返回 ECS_HIDDEN
// (父命令与子命令都过 CollectCudArgs 判,多选混文件同样隐藏)。
//
// 构建(install_windows_integration.bat → win11_menu\install_win11_menu.ps1 调 MSYS2 ucrt64 g++):
//   g++ -shared -O2 -s -static -static-libgcc -static-libstdc++ -finput-charset=utf-8
//       -o win11_menu/KolidCtxMenu.dll KolidCtxMenu.cpp -lole32 -lshlwapi -lshell32 -luuid
// 注意: 必须 -static 或至少 -Wl,-Bstatic -lwinpthread -Wl,-Bdynamic,否则产物会导入
// libwinpthread-1.dll;代理宿主(dllhost)在 WindowsApps 包里找不到它,LoadLibrary
// 失败 → COM 激活 0x8007007E,菜单项永不出现(DLL 也永远不会被加载)。
// ucrt64 的 g++ 必须把 C:\msys64\ucrt64\bin 挂在 PATH 里调用,否则
// cc1plus 找不到自己的 DLL 会静默失败(无输出、exit 1)。-luuid 提供 GUID_NULL。
// CLSID 与清单 desktop5:Verb@Clsid / com:Class@Id 三处必须一致。

#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shobjidl.h>
#include <shlwapi.h>
#include <string>
#include <new>
#include <cstdarg>
#include <cstdio>

static const CLSID CLSID_KolidCtx =
    {0xD9BEBED3, 0xC09F, 0x4A12, {0xAE, 0x23, 0x7F, 0xCD, 0x98, 0xE7, 0xE5, 0xE7}};

static LONG g_cObjects = 0;
static LONG g_cLocks = 0;

// 诊断日志:仅当 %TEMP%\kolid_ctxmenu.debug 存在时写 %TEMP%\kolid_ctxmenu.log。
// 用于确认现代菜单是否真的加载/查询了本 DLL(shell 侧不生效时唯一可信信号)。
static void CtxLog(const WCHAR* fmt, ...) {
    WCHAR tmp[MAX_PATH];
    DWORD n = GetTempPathW(MAX_PATH, tmp);
    if (n == 0 || n >= MAX_PATH) return;
    std::wstring dbg = std::wstring(tmp) + L"kolid_ctxmenu.debug";
    if (GetFileAttributesW(dbg.c_str()) == INVALID_FILE_ATTRIBUTES) return;
    std::wstring log = std::wstring(tmp) + L"kolid_ctxmenu.log";
    HANDLE f = CreateFileW(log.c_str(), FILE_APPEND_DATA,
                           FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                           OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f == INVALID_HANDLE_VALUE) return;
    SYSTEMTIME st;
    GetLocalTime(&st);
    WCHAR line[1024];
    int prefix = swprintf(line, 1024, L"[%02u:%02u:%02u.%03u pid=%lu] ",
                          st.wHour, st.wMinute, st.wSecond, st.wMilliseconds,
                          (unsigned long)GetCurrentProcessId());
    va_list ap;
    va_start(ap, fmt);
    int m = vswprintf(line + prefix, 1024 - prefix, fmt, ap);
    va_end(ap);
    if (m < 0) m = 0;
    int total = prefix + m;
    if (total > 1022) total = 1022;
    line[total++] = L'\r';
    line[total++] = L'\n';
    DWORD wrote = 0;
    WriteFile(f, line, (DWORD)(total * sizeof(WCHAR)), &wrote, nullptr);
    CloseHandle(f);
}

static void ModuleDir(WCHAR* out, DWORD cch) {
    HMODULE mod = nullptr;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       reinterpret_cast<LPCWSTR>(&ModuleDir), &mod);
    DWORD n = GetModuleFileNameW(mod, out, cch);
    if (n == 0 || n >= cch) {
        if (cch) out[0] = 0;
        return;
    }
    WCHAR* slash = nullptr;
    for (WCHAR* p = out; *p; p++) {
        if (*p == L'\\') slash = p;
    }
    if (slash) *slash = 0;
}

static bool EndsWithCud(const WCHAR* path) {
    int n = lstrlenW(path);
    if (n < 4) return false;
    const WCHAR* s = path + n - 4;
    return s[0] == L'.'
        && (s[1] == L'c' || s[1] == L'C')
        && (s[2] == L'u' || s[2] == L'U')
        && (s[3] == L'd' || s[3] == L'D');
}

// 菜单图标:icon.ico 相对 DLL 的位置随部署方式不同——MSIX 包里打在包根
// (DLL 同目录),仓库松散注册调试时在 ..\..(client\icon.ico)。取第一个存在的;
// 都不存在时回退包内路径(shell 对解析失败的图标退通用占位图)。
static std::wstring ResolveIconPath() {
    WCHAR dir[MAX_PATH];
    ModuleDir(dir, MAX_PATH);
    std::wstring packaged = std::wstring(dir) + L"\\icon.ico";
    if (GetFileAttributesW(packaged.c_str()) != INVALID_FILE_ATTRIBUTES) return packaged;
    std::wstring loose = std::wstring(dir) + L"\\..\\..\\icon.ico";
    if (GetFileAttributesW(loose.c_str()) != INVALID_FILE_ATTRIBUTES) return loose;
    return packaged;
}

// 收集选中项的 .cud 文件系统路径并拼成带引号的参数串。
// 任一选中项不是 .cud → 返回 false(命令应隐藏)。
static bool CollectCudArgs(IShellItemArray* items, std::wstring* args) {
    if (!items) return false;
    DWORD count = 0;
    if (FAILED(items->GetCount(&count)) || count == 0) return false;
    for (DWORD i = 0; i < count; i++) {
        IShellItem* item = nullptr;
        if (FAILED(items->GetItemAt(i, &item)) || !item) return false;
        LPWSTR path = nullptr;
        HRESULT hr = item->GetDisplayName(SIGDN_FILESYSPATH, &path);
        item->Release();
        if (FAILED(hr) || !path) return false;
        bool ok = EndsWithCud(path);
        if (ok) {
            if (!args->empty()) args->push_back(L' ');
            args->push_back(L'"');
            args->append(path);
            args->push_back(L'"');
        }
        CoTaskMemFree(path);
        if (!ok) return false;
    }
    return true;
}

// ---------------------------------------------------------------- 子命令 PNG

class KolidPngCommand final : public IExplorerCommand {
public:
    KolidPngCommand() { InterlockedIncrement(&g_cObjects); }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (riid == __uuidof(IUnknown) || riid == __uuidof(IExplorerCommand)) {
            *ppv = static_cast<IExplorerCommand*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&m_ref); }
    ULONG STDMETHODCALLTYPE Release() override {
        LONG n = InterlockedDecrement(&m_ref);
        if (n == 0) { InterlockedDecrement(&g_cObjects); delete this; }
        return n;
    }

    HRESULT STDMETHODCALLTYPE GetTitle(IShellItemArray*, LPWSTR* name) override {
        return SHStrDupW(L"PNG", name);
    }
    HRESULT STDMETHODCALLTYPE GetIcon(IShellItemArray*, LPWSTR* icon) override {
        if (!icon) return E_POINTER;
        std::wstring p = ResolveIconPath();
        CtxLog(L"Png::GetIcon -> %ls", p.c_str());
        return SHStrDupW(p.c_str(), icon);
    }
    HRESULT STDMETHODCALLTYPE GetToolTip(IShellItemArray*, LPWSTR* tip) override {
        if (tip) *tip = nullptr;
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE GetCanonicalName(GUID* guid) override {
        if (guid) *guid = GUID_NULL;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetState(IShellItemArray* items, BOOL, EXPCMDSTATE* state) override {
        if (!state) return E_POINTER;
        std::wstring args;
        bool ok = CollectCudArgs(items, &args);
        *state = ok ? ECS_ENABLED : ECS_HIDDEN;
        CtxLog(L"Png::GetState items=%p ok=%d", items, ok ? 1 : 0);
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE Invoke(IShellItemArray* items, IBindCtx*) override {
        std::wstring args;
        if (!CollectCudArgs(items, &args)) { CtxLog(L"Png::Invoke non-cud, E_FAIL"); return E_FAIL; }
        WCHAR dir[MAX_PATH];
        ModuleDir(dir, MAX_PATH);
        // 正式安装(MSIX)时 CudPng.exe 与 DLL 同在包根;仓库内松散注册调试时
        // DLL 在 win11_menu\ 下、转换器在上一级(..\CudPng.exe)。两处都认。
        std::wstring cand[2] = {
            std::wstring(dir) + L"\\CudPng.exe",
            std::wstring(dir) + L"\\..\\CudPng.exe",
        };
        WCHAR full[MAX_PATH];
        full[0] = 0;
        for (int i = 0; i < 2; i++) {
            if (!GetFullPathNameW(cand[i].c_str(), MAX_PATH, full, nullptr)) { full[0] = 0; continue; }
            if (GetFileAttributesW(full) != INVALID_FILE_ATTRIBUTES) break;
            full[0] = 0;
        }
        if (!full[0]) {
            CtxLog(L"Png::Invoke CudPng.exe not found near %ls", dir);
            return HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
        }
        std::wstring cmd = L"\"" + std::wstring(full) + L"\" " + args;
        CtxLog(L"Png::Invoke cmd=%ls", cmd.c_str());
        STARTUPINFOW si = {};
        si.cb = sizeof(si);
        PROCESS_INFORMATION pi = {};
        if (!CreateProcessW(full, &cmd[0], nullptr, nullptr, FALSE, 0, nullptr, nullptr, &si, &pi)) {
            return HRESULT_FROM_WIN32(GetLastError());
        }
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetFlags(EXPCMDFLAGS* flags) override {
        if (flags) *flags = ECF_DEFAULT;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE EnumSubCommands(IEnumExplorerCommand** e) override {
        if (e) *e = nullptr;
        return E_NOTIMPL;
    }

private:
    ~KolidPngCommand() {}
    LONG m_ref = 1;
};

// ------------------------------------------------------- 父命令 KolidUI + 枚举

class KolidCommandEnum final : public IEnumExplorerCommand {
public:
    KolidCommandEnum() { InterlockedIncrement(&g_cObjects); }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (riid == __uuidof(IUnknown) || riid == __uuidof(IEnumExplorerCommand)) {
            *ppv = static_cast<IEnumExplorerCommand*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&m_ref); }
    ULONG STDMETHODCALLTYPE Release() override {
        LONG n = InterlockedDecrement(&m_ref);
        if (n == 0) { InterlockedDecrement(&g_cObjects); delete this; }
        return n;
    }

    HRESULT STDMETHODCALLTYPE Next(ULONG celt, IExplorerCommand** out, ULONG* fetched) override {
        if (!out) return E_POINTER;
        if (fetched) *fetched = 0;
        if (celt < 1 || m_pos != 0) return S_FALSE;
        KolidPngCommand* png = new (std::nothrow) KolidPngCommand();
        if (!png) return E_OUTOFMEMORY;
        out[0] = static_cast<IExplorerCommand*>(png);   // ref=1 交给调用方
        m_pos = 1;
        if (fetched) *fetched = 1;
        return celt == 1 ? S_OK : S_FALSE;
    }
    HRESULT STDMETHODCALLTYPE Skip(ULONG celt) override {
        m_pos += celt;
        return m_pos <= 1 ? S_OK : S_FALSE;
    }
    HRESULT STDMETHODCALLTYPE Reset() override {
        m_pos = 0;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE Clone(IEnumExplorerCommand** out) override {
        if (!out) return E_POINTER;
        KolidCommandEnum* c = new (std::nothrow) KolidCommandEnum();
        if (!c) return E_OUTOFMEMORY;
        c->m_pos = m_pos;
        *out = static_cast<IEnumExplorerCommand*>(c);
        return S_OK;
    }

private:
    ~KolidCommandEnum() {}
    LONG m_ref = 1;
    UINT m_pos = 0;
};

class KolidUiCommand final : public IExplorerCommand {
public:
    KolidUiCommand() { InterlockedIncrement(&g_cObjects); }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (riid == __uuidof(IUnknown) || riid == __uuidof(IExplorerCommand)) {
            *ppv = static_cast<IExplorerCommand*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&m_ref); }
    ULONG STDMETHODCALLTYPE Release() override {
        LONG n = InterlockedDecrement(&m_ref);
        if (n == 0) { InterlockedDecrement(&g_cObjects); delete this; }
        return n;
    }

    HRESULT STDMETHODCALLTYPE GetTitle(IShellItemArray*, LPWSTR* name) override {
        return SHStrDupW(L"KolidUI", name);
    }
    HRESULT STDMETHODCALLTYPE GetIcon(IShellItemArray*, LPWSTR* icon) override {
        if (!icon) return E_POINTER;
        std::wstring p = ResolveIconPath();
        CtxLog(L"Ui::GetIcon -> %ls", p.c_str());
        return SHStrDupW(p.c_str(), icon);
    }
    HRESULT STDMETHODCALLTYPE GetToolTip(IShellItemArray*, LPWSTR* tip) override {
        if (tip) *tip = nullptr;
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE GetCanonicalName(GUID* guid) override {
        if (guid) *guid = GUID_NULL;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetState(IShellItemArray* items, BOOL, EXPCMDSTATE* state) override {
        if (!state) return E_POINTER;
        std::wstring args;
        bool ok = CollectCudArgs(items, &args);
        *state = ok ? ECS_ENABLED : ECS_HIDDEN;
        CtxLog(L"Ui::GetState items=%p ok=%d", items, ok ? 1 : 0);
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE Invoke(IShellItemArray*, IBindCtx*) override {
        return S_OK;   // 父命令只做容器,真正执行的是子命令 PNG
    }
    HRESULT STDMETHODCALLTYPE GetFlags(EXPCMDFLAGS* flags) override {
        if (flags) *flags = ECF_HASSUBCOMMANDS;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE EnumSubCommands(IEnumExplorerCommand** e) override {
        if (!e) return E_POINTER;
        CtxLog(L"Ui::EnumSubCommands");
        KolidCommandEnum* en = new (std::nothrow) KolidCommandEnum();
        if (!en) return E_OUTOFMEMORY;
        *e = static_cast<IEnumExplorerCommand*>(en);
        return S_OK;
    }

private:
    ~KolidUiCommand() {}
    LONG m_ref = 1;
};

// -------------------------------------------------------------------- 工厂/导出

class KolidClassFactory final : public IClassFactory {
public:
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (riid == __uuidof(IUnknown) || riid == __uuidof(IClassFactory)) {
            *ppv = static_cast<IClassFactory*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&m_ref); }
    ULONG STDMETHODCALLTYPE Release() override { return InterlockedDecrement(&m_ref); }
    HRESULT STDMETHODCALLTYPE CreateInstance(IUnknown* outer, REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        *ppv = nullptr;
        if (outer) return CLASS_E_NOAGGREGATION;
        KolidUiCommand* cmd = new (std::nothrow) KolidUiCommand();
        if (!cmd) return E_OUTOFMEMORY;
        HRESULT hr = cmd->QueryInterface(riid, ppv);
        cmd->Release();
        return hr;
    }
    HRESULT STDMETHODCALLTYPE LockServer(BOOL lock) override {
        if (lock) InterlockedIncrement(&g_cLocks);
        else InterlockedDecrement(&g_cLocks);
        return S_OK;
    }

private:
    LONG m_ref = 1;
};

static KolidClassFactory g_factory;

extern "C" HRESULT __declspec(dllexport) WINAPI
DllGetClassObject(REFCLSID rclsid, REFIID riid, void** ppv) {
    if (!ppv) return E_POINTER;
    *ppv = nullptr;
    bool match = (rclsid == CLSID_KolidCtx);
    HRESULT hr = match ? g_factory.QueryInterface(riid, ppv) : CLASS_E_CLASSNOTAVAILABLE;
    CtxLog(L"DllGetClassObject match=%d hr=0x%08X", match ? 1 : 0, (unsigned)hr);
    return hr;
}

extern "C" HRESULT __declspec(dllexport) WINAPI DllCanUnloadNow() {
    return (g_cObjects == 0 && g_cLocks == 0) ? S_OK : S_FALSE;
}

BOOL WINAPI DllMain(HINSTANCE self, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(self);
        CtxLog(L"DllMain attach");
    }
    return TRUE;
}
