/* ── KaPluginWorker.exe ───────────────────────────────────────────────────────────────────────
 *
 * 插件**只在这个进程里**加载。这是「插件隔离」这一层的全部理由：真插件里有一个一开就把
 * 整个进程带崩的（AGT 附近那个）。只要在 ComfyUI 进程里 LoadLibrary 一次，崩的就是整台
 * ComfyUI 加上它手里所有工程。隔开之后，崩的只是这个 worker —— 宿主看到心跳停了，
 * 报一个"插件没答应"，界面该干嘛干嘛。
 *
 * 无 CRT、无 SDK，和 KolidAudio.dll 同一套约束（见 build_worker.ps1）。
 *
 * 单线程是刻意的：命令与渲染都在这一个循环里跑，所以**不需要任何锁** ——
 * 声部表、事件队列、插件自己的状态全归这一个线程。代价是一次命令执行期间不渲染
 * （开插件要一秒），可接受：开插件的时候本来也不该有声音。
 *
 *   循环：等命令（1ms 超时）→ 有命令就做，做完敲 ev_done；
 *         没命令且 live 且 ring 有空位 → 渲染一块推进 w。
 *
 * 音频**不在这边出声**：worker 没有声卡。它只把样本写进 ring，宿主那边混进设备输出。
 * 谁出声谁负责时钟 —— 这里渲染多少块完全由 ring 的空位决定，跟时间无关。
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

#include <stdint.h>
#include "ka_shm.h"

int _fltused = 0;

#pragma function(memcpy, memset)

void* __cdecl memcpy(void* dst, const void* src, uint64_t n) {
    unsigned char* d = (unsigned char*)dst;
    const unsigned char* s = (const unsigned char*)src;
    while (n--) *d++ = *s++;
    return dst;
}

void* __cdecl memset(void* dst, int c, uint64_t n) {
    unsigned char* d = (unsigned char*)dst;
    while (n--) *d++ = (unsigned char)c;
    return dst;
}

/* ka_vst3.h 要的另外几个面（共享内存那几个已经在 ka_shm.h 里了）。 */
__declspec(dllimport) void* __stdcall LoadLibraryW(const uint16_t* path);
__declspec(dllimport) void* __stdcall GetProcAddress(void* mod, const char* name);
__declspec(dllimport) int32_t __stdcall FreeLibrary(void* mod);
__declspec(dllimport) void* __stdcall VirtualAlloc(void* addr, uint64_t size, uint32_t type, uint32_t protect);
__declspec(dllimport) int32_t __stdcall VirtualFree(void* addr, uint64_t size, uint32_t type);
__declspec(dllimport) uint32_t __stdcall WaitForSingleObject(void* handle, uint32_t ms);
__declspec(dllimport) void __stdcall Sleep(uint32_t ms);
__declspec(dllimport) int32_t __stdcall CloseHandle(void* h);
/* .vstpreset 的读/写（状态块是文件，不是命令槽） */
__declspec(dllimport) void* __stdcall CreateFileW(const uint16_t* path, uint32_t access,
                                                  uint32_t share, void* sa, uint32_t disp,
                                                  uint32_t flags, void* tmpl);
__declspec(dllimport) int32_t __stdcall ReadFile(void* h, void* buf, uint32_t want,
                                                 int32_t* got, void* ov);
__declspec(dllimport) int32_t __stdcall WriteFile(void* h, const void* buf, uint32_t want,
                                                  int32_t* put, void* ov);
__declspec(dllimport) int32_t __stdcall GetFileSizeEx(void* h, int64_t* size);
/* 排障：插件里 AV 时把"哪条指令炸的"留给宿主（正常路径不走这里）。 */
__declspec(dllimport) void* __stdcall AddVectoredExceptionHandler(uint32_t first,
                                                                 int32_t (__stdcall* handler)(void* info));
__declspec(dllimport) uint32_t __stdcall GetCurrentThreadId(void);

#define KA_MEM_COMMIT     0x00001000u
#define KA_MEM_RESERVE    0x00002000u
#define KA_MEM_RELEASE    0x00008000u
#define KA_PAGE_READWRITE 4u

/* ka_vst3.h 里唯一一个"外面给"的量：采样率。宿主在 CMD_OPEN 之前把它塞进 shm->rate，
 * 插件的 setupProcessing 就按它来。定在这儿而不是放共享内存里，是因为它只在开插件
 * 那一刻被读一次 —— 没必要让两边为此同步。 */
static int32_t g_rate = 48000;

/* 编译器内建（不引 intrin.h：这里没有 CRT，只靠签名让 cl 认成 intrinsic）。 */
unsigned __int64 __readgsqword(unsigned long offset);

#define KA_VST3_TLS_PROBE 1
#include "ka_vst3.h"

/* ══ 编辑器窗口（UI 线程） ═══════════════════════════════════════════════════════════════════
 *
 * HALion/Kontakt 的音色只能由它们自己的界面挑 —— 没有"选音色"的 API（程序列表全是占位）。
 * 所以宿主这边给它们一个真窗口：界面一开，用户在里面挑一次音色，关窗后宿主把整块状态存成
 * .vstpreset，以后就是全自动加载。
 *
 * 为什么单起一条 UI 线程而不是在主循环里顺手泵消息：
 *   · 主循环要持续往 ring 里渲块，拖旋钮时消息一多就会饿死音频（ring 只有 8 块 ≈ 85ms）；
 *   · 插件界面内部也有自己的定时器/模态框，泵在主线程上就等于让它们坐在音频线程上。
 * 这条线程只碰 IPlugView 与窗口；组件的 process 仍只在主线程。VST3 本来就允许两线程
 * 各自调自己那一半（音频线程 process / UI 线程 view）。
 *
 * 协议：主线程 PostMessage 给下面这个隐藏窗口，UI 线程做完敲 g_ui_done。
 * 用户点 X 关窗时 UI 线程直接拆（并记一次 g_ed_closed），宿主轮询 EDITOR_STATE 就能发现
 * "音色挑完了"，随后发 STATE_SAVE。
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/* 无 windows.h，照旧手写声明（导入库由 user32.def 造）。 */
__declspec(dllimport) void* __stdcall GetModuleHandleW(const uint16_t* name);
__declspec(dllimport) uint16_t __stdcall RegisterClassW(const void* wc);
__declspec(dllimport) void* __stdcall CreateWindowExW(uint32_t exStyle, const uint16_t* cls,
                                                      const uint16_t* title, uint32_t style,
                                                      int32_t x, int32_t y, int32_t w, int32_t h,
                                                      void* parent, void* menu, void* inst, void* param);
__declspec(dllimport) int64_t __stdcall DefWindowProcW(void* hwnd, uint32_t msg, uint64_t wp, int64_t lp);
__declspec(dllimport) int32_t __stdcall DestroyWindow(void* hwnd);
__declspec(dllimport) int32_t __stdcall ShowWindow(void* hwnd, int32_t cmd);
__declspec(dllimport) int32_t __stdcall UpdateWindow(void* hwnd);
__declspec(dllimport) int32_t __stdcall PostMessageW(void* hwnd, uint32_t msg, uint64_t wp, int64_t lp);
__declspec(dllimport) int32_t __stdcall GetMessageW(void* msg, void* hwnd, uint32_t lo, uint32_t hi);
__declspec(dllimport) int32_t __stdcall PeekMessageW(void* msg, void* hwnd, uint32_t lo, uint32_t hi, uint32_t remove);
__declspec(dllimport) uint32_t __stdcall MsgWaitForMultipleObjects(uint32_t n, const void** hs,
                                                                  int32_t waitAll, uint32_t ms,
                                                                  uint32_t mask);
__declspec(dllimport) uint32_t __stdcall GetTickCount(void);
__declspec(dllimport) int32_t __stdcall TranslateMessage(const void* msg);
__declspec(dllimport) int64_t __stdcall DispatchMessageW(const void* msg);
__declspec(dllimport) int32_t __stdcall GetClientRect(void* hwnd, int32_t* rect);
__declspec(dllimport) int32_t __stdcall AdjustWindowRect(int32_t* rect, uint32_t style, int32_t menu);
__declspec(dllimport) int32_t __stdcall SetWindowPos(void* hwnd, void* after, int32_t x, int32_t y,
                                                     int32_t cx, int32_t cy, uint32_t flags);
__declspec(dllimport) int32_t __stdcall SetForegroundWindow(void* hwnd);
__declspec(dllimport) void* __stdcall GetForegroundWindow(void);
__declspec(dllimport) uint32_t __stdcall GetWindowThreadProcessId(void* hwnd, uint32_t* pid);
__declspec(dllimport) int32_t __stdcall AttachThreadInput(uint32_t id_attach, uint32_t id_attach_to,
                                                          int32_t attach);
__declspec(dllimport) int32_t __stdcall BringWindowToTop(void* hwnd);
__declspec(dllimport) int32_t __stdcall IsIconic(void* hwnd);
__declspec(dllimport) int64_t __stdcall SendMessageW(void* hwnd, uint32_t msg, uint64_t wp, int64_t lp);
__declspec(dllimport) void* __stdcall LoadImageW(void* inst, const uint16_t* name, uint32_t type,
                                                 int32_t cx, int32_t cy, uint32_t flags);
__declspec(dllimport) uint32_t __stdcall GetModuleFileNameW(void* mod, uint16_t* out, uint32_t cap);
__declspec(dllimport) void* __stdcall LoadCursorW(void* inst, const uint16_t* name);
__declspec(dllimport) void* __stdcall CreateThread(void* sa, uint64_t stack,
                                                   uint32_t (__stdcall* fn)(void*), void* arg,
                                                   uint32_t flags, uint32_t* id);

typedef struct ka_wndclass {
    uint32_t style;
    int64_t  (__stdcall* lpfnWndProc)(void*, uint32_t, uint64_t, int64_t);
    int32_t  cbClsExtra;
    int32_t  cbWndExtra;
    void*    hInstance;
    void*    hIcon;
    void*    hCursor;
    void*    hbrBackground;
    const uint16_t* lpszMenuName;
    const uint16_t* lpszClassName;
} ka_wndclass;

typedef struct ka_msg {
    void*    hwnd;
    uint32_t message;
    uint32_t pad;
    uint64_t wParam;
    int64_t  lParam;
    uint32_t time;
    int32_t  pt_x;
    int32_t  pt_y;
    uint32_t lPrivate;
    uint32_t pad2;
} ka_msg;

#define KA_WM_ED_OPEN   0x0411u        /* WM_APP+17 */
#define KA_WM_ED_CLOSE  0x0412u
#define KA_WM_JOB       0x0413u        /* 让 UI 线程替主线程跑一段插件 API */
#define KA_WM_CLOSE     0x0010u
#define KA_WM_SIZE      0x0005u
#define KA_WM_SETFOCUS  0x0007u
#define KA_WM_KILLFOCUS 0x0008u
#define KA_WS_OVERLAPPED 0x00CF0000u
#define KA_WS_CLIPCHILD  0x02000000u
#define KA_WS_VISIBLE    0x10000000u
#define KA_CW_USEDEFAULT ((int32_t)0x80000000u)
#define KA_SW_SHOW       5
#define KA_SW_RESTORE    9
#define KA_SWP_NOMOVE    0x0002u
#define KA_SWP_NOZORDER  0x0004u
#define KA_SWP_NOACTIVATE 0x0010u
#define KA_HWND_MESSAGE  ((void*)(int64_t)-3)
#define KA_WM_SETICON    0x0080u
#define KA_IMAGE_ICON    1u
#define KA_LR_LOADFROMFILE 0x0010u
#define KA_ICON_SMALL    0
#define KA_ICON_BIG      1
#define KA_PATH_MAX      512

static uint16_t g_ed_class[48];
static uint16_t g_ed_title[48];
static uint16_t g_ui_title[48];
static void* g_ui_ready = 0;          /* UI 线程起好了 */
static volatile uint32_t g_ui_tid = 0;    /* UI 线程 id（判断"我现在是不是站在 UI 线程上"） */
static void (*volatile g_ui_job)(void) = 0;  /* 交给 UI 线程去跑的那件事 */
static void* g_ui_done = 0;           /* 一次开/关做完 */
static void* g_ui_hidden = 0;         /* UI 线程的隐藏窗口（消息入口） */
static void* g_ed_wnd = 0;            /* 可见的插件窗口 */
static int32_t g_ui_started = 0;
static int32_t g_ed_attached = 0;
static volatile int32_t g_ui_rc = 0;     /* 最近一次开/关的结果（UI 线程写、主线程读） */
static volatile int32_t g_ed_open = 0;
static volatile int32_t g_ed_closed = 0; /* 用户点 X 关掉几次 */
static int32_t g_ed_w = 0, g_ed_h = 0;

/** 改父窗尺寸。插件在 resizeView 里调进来时已经站在 UI 线程上，SetWindowPos 同步发
 *  WM_SIZE，那边再回调 onSize —— 与 SDK 要求的"同一调用栈"一致。 */
static void wk_editor_resize(int32_t w, int32_t h) {
    int32_t r[4];
    if (!g_ed_wnd || w <= 0 || h <= 0) return;
    r[0] = 0; r[1] = 0; r[2] = w; r[3] = h;
    AdjustWindowRect(r, KA_WS_OVERLAPPED | KA_WS_CLIPCHILD, 0);
    SetWindowPos(g_ed_wnd, 0, 0, 0, r[2] - r[0], r[3] - r[1],
                 KA_SWP_NOMOVE | KA_SWP_NOZORDER | KA_SWP_NOACTIVATE);
}

/* ── 图标：与 Kolid Desktop 同一枚 ────────────────────────────────────────────────────────────
 * worker 就住在 client/kolid_audio/ 下，图标是 client/icon.ico —— 从自己的 exe 路径退两级
 * 取，不额外传参、也不看 cwd（宿主拉起它时的 cwd 是 ComfyUI 的）。取不到就留系统默认图标，
 * 不为一个装饰失败影响开窗。 */
static uint16_t g_ed_icon_path[KA_PATH_MAX];

static void wk_icon_file(uint16_t* out, int32_t cap) {
    static const char tail[] = "kolid_audio";
    static const char name[] = "icon.ico";
    int32_t n = GetModuleFileNameW(0, out, (uint32_t)cap);
    int i, k, j;

    if (n <= 0 || n >= cap) { out[0] = 0; return; }
    for (i = n - 1; i >= 0 && out[i] != (uint16_t)'\\'; --i) { }
    if (i < 0) { out[0] = 0; return; }
    k = i;                                          /* exe 名之前那个反斜杠 */
    /* 目录名是 kolid_audio 就再退一级（k 指向 client 后面那个反斜杠）。 */
    if (k >= 12 && out[k - 12] == (uint16_t)'\\') {
        int same = 1;
        for (j = 0; j < 11; ++j) if (out[k - 11 + j] != (uint16_t)tail[j]) { same = 0; break; }
        if (same) k -= 12;
    }
    for (j = 0; j < 8 && k + 1 + j < cap - 1; ++j) out[k + 1 + j] = (uint16_t)name[j];
    out[k + 1 + j] = 0;
}

static void wk_editor_icon(void* hwnd) {
    void* big;
    void* small;
    wk_icon_file(g_ed_icon_path, KA_PATH_MAX);
    if (!g_ed_icon_path[0]) return;
    big = LoadImageW(0, g_ed_icon_path, KA_IMAGE_ICON, 32, 32, KA_LR_LOADFROMFILE);
    if (!big) return;
    small = LoadImageW(0, g_ed_icon_path, KA_IMAGE_ICON, 16, 16, KA_LR_LOADFROMFILE);
    SendMessageW(hwnd, KA_WM_SETICON, KA_ICON_SMALL, (int64_t)(small ? small : big));
    SendMessageW(hwnd, KA_WM_SETICON, KA_ICON_BIG, (int64_t)big);
}

/* ── 前台 ────────────────────────────────────────────────────────────────────────────────────
 * 后台进程直接 SetForegroundWindow 会被前台锁静默拒绝（别的窗口刚吃过用户输入时，
 * 客户端那边实测 6/6 被拒）。配方与 client/kolid_client.py::_bring_to_front 一字不差：
 * 把自己的输入队列临时挂到当前前台线程上，借它的"拥有最近输入"身份设前台，随即解除。 */
static void wk_editor_front(void* hwnd) {
    void* fg;
    uint32_t cur, fg_tid;
    if (!hwnd) return;
    if (IsIconic(hwnd)) ShowWindow(hwnd, KA_SW_RESTORE);
    ShowWindow(hwnd, KA_SW_SHOW);
    if (GetForegroundWindow() == hwnd) return;
    SetForegroundWindow(hwnd);
    if (GetForegroundWindow() == hwnd) return;
    cur = GetCurrentThreadId();
    fg = GetForegroundWindow();
    fg_tid = fg ? GetWindowThreadProcessId(fg, 0) : 0;
    if (!fg_tid || fg_tid == cur) return;
    AttachThreadInput(cur, fg_tid, 1);
    BringWindowToTop(hwnd);
    SetForegroundWindow(hwnd);
    AttachThreadInput(cur, fg_tid, 0);
}

static void wk_editor_open_now(void) {
    int32_t rc, w = 0, h = 0, r[4];
    void* hinst;
    if (g_ed_wnd) { wk_editor_front(g_ed_wnd); g_ui_rc = 0; return; }
    rc = ka_v3_view_create();
    if (rc != 0) { g_ui_rc = rc - 100; return; }
    ka_v3_view_wanted(&w, &h);
    if (w < 240) w = 720;
    if (h < 160) h = 520;
    ka_v3_stage(5);
    r[0] = 0; r[1] = 0; r[2] = w; r[3] = h;
    AdjustWindowRect(r, KA_WS_OVERLAPPED | KA_WS_CLIPCHILD, 0);
    hinst = GetModuleHandleW(0);
    g_ed_wnd = CreateWindowExW(0, g_ed_class, g_ed_title,
                               KA_WS_OVERLAPPED | KA_WS_CLIPCHILD | KA_WS_VISIBLE,
                               KA_CW_USEDEFAULT, KA_CW_USEDEFAULT,
                               r[2] - r[0], r[3] - r[1], 0, 0, hinst, 0);
    if (!g_ed_wnd) { ka_v3_view_destroy(); g_ui_rc = -7; return; }
    wk_editor_icon(g_ed_wnd);
    if (ka_v3_view_attach(g_ed_wnd) != 0) {
        DestroyWindow(g_ed_wnd);
        g_ed_wnd = 0;
        ka_v3_view_destroy();
        g_ui_rc = -8;
        return;
    }
    g_ed_attached = 1;
    ka_v3_stage(7);
    {   int32_t cr[4];
        g_ed_w = w;
        g_ed_h = h;
        if (GetClientRect(g_ed_wnd, cr)) { g_ed_w = cr[2]; g_ed_h = cr[3]; }
    }
    ka_v3_stage(8);
    ShowWindow(g_ed_wnd, KA_SW_SHOW);
    wk_editor_front(g_ed_wnd);
    /* **不要**在这里 UpdateWindow。它会同步强发 WM_PAINT，跑到插件自己还没处理完的
     * 初始化任务前面去 —— Kontakt 7 的绘制就此死等那些任务，窗口永远白着、开窗调用也
     * 永远等不到回执（实测 15 秒超时，stage 卡在 9）。WM_PAINT 是队列里没别的消息时
     * 才合成的低优先级消息，交给 UI 线程的消息泵自然去画就对了。 */
    ka_v3_stage(6);
    g_ed_open = 1;
    g_ui_rc = 0;
}

static void wk_editor_close_now(int32_t by_user) {
    if (!g_ed_wnd) return;
    g_ed_attached = 0;
    ka_v3_view_detach();         /* removed() 必须早于父窗销毁 */
    ka_v3_view_destroy();
    DestroyWindow(g_ed_wnd);
    g_ed_wnd = 0;
    g_ed_open = 0;
    if (by_user) g_ed_closed = g_ed_closed + 1;
}

static int64_t __stdcall ka_ed_proc(void* hwnd, uint32_t msg, uint64_t wp, int64_t lp) {
    /* 排障：iv[6] = 正在处理的消息，iv[5] = 上一条处理完的。UI 线程卡死时读这两格。 */
    if (g_v3_shm) g_v3_shm->iv[6] = (int32_t)msg;
    if (hwnd == g_ed_wnd) {
        switch (msg) {
        case KA_WM_CLOSE:
            wk_editor_close_now(1);
            return 0;
        case KA_WM_SIZE:
            if (g_ed_attached && wp != 1) {          /* 1 = SIZE_MINIMIZED */
                int32_t r[4];
                if (GetClientRect(hwnd, r)) {
                    g_ed_w = r[2];
                    g_ed_h = r[3];
                    ka_v3_stage(20);
                    ka_v3_view_on_size(r[2], r[3]);
                    ka_v3_stage(21);
                }
            }
            return 0;
        case KA_WM_SETFOCUS:
            if (g_ed_attached) ka_v3_view_focus(1);
            return 0;
        case KA_WM_KILLFOCUS:
            if (g_ed_attached) ka_v3_view_focus(0);
            return 0;
        default: break;
        }
    } else if (hwnd == g_ui_hidden) {
        switch (msg) {
        case KA_WM_ED_OPEN:  wk_editor_open_now();  SetEvent(g_ui_done); return 0;
        case KA_WM_ED_CLOSE: ka_v3_stage(-30); wk_editor_close_now(0); ka_v3_stage(-31); SetEvent(g_ui_done); return 0;
        case KA_WM_JOB: {
            void (*fn)(void) = g_ui_job;
            ka_v3_stage(-40);
            if (fn) fn();
            ka_v3_stage(-41);
            SetEvent(g_ui_done);
            return 0;
        }
        default: break;
        }
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

static uint32_t __stdcall ka_ui_main(void* arg) {
    static const uint16_t k_ole32[] = {'o','l','e','3','2','.','d','l','l',0};
    ka_wndclass wc;
    void* ole, *fn, *hinst;
    (void)arg;
    /* 插件界面会碰系统对象（剪贴板/字体/拖放）。OleInitialize = STA + OLE 服务；
     * 没有它就退回 CoInitializeEx(APARTMENTTHREADED)。 */
    ole = LoadLibraryW(k_ole32);
    if (ole) {
        fn = GetProcAddress(ole, "OleInitialize");
        if (fn) ((int32_t (__stdcall*)(void*))fn)(0);
        else {
            fn = GetProcAddress(ole, "CoInitializeEx");
            if (fn) ((int32_t (__stdcall*)(void*, uint32_t))fn)(0, 2);
        }
    }
    ka_shm_wstr(g_ed_class, "KolidKaEditor");
    ka_shm_wstr(g_ed_title, "Kolid Instrument");
    ka_shm_wstr(g_ui_title, "Kolid Editor Host");
    hinst = GetModuleHandleW(0);
    memset(&wc, 0, sizeof(wc));
    wc.style = 0x0020;                                  /* CS_OWNDC */
    wc.lpfnWndProc = ka_ed_proc;
    wc.hInstance = hinst;
    wc.hCursor = LoadCursorW(0, (const uint16_t*)(int64_t)32512);   /* IDC_ARROW */
    wc.hbrBackground = (void*)(int64_t)6;               /* COLOR_WINDOW + 1 */
    wc.lpszClassName = g_ed_class;
    if (!RegisterClassW(&wc)) { SetEvent(g_ui_ready); return 0; }
    g_ui_hidden = CreateWindowExW(0, g_ed_class, g_ui_title, 0,
                                  0, 0, 0, 0, KA_HWND_MESSAGE, 0, hinst, 0);
    g_ui_tid = GetCurrentThreadId();
    SetEvent(g_ui_ready);
    for (;;) {
        ka_msg m;
        int32_t got = GetMessageW(&m, 0, 0, 0);
        if (got <= 0) break;
        TranslateMessage(&m);
        DispatchMessageW(&m);
    }
    return 0;
}

/** 起 UI 线程（一次）。0 = 隐藏窗口已就绪。 */
static int32_t ka_ed_ensure(void) {
    if (g_ui_started) return g_ui_hidden ? 0 : -4;
    if (!g_ui_ready) {
        g_ui_ready = CreateEventW(0, 0, 0, 0);
        g_ui_done = CreateEventW(0, 0, 0, 0);
        if (!g_ui_ready || !g_ui_done) return -1;
    }
    {   void* th = CreateThread(0, 0, ka_ui_main, 0, 0, 0);
        if (!th) return -2;
        CloseHandle(th);
    }
    g_ui_started = 1;
    if (WaitForSingleObject(g_ui_ready, 5000) != KA_WAIT_OBJECT_0) return -3;
    if (!g_ui_hidden) return -4;
    return 0;
}

/** 等 UI 线程做完一次开/关。0 = 做完了，-1 = 超时。 */
static int32_t ka_wait_ui_done(uint32_t ms) {
    return WaitForSingleObject(g_ui_done, ms) == 0 ? 0 : -1;
}

/** 开编辑器。0 = 窗口已经显示；负数见各步（-21 超时 = 插件界面造不出来）。
 *  已经开着的再点一次 = 抬到前台（用户点 Edit 的意图就是"让我看见它"）。 */
static int32_t ka_ed_open(void) {
    int32_t rc;
    uint32_t ms;
    if (!g_v3.ctrl) return -5;
    /* 已经站在 UI 线程上（插件 API 都跑在这条线程）就直接干，别给自己发消息等自己。 */
    if (g_ui_tid && g_ui_tid == GetCurrentThreadId()) {
        g_ui_rc = -100;
        wk_editor_open_now();
        return (int32_t)g_ui_rc;
    }
    rc = ka_ed_ensure();
    if (rc != 0) return rc - 10;
    g_ui_rc = -100;
    ResetEvent(g_ui_done);
    if (!PostMessageW(g_ui_hidden, KA_WM_ED_OPEN, 0, 0)) return -20;
    /* 只是抬前台是瞬时的，给 2 秒就够；真造窗口才等满 15 秒 —— 别让"抬一下"卡住宿主。 */
    ms = g_ed_open ? 2000 : 15000;
    if (ka_wait_ui_done(ms) != 0) return -21;
    return (int32_t)g_ui_rc;
}

static int32_t ka_ed_close(void) {
    if (!g_ed_open) return 0;
    if (g_ui_tid && g_ui_tid == GetCurrentThreadId()) {
        wk_editor_close_now(0);
        return 0;
    }
    if (!g_ui_hidden) return -1;
    ResetEvent(g_ui_done);
    if (!PostMessageW(g_ui_hidden, KA_WM_ED_CLOSE, 0, 0)) return -2;
    if (ka_wait_ui_done(5000) != 0) return -3;
    return 0;
}

/** 让 UI 线程替我们跑一段插件 API。0 = 跑完了，-1 = 超时，-2/-3 = UI 线程起不来/投递失败。
 *
 * 为什么插件 API 必须压在 UI 线程：Kontakt 7 的界面是 Qt 6，createView 建出来的子窗口
 * 绑着实例化它的那个线程的事件分发器。实例化在 worker 主线程、createView 在 UI 线程时，
 * 界面画不出来（强制 UpdateWindow 直接死锁），关闭也永远等不到回执。真宿主都把实例化
 * 和界面放在同一条"主线程"上，只有 process() 走音频线程 —— 这里照做。
 *
 * 等待期间主线程替它拍心跳：宿主靠 s->beat 不变来判 -92（DEAD）。 */
static int32_t ka_ui_run(void (*fn)(void), uint32_t ms) {
    uint32_t t0;
    if (g_ui_tid && g_ui_tid == GetCurrentThreadId()) { fn(); return 0; }
    if (ka_ed_ensure() != 0) return -2;
    g_ui_job = fn;
    ResetEvent(g_ui_done);
    if (!PostMessageW(g_ui_hidden, KA_WM_JOB, 0, 0)) return -3;
    t0 = GetTickCount();
    for (;;) {
        uint32_t used = GetTickCount() - t0;
        uint32_t left = used >= ms ? 0 : ms - used;
        if (WaitForSingleObject(g_ui_done, left) == 0) return 0;
        if (g_v3_shm) g_v3_shm->beat = g_v3_shm->beat + 1;
        if (used >= ms) return -1;
    }
}


/* ── 文本回执的拼装（原来在 KolidAudio 的导出里，现在宿主不碰插件了，搬到这里） ─────────────── */

static void wk_put_num(char* b, int* o, int cap, int v) {
    int d = 0, t[12], k;
    if (*o >= cap - 1) return;
    if (v < 0) { b[(*o)++] = '-'; v = -v; }
    do { t[d++] = v % 10; v /= 10; } while (v && d < 12);
    for (k = d - 1; k >= 0; --k) if (*o < cap - 1) b[(*o)++] = (char)('0' + t[k]);
}
static void wk_put_str(char* b, int* o, int cap, const char* s) {
    while (*s && *o < cap - 1) b[(*o)++] = *s++;
}
static void wk_put_ch(char* b, int* o, int cap, char c) {
    if (*o < cap - 1) b[(*o)++] = c;
}

static void wk_text_factory(char* b, int cap) {
    int o = 0, i;
    wk_put_str(b, &o, cap, g_v3_fi.vendor);
    wk_put_ch(b, &o, cap, '|');
    wk_put_str(b, &o, cap, g_v3_fi.url);
    wk_put_ch(b, &o, cap, '|');
    wk_put_str(b, &o, cap, g_v3_fi.email);
    wk_put_ch(b, &o, cap, '|');
    for (i = 0; i < 12; ++i) wk_put_ch(b, &o, cap, (char)('0' + ((g_v3_fi.flags >> (4 * (11 - i))) & 15)));
    b[o] = 0;
}

static void wk_text_class(char* b, int cap, int idx) {
    const ka_class_info* ci;
    int o = 0;
    if (idx < 0 || idx >= g_v3_ncls) { b[0] = 0; return; }
    ci = g_v3_cls + idx;
    ka_v3_hex(b, ci->cid, 16);
    o = 32;
    wk_put_ch(b, &o, cap, '|');
    wk_put_num(b, &o, cap, ci->cardinality);
    wk_put_ch(b, &o, cap, '|');
    wk_put_str(b, &o, cap, ci->category);
    wk_put_ch(b, &o, cap, '|');
    wk_put_str(b, &o, cap, ci->name);
    b[o] = 0;
}

static void wk_text_info(char* b, int cap) {
    int o = 0;
    wk_put_num(b, &o, cap, g_v3.n_in_bus);   wk_put_ch(b, &o, cap, '|');
    wk_put_num(b, &o, cap, g_v3.n_out_bus);  wk_put_ch(b, &o, cap, '|');
    wk_put_num(b, &o, cap, g_v3.n_in_ch);    wk_put_ch(b, &o, cap, '|');
    wk_put_num(b, &o, cap, g_v3.n_out_ch);   wk_put_ch(b, &o, cap, '|');
    wk_put_num(b, &o, cap, g_v3.n_ev_in);    wk_put_ch(b, &o, cap, '|');
    wk_put_num(b, &o, cap, (int)g_v3.setup.sampleRate);
    b[o] = 0;
}

/* ── 控制器 / 参数 / 程序列表（第三层回执） ─────────────────────────────────────────────── */

static void wk_put_u32(char* b, int* o, int cap, uint32_t v) {
    char t[12];
    int d = 0, k;
    do { t[d++] = (char)('0' + (int)(v % 10)); v /= 10; } while (v && d < 12);
    for (k = d - 1; k >= 0; --k) wk_put_ch(b, o, cap, t[k]);
}

/* 大小写不敏感的子串匹配：PSCAN 用它认 "program"/"slot" 这类标题。 */
static int wk_has_ci(const char* hay, const char* needle) {
    int i, j;
    if (!needle[0]) return 1;
    for (i = 0; hay[i]; ++i) {
        for (j = 0; needle[j]; ++j) {
            char a = hay[i + j], c = needle[j];
            if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
            if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
            if (!a || a != c) break;
        }
        if (!needle[j]) return 1;
    }
    return 0;
}

/** 一行参数：id|flags|steps|unit|title|short|units。返回 0 表示这个下标取不到。 */
static int wk_text_param(char* b, int cap, int idx) {
    ka_param_info pi;
    char title[384], shortt[384], units[128];
    int o = 0;
    if (ka_v3_param_info(idx, &pi) != 0) { b[0] = 0; return 0; }
    ka_v3_utf8(pi.title, title, (int)sizeof(title));
    ka_v3_utf8(pi.short_title, shortt, (int)sizeof(shortt));
    ka_v3_utf8(pi.units, units, (int)sizeof(units));
    wk_put_u32(b, &o, cap, pi.id);                 wk_put_ch(b, &o, cap, '|');
    wk_put_num(b, &o, cap, pi.flags);              wk_put_ch(b, &o, cap, '|');
    wk_put_num(b, &o, cap, pi.step_count);         wk_put_ch(b, &o, cap, '|');
    wk_put_num(b, &o, cap, pi.unit_id);            wk_put_ch(b, &o, cap, '|');
    wk_put_str(b, &o, cap, title);                 wk_put_ch(b, &o, cap, '|');
    wk_put_str(b, &o, cap, shortt);                wk_put_ch(b, &o, cap, '|');
    wk_put_str(b, &o, cap, units);
    b[o] = 0;
    return 1;
}

/** 单元与程序列表：每个单元一行 "u|id|parent|plist|name"，每个列表一行 "p|id|count|name"。 */
static void wk_text_units(char* b, int cap) {
    int o = 0, i, n = ka_v3_unit_count(), m = ka_v3_proglist_count();
    for (i = 0; i < n && o < cap - 8; ++i) {
        ka_unit_info ui;
        char name[192];
        if (ka_v3_unit_info(i, &ui) != 0) continue;
        ka_v3_utf8(ui.name, name, (int)sizeof(name));
        if (o) wk_put_ch(b, &o, cap, '\n');
        wk_put_ch(b, &o, cap, 'u');                 wk_put_ch(b, &o, cap, '|');
        wk_put_num(b, &o, cap, ui.id);              wk_put_ch(b, &o, cap, '|');
        wk_put_num(b, &o, cap, ui.parent_id);       wk_put_ch(b, &o, cap, '|');
        wk_put_num(b, &o, cap, ui.program_list_id); wk_put_ch(b, &o, cap, '|');
        wk_put_str(b, &o, cap, name);
    }
    for (i = 0; i < m && o < cap - 8; ++i) {
        ka_proglist_info pl;
        char name[192];
        if (ka_v3_proglist_info(i, &pl) != 0) continue;
        ka_v3_utf8(pl.name, name, (int)sizeof(name));
        if (o) wk_put_ch(b, &o, cap, '\n');
        wk_put_ch(b, &o, cap, 'p');                 wk_put_ch(b, &o, cap, '|');
        wk_put_num(b, &o, cap, pl.id);              wk_put_ch(b, &o, cap, '|');
        wk_put_num(b, &o, cap, pl.program_count);   wk_put_ch(b, &o, cap, '|');
        wk_put_str(b, &o, cap, name);
    }
    b[o] = 0;
}

/* ── 通道 ──────────────────────────────────────────────────────────────────────────────────── */

static ka_shm* g_shm = 0;
static void*   g_ev_done = 0;

/* ── 渲染：只按宿主填好的事件槽出声 ─────────────────────────────────────────────────────────
 *
 * 调度（排哪一音、什么时候收、seek 后从哪接）全在宿主那边做：它同时知道走带位置和音符表，
 * 每块把 worker 提前量覆盖到的未来块写成事件槽（ka_shm.h 的 evs[]）。这里**不再**读音符表、
 * 不再自己记"哪些音还按着" —— 一份游标、一份收声语义，暂停/复播/seek 不可能再分叉。
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/* 试听音（暂停时点 ♪）：note-on 当场发，wk_aud_life 数到 0 再发 note-off。
 * 倒计时按"渲了几块"走 —— 宿主音频线程那条路上只准填事件，不能等命令回执。 */
static int32_t wk_aud_life = -1;
static int32_t wk_aud_ch = 0, wk_aud_pitch = 0;
/** 已见过的收声序号（宿主暂停 / seek 时 +1）。 */
static int32_t wk_flush_seen = 0;

/** 全通道全音收声：panic / 关插件 / 换音色用。正常播放的收声走事件槽，不走这里。 */
static void wk_notes_off_all(void) {
    int i;
    g_v3.evq.count = 0;
    for (i = 0; i < 128; ++i) ka_v3_note(0, 0, i, 0, 0);
}

/** 这一块落在时钟的哪一帧：锚点（第 tr_read 块 = tr_pos 帧）往后外推。 */
static int64_t wk_block_pos(ka_shm* s) {
    int32_t k, r = s->tr_read;
    int64_t base = 0;
    for (k = 0; k < 3; ++k) {
        int32_t r2;
        base = ((int64_t)s->tr_pos_hi << 32) | (uint32_t)s->tr_pos_lo;
        r2 = s->tr_read;
        if (r2 == r) break;
        r = r2;
    }
    return base + (int64_t)(s->w - r) * (int64_t)s->block;
}

static void wk_render(ka_shm* s) {
    const ka_shm_evblock* eb;
    int32_t rc, playing, aud, mon, ready, i;
    int64_t fr, pos;

    if (!s->live || !s->opened) return;
    if (ka_shm_pending(s) <= 0) return;                  /* ring 满了：宿主没在取，别白干 */

    playing = s->tr_playing ? 1 : 0;
    aud = (s->aud_blocks > 0);
    /* 插件窗口开着（宿主写的 ed_mon）= 用户正在它自己的界面里试音。那边的键盘/试听按钮
     * 不会经过我们，声音只从 process() 出来 —— 暂停时不渲，界面里点了就是一片安静。 */
    mon = (!playing && s->ed_mon) ? 1 : 0;

    pos = wk_block_pos(s);

    /* 宿主的收声信号（暂停 / seek）先看：这条必须在任何早退之前 —— 停着的时候也得把
     * evq 里的 note-off 交给 process()，否则"按了暂停声音还在"。 */
    if (s->flush_seq != wk_flush_seen) {
        wk_flush_seen = s->flush_seq;
        wk_notes_off_all();
    }

    eb = &s->evs[s->w % KA_SHM_EV_SLOTS];
    ready = (eb->gen == s->sched_gen && eb->w == s->w) ? 1 : 0;

    if (!playing && !aud && !mon) {
        /* 停着：只把队列里的事件交给 process()（输出没人要 —— ring 正被宿主抽干）。 */
        if (g_v3.evq.count > 0) ka_v3_render(0, s->block, pos);
        s->peak = 0;
        return;
    }
    /* 界面里试音要跟手：暂停时最多压 3 块（≈32ms）待取，别像播放那样提前塞满 8 块。 */
    if (mon && ka_shm_ready(s) >= 3) return;
    if (!playing && aud) s->aud_blocks = s->aud_blocks - 1;
    if (wk_aud_life > 0) {
        if (--wk_aud_life == 0) ka_v3_note(0, wk_aud_ch, wk_aud_pitch, 0, 0);
    }

    /* 宿主排好的事件：原样交给 process()（块内偏移由 ka_v3_note 的最后一个参数带）。
     * 槽的代数对不上 = seek/换表之前的旧槽，当没有事件。 */
    if (ready) {
        for (i = 0; i < eb->count; ++i) {
            const ka_shm_event* e = &eb->ev[i];
            ka_v3_note(e->on, 0, e->note, e->vel, e->off);
        }
    }

    rc = ka_v3_render(ka_shm_block_at(s, s->w), s->block, pos);
    if (rc != 0) return;                                 /* 没开/插件拒绝：这一块不推进 w */
    s->peak = (int32_t)g_v3.peak;
    fr = (int64_t)g_v3.frames_done;
    s->frames_hi = (int32_t)(fr >> 32);
    s->frames_lo = (int32_t)(fr & 0x7FFFFFFFu);
    s->w = s->w + 1;                                     /* 最后一步才公布这一块 */
}

static void wk_hex64(char* d, uint64_t v) {
    static const char* HEX = "0123456789ABCDEF";
    int i;
    for (i = 15; i >= 0; --i) { d[i] = HEX[v & 15]; v >>= 4; }
}
static void wk_veh_note(const char* tag, uint64_t v) {
    char* t;
    int o = 0;
    if (!g_v3_shm) return;
    t = g_v3_shm->text;
    while (t[o] && o < KA_SHM_TEXT - 24) ++o;
    if (o) t[o++] = ' ';
    while (*tag && o < KA_SHM_TEXT - 20) t[o++] = *tag++;
    t[o++] = '=';
    wk_hex64(t + o, v);
    o += 16;
    t[o] = 0;
}

/* 插件里 AV 时留痕：EXCEPTION_POINTERS = {EXCEPTION_RECORD*, CONTEXT*}，
 * EXCEPTION_RECORD = {code, flags, record*, address, nparams, ..., info[0]=读/写, info[1]=访问地址}。
 * 写 iv[9]（访问地址低 32 位）与 iv[12..14] 后照常让进程死 —— 这里只解决"死得不明不白"，
 * 不吞异常。iv[9] 为 0 且异常码 0xC0000005 基本就是空指针解引用。
 * 只记第一次 AV：后面往往还有"退出路上的第二次异常"，会把现场盖掉。
 * 另把线程号与栈上落在插件模块里的返回地址（RVA）追加进 text —— 这是唯一的来路。 */
static int32_t g_veh_seen = 0;
static int32_t __stdcall wk_veh(void* info) {
    void** ip = (void**)info;
    const uint32_t* rec = (ip && ip[0]) ? (const uint32_t*)ip[0] : 0;
    if (g_v3_shm && rec && rec[0] == 0xC0000005u && !g_veh_seen) {
        uint64_t addr = ((const uint64_t*)rec)[2];
        uint64_t acc = ((const uint64_t*)rec)[5];
        g_veh_seen = 1;
        g_v3_shm->iv[9] = (int32_t)(uint32_t)(acc & 0xFFFFFFFFu);
        g_v3_shm->iv[12] = (int32_t)(uint32_t)(addr & 0xFFFFFFFFu);
        g_v3_shm->iv[13] = (int32_t)(uint32_t)(addr >> 32);
        g_v3_shm->iv[14] = (int32_t)rec[0];
        if (ip[1]) {
            /* winnt.h 的 AMD64 CONTEXT：Rcx 0x80、Rdx 0x88、Rsp 0x98、Rip 0xF8。
             * （早先按 0x90/0x98/0xA8/0x108 取，整体偏了 0x10 —— Rip 读到 XMM 区才一直是 0。） */
            const uint64_t* ctx = (const uint64_t*)ip[1];
            uint64_t rsp = ctx[0x98 / 8], rip = ctx[0xF8 / 8];
            uint64_t mod = ((uint64_t)(uint32_t)g_v3_shm->iv[10])
                         | ((uint64_t)(uint32_t)g_v3_shm->iv[11] << 32);
            static const int REG_OFF[12] = { 0x78, 0x90, 0x98, 0xA0, 0xA8, 0xB0,
                                             0xB8, 0xC0, 0xC8, 0xD0, 0xD8, 0xE0 };
            int k;
            wk_veh_note("tid", (uint64_t)GetCurrentThreadId());
            wk_veh_note("rip", rip);
            /* rax rbx rsp rbp rsi rdi r8 r9 r10 r11 r12 r13 */
            for (k = 0; k < 12; ++k) wk_veh_note("c", ctx[REG_OFF[k] / 8]);
            wk_veh_note("rcx", ctx[0x80 / 8]);
            wk_veh_note("rdx", ctx[0x88 / 8]);
            /* rax 常常是那个被解引用的静态对象（本次是 thread_local）：把它的前几格
             * 倒出来 —— [0] 是 vtable，vtable[-1] 是 RTTI，离线能查出类名。
             * g38/epo 是 MSVC magic static 的两把锁：静态量自己的关卡字对不对比本线程
             * TLS 块末尾的 epoch，就能分清"构造函数到底跑没跑"。 */
            {   uint64_t obj = ctx[0x78 / 8];
                if (obj >= mod && obj < mod + 0x08000000u) {
                    for (k = 0; k < 6; ++k) wk_veh_note("v", ((const uint64_t*)obj)[k]);
                    wk_veh_note("g38", ((const uint64_t*)obj)[0x38 / 8]);
                    wk_veh_note("g30", ((const uint64_t*)obj)[0x30 / 8]);
                    wk_veh_note("g28", ((const uint64_t*)obj)[0x28 / 8]);
                    if (g_v3_tls_idx != 0xFFFFFFFFu) {
                        void** arr = (void**)__readgsqword(0x58);
                        unsigned char* blk = arr ? (unsigned char*)arr[g_v3_tls_idx] : 0;
                        if (blk && g_v3_tls_sz >= 4)
                            wk_veh_note("epo", *(uint32_t*)(blk + g_v3_tls_sz - 4));
                    }
                }
            }
            for (k = 0; k < 96; ++k) {
                uint64_t v = ((const uint64_t*)rsp)[k];
                if (v >= mod && v < mod + 0x08000000u) wk_veh_note("r", v - mod);
            }
        }
    }
    return 0;                                   /* EXCEPTION_CONTINUE_SEARCH */
}

/* 这些命令碰的是插件对象模型（实例化、参数、状态、界面），必须和实例化跑在同一条线程上。
 * 见 ka_ui_run 的注释。其余命令只读写我们自己缓存的结构 / 音频线程那套，留在主线程。 */
static int32_t wk_cmd_on_ui(int32_t c) {
    switch (c) {
    case KA_CMD_SCAN:      case KA_CMD_OPEN:      case KA_CMD_CLOSE:
    case KA_CMD_PROBE:     case KA_CMD_BUSES:     case KA_CMD_PCOUNT:
    case KA_CMD_PINFO:     case KA_CMD_PSET:      case KA_CMD_PGET:
    case KA_CMD_PSCAN:     case KA_CMD_UNITS:     case KA_CMD_PROGNAME:
    case KA_CMD_PROGINFO:  case KA_CMD_STATE_LOAD: case KA_CMD_STATE_SAVE:
        return 1;
    default:
        return 0;
    }
}

static int wk_cmd_body(ka_shm* s);

static void wk_shutdown_job(void) {
    if (g_ed_open) ka_ed_close();
    if (g_v3.ctrl) ka_v3_close();
}

static ka_shm* g_job_shm = 0;
static int32_t g_job_rc = 1;
static void wk_cmd_job(void) { g_job_rc = wk_cmd_body(g_job_shm); }

/* 返回 0 = 收到 QUIT，该退了。 */
static int wk_cmd(ka_shm* s) {
    int32_t c = s->cmd, rc, ms;
    if (!wk_cmd_on_ui(c)) return wk_cmd_body(s);
    ms = (c == KA_CMD_OPEN || c == KA_CMD_SCAN
          || c == KA_CMD_STATE_LOAD || c == KA_CMD_STATE_SAVE) ? 55000 : 4000;
    g_job_shm = s;
    g_job_rc = 1;
    rc = ka_ui_run(wk_cmd_job, (uint32_t)ms);
    if (rc == 0) return g_job_rc;
    /* 超时：UI 线程还卡在里面。把命令位收掉，否则下一条命令会和它抢同一块共享内存。 */
    s->ret = (rc == -1) ? -93 : -91;
    s->cmd = KA_CMD_NONE;
    SetEvent(g_ev_done);
    return 1;
}

static int wk_cmd_body(ka_shm* s) {
    int32_t c = s->cmd;
    int i;
    s->ret = 0;
    s->text[0] = 0;
    for (i = 0; i < KA_SHM_IV; ++i) s->iv[i] = 0;

    switch (c) {
    case KA_CMD_PING:
        s->ret = 1;
        break;
    case KA_CMD_SCAN:
        s->ret = ka_v3_scan(s->has_path ? s->path : 0);
        break;
    case KA_CMD_OPEN:
        ka_ed_close();               /* 编辑器挂在旧 controller 上，必须先拆 */
        if (s->rate > 0) g_rate = s->rate;
        g_veh_seen = 0;
        wk_notes_off_all();
        wk_aud_life = -1;
        s->aud_blocks = 0;
        s->ret = ka_v3_open(s->has_path ? s->path : 0, s->a0, s->a1);
        s->opened = (s->ret == 0) ? 1 : 0;
        /* 帧计数要跟着归零：它只在渲染时才被推进，不开这一下宿主会一直读到上一轮的旧值
         * （"重开之后 frames 没归零"就是这么来的）。 */
        s->peak = 0;
        s->frames_hi = 0; s->frames_lo = 0;
        break;
    case KA_CMD_CLOSE:
        ka_ed_close();
        wk_notes_off_all();
        wk_aud_life = -1;
        s->aud_blocks = 0;
        ka_v3_close();
        s->opened = 0;
        s->live = 0;
        s->w = 0; s->r = 0;
        s->peak = 0;
        s->frames_hi = 0; s->frames_lo = 0;
        break;
    case KA_CMD_NOTE:
        s->ret = ka_v3_note(s->a0 ? 1 : 0, s->a1, s->a2, s->a3, 0);
        break;
    case KA_CMD_CLASS:
        wk_text_class(s->text, KA_SHM_TEXT, s->a0);
        s->ret = 1;
        break;
    case KA_CMD_CID:
        if (s->a0 >= 0 && s->a0 < g_v3_ncls) {
            for (i = 0; i < 16; ++i) s->cid[i] = g_v3_cls[s->a0].cid[i];
            s->ret = 16;
        } else s->ret = 0;
        break;
    case KA_CMD_FACTORY:
        wk_text_factory(s->text, KA_SHM_TEXT);
        s->ret = 1;
        break;
    case KA_CMD_BUSES:
        s->ret = ka_v3_buses(s->text, KA_SHM_TEXT);
        break;
    case KA_CMD_INFO:
        wk_text_info(s->text, KA_SHM_TEXT);
        s->ret = 1;
        break;
    case KA_CMD_STAGE:
        s->iv[0] = (int32_t)g_v3_stage;
        s->ret = (int32_t)g_v3_last_rc;
        break;
    case KA_CMD_EVENTS:
        s->iv[0] = (int32_t)g_v3_ev_counted;
        s->iv[1] = (int32_t)g_v3_ev_pulled;
        s->iv[2] = (int32_t)g_v3.evq.count;
        s->ret = 3;
        break;
    case KA_CMD_QUEUE: {
        const int32_t* w = (const int32_t*)g_v3.ev_items;
        s->iv[0] = (int32_t)g_v3.evq.count;
        s->iv[1] = (int32_t)((uint64_t)(uint64_t)g_v3.evq.items & 0xFFFFFFFFu);
        for (i = 0; i < 12 && i + 2 < KA_SHM_IV; ++i) s->iv[i + 2] = w[i];
        s->ret = 14;
        break;
    }
    case KA_CMD_STATE:
        s->ret = (int32_t)g_v3_ncls;
        s->iv[0] = (int32_t)g_v3_err;
        s->iv[1] = s->opened;
        break;
    case KA_CMD_DBG:
        wk_put_str(s->text, 0, KA_SHM_TEXT, g_v3_dbg);
        s->ret = 1;
        break;
    case KA_CMD_PROBE:
        s->ret = ka_v3_probe_create(s->has_path ? s->path : 0, s->a0, s->a1);
        break;
    case KA_CMD_ADDR:
        if (!g_v3.out_ch_ptr || g_v3.n_out_ch <= 0) s->ret = 0;
        else s->ret = (int32_t)((uint64_t)(uint64_t)g_v3.out_ch_ptr[0] & 0xFFFFFFFFu);
        break;
    case KA_CMD_RENDER: {
        int32_t n = s->a0;
        int64_t fr;
        if (n <= 0) n = s->block;
        if (n > KA_SHM_BLOCK) n = KA_SHM_BLOCK;
        s->ret = ka_v3_render(s->rout, n, g_v3.frames_done);
        if (s->ret == 0) {
            s->peak = (int32_t)g_v3.peak;
            fr = (int64_t)g_v3.frames_done;
            s->frames_hi = (int32_t)(fr >> 32);
            s->frames_lo = (int32_t)(fr & 0x7FFFFFFFu);
        }
        break;
    }
    case KA_CMD_CTRL: {
        int o = 0;
        s->ret = g_v3.ctrl_ok;
        s->iv[0] = g_v3.ctrl_rc;
        s->iv[1] = (int32_t)g_chandler.restarts;
        s->iv[2] = (int32_t)g_chandler.restart_flags;
        s->iv[3] = g_v3_hostreq_n;
        s->iv[4] = g_v3.n_params;
        s->iv[5] = g_v3.unitinfo ? 1 : 0;
        s->iv[6] = g_v3.cp_comp ? 1 : 0;
        s->iv[7] = g_v3.cp_ctrl ? 1 : 0;
        wk_put_str(s->text, &o, KA_SHM_TEXT, g_v3_hostreq);
        wk_put_ch(s->text, &o, KA_SHM_TEXT, '|');
        wk_put_num(s->text, &o, KA_SHM_TEXT, (int)g_v3_ctrl_step);
        s->text[o] = 0;
        break;
    }
    case KA_CMD_PCOUNT:
        s->ret = ka_v3_param_count();
        break;
    case KA_CMD_PINFO:
        s->ret = wk_text_param(s->text, KA_SHM_TEXT, s->a0);
        break;
    case KA_CMD_PSET:
        s->ret = ka_v3_param_set((uint32_t)s->a0, (double)s->a1 / 1000000.0);
        break;
    case KA_CMD_PGET:
        s->ret = (int32_t)(ka_v3_param_get((uint32_t)s->a0) * 1000000.0 + 0.5);
        break;
    case KA_CMD_PSCAN: {
        int32_t n = ka_v3_param_count();
        int o = 0, hits = 0;
        if (s->a0 > i) i = s->a0;
        for (; i < n && hits < s->a1; ++i) {
            ka_param_info pi;
            char title[256];
            if (ka_v3_param_info(i, &pi) != 0) continue;
            ka_v3_utf8(pi.title, title, (int)sizeof(title));
            if (!(pi.flags & KA_PARAM_IS_PGM_CHANGE)
                && !wk_has_ci(title, "program") && !wk_has_ci(title, "slot")) continue;
            if (hits) wk_put_ch(s->text, &o, KA_SHM_TEXT, '\n');
            wk_put_num(s->text, &o, KA_SHM_TEXT, i);  wk_put_ch(s->text, &o, KA_SHM_TEXT, '|');
            wk_put_u32(s->text, &o, KA_SHM_TEXT, pi.id); wk_put_ch(s->text, &o, KA_SHM_TEXT, '|');
            wk_put_num(s->text, &o, KA_SHM_TEXT, pi.flags); wk_put_ch(s->text, &o, KA_SHM_TEXT, '|');
            wk_put_num(s->text, &o, KA_SHM_TEXT, pi.unit_id); wk_put_ch(s->text, &o, KA_SHM_TEXT, '|');
            wk_put_str(s->text, &o, KA_SHM_TEXT, title);
            hits++;
        }
        s->iv[0] = i;
        s->ret = hits;
        break;
    }
    case KA_CMD_UNITS:
        wk_text_units(s->text, KA_SHM_TEXT);
        s->ret = ka_v3_unit_count();
        s->iv[0] = ka_v3_proglist_count();
        break;
    case KA_CMD_PROGNAME:
        s->ret = ka_v3_program_name(s->a0, s->a1, s->text, KA_SHM_TEXT);
        break;
    case KA_CMD_PROGINFO: {
        ka_proglist_info pl;
        int32_t l, n = ka_v3_proglist_count();
        s->ret = 0;
        for (l = 0; l < n; ++l) {
            if (ka_v3_proglist_info(l, &pl) != 0) continue;
            if (pl.id == s->a0) { s->ret = pl.program_count; break; }
        }
        break;
    }
    case KA_CMD_LIVE:
        s->live = s->a0 ? 1 : 0;
        if (!s->live) {
            wk_notes_off_all();
            wk_aud_life = -1;
            s->aud_blocks = 0;
            s->w = 0; s->r = 0;
        }
        break;
    case KA_CMD_STATE_LOAD: {
        int64_t bytes = 0;
        s->ret = ka_v3_state_load(s->has_path ? s->path : 0, &bytes);
        s->iv[0] = g_v3_state_rc[0];
        s->iv[1] = g_v3_state_rc[1];
        s->iv[2] = g_v3_state_rc[2];
        s->iv[3] = (int32_t)bytes;
        /* 换了音色 = 换了一次"时间"：插件内部的采样流全变了，正在响的音必须收掉。 */
        wk_notes_off_all();
        wk_aud_life = -1;
        s->aud_blocks = 0;
        break;
    }
    case KA_CMD_STATE_SAVE:
        s->ret = ka_v3_state_save(s->has_path ? s->path : 0);
        break;
    case KA_CMD_NOTES_OFF:
        wk_notes_off_all();
        s->ret = 1;
        break;
    case KA_CMD_AUDITION: {
        int32_t blocks = s->a3;
        if (blocks <= 0) blocks = 1;
        if (wk_aud_life > 0) ka_v3_note(0, wk_aud_ch, wk_aud_pitch, 0, 0);   /* 连点 ♪：前一个先收 */
        wk_aud_ch = s->a2 < 0 ? 0 : (s->a2 > 15 ? 15 : s->a2);
        wk_aud_pitch = s->a0 < 0 ? 0 : (s->a0 > 127 ? 127 : s->a0);
        ka_v3_note(1, wk_aud_ch, wk_aud_pitch, s->a1, 0);
        s->aud_blocks = blocks;
        wk_aud_life = blocks;
        s->ret = 1;
        break;
    }
    case KA_CMD_EDITOR_OPEN:
        s->ret = ka_ed_open();
        s->iv[0] = g_ed_open;
        s->iv[1] = g_ed_w;
        s->iv[2] = g_ed_h;
        break;
    case KA_CMD_EDITOR_CLOSE:
        s->ret = ka_ed_close();
        s->iv[0] = g_ed_open;
        break;
    case KA_CMD_EDITOR_STATE:
        s->ret = g_ed_open;
        s->iv[0] = g_ed_closed;
        s->iv[1] = g_ed_w;
        s->iv[2] = g_ed_h;
        break;
    case KA_CMD_QUIT:
        break;
    default:
        s->ret = -1;
        break;
    }

    s->cmd = KA_CMD_NONE;
    SetEvent(g_ev_done);
    return (c == KA_CMD_QUIT) ? 0 : 1;
}

int __stdcall kaMain(void) {
    uint16_t nm[160], evc[176], evd[176], arg[64];
    uint16_t* cl;
    uint16_t* last = 0;
    uint16_t* p;
    int q = 0, i;
    uint64_t bytes;
    void* hm;
    void* ev_cmd;
    ka_shm* s;
    int32_t hb = -1, stall = 0;

    /* 真宿主（Cubase / Studio One / Reaper）启动时都把 COM 初始化好。插件的全局单例里
     * 会去拿系统对象（剪贴板、拖放、字体、任务栏）；没初始化过 COM 时这些调用直接失败，
     * 单例就带着空指针活到 initialize 收尾 —— HALion 与 Kontakt 都炸在这种空指针上。
     * ole32 不进 import 表（build.ps1 没有它的 .lib），运行时按名字取；取不到就作罢。 */
    {   void* ole = LoadLibraryW((const uint16_t*)L"ole32.dll");
        void* f = ole ? GetProcAddress(ole, "CoInitializeEx") : 0;
        if (f) ((int32_t (__stdcall*)(void*, uint32_t))f)(0, 2 /* COINIT_APARTMENTTHREADED */);
    }

    /* 命令行最后一个 token 就是共享内存名（我们自己起的，不含空格）。
     * exe 路径可能带引号也可能带空格，但从末尾往前找第一个空格总是安全的。 */
    cl = GetCommandLineW();
    for (p = cl; *p; ++p) {
        if (*p == (uint16_t)'"') q = !q;
        else if (*p == (uint16_t)' ' && !q) last = p;
    }
    p = last ? last + 1 : cl;
    for (i = 0; i < 63 && p[i]; ++i) arg[i] = p[i];
    arg[i] = 0;
    if (!last || arg[0] == 0) ka_shm_wstr(arg, "default");

    ka_shm_names(arg, nm, evc, evd);

    bytes = ka_shm_bytes(KA_SHM_BLOCK, KA_SHM_RING);
    hm = CreateFileMappingW((void*)(int64_t)-1, 0, KA_PAGE_READWRITE,
                            (uint32_t)(bytes >> 32), (uint32_t)(bytes & 0xFFFFFFFFu), nm);
    if (!hm) ExitProcess(2);
    /* **一个名字只准有一支 worker。** 两支进程连同一块共享内存 = 两件乐器同时弹同一串音
     * （听感就是重复音），而且后起身的那支马上会把共享内存 memset 掉，先来者的命令槽、
     * 走带锚点全被踩平。CreateFileMappingW 不为此报错：名字已存在时它返回的仍是有效句柄，
     * 只在 GetLastError 里留一句 —— 所以这一行必须紧跟创建，且必须排在 memset 之前。 */
    if (GetLastError() == KA_ERROR_ALREADY_EXISTS) ExitProcess(KA_WORKER_EXIT_TAG);
    s = (ka_shm*)MapViewOfFile(hm, KA_FILE_MAP_ALL_ACCESS, 0, 0, bytes);
    if (!s) ExitProcess(3);

    memset(s, 0, (uint64_t)bytes);
    s->magic = KA_SHM_MAGIC;
    s->abi = KA_SHM_ABI;
    s->rate = 48000;
    s->block = KA_SHM_BLOCK;
    s->ring_blocks = KA_SHM_RING;
    s->peak = 0;
    s->sched_gen = 1;            /* 槽里的 gen 从 0 起：不撞这一代之前一律作废 */
    s->beat = 1;                 /* 非 0 即"我活了"，宿主 attach 后先验这个 */
    s->worker_tid = (int32_t)GetCurrentThreadId();

    ev_cmd = CreateEventW(0, 0, 0, evc);   /* 自动复位：一次唤醒只对应一条命令 */
    g_ev_done = CreateEventW(0, 0, 0, evd);
    if (!ev_cmd || !g_ev_done) ExitProcess(4);

    g_shm = s;
    g_v3_shm = s;                /* 进度戳写 iv[15]（见 ka_vst3.h 的 ka_v3_trace） */
    AddVectoredExceptionHandler(1, wk_veh);

    for (;;) {
        s->beat = s->beat + 1;

        if (WaitForSingleObject(ev_cmd, 1) == KA_WAIT_OBJECT_0) {
            if (wk_cmd(s) == 0) break;
            continue;
        }
        /* 一圈把 ring 能塞的都塞满。只渲一块就回去等的话，WaitForSingleObject(1) 实际按
         * 系统定时器粒度（本机实测 ~15.6ms）睡，产能只有 ~63 块/秒 —— 顶不住 93.75 块/秒，
         * ring 永远见底（underrun 一路涨、播放时插件没声）。 */
        for (;;) {
            int32_t w0 = s->w;
            if (ka_shm_pending(s) <= 0) break;       /* 满了：等宿主取 */
            wk_render(s);
            if (s->w == w0) break;                   /* 没渲出东西（未播/未开/插件拒绝），别空转 */
        }

        /* 宿主没了就自己退：不留孤儿进程占着插件。5 秒没动静算走人了。 */
        if (s->host_beat == hb) {
            stall = stall + 1;
            if (stall > 5000) break;
        } else { hb = s->host_beat; stall = 0; }
    }

    /* 插件的拆解也得在实例化那条线程上做（Kontakt 的 Qt 对象过线程就崩）。 */
    if (s->opened || g_ed_open) {
        g_job_shm = s;
        ka_ui_run(wk_shutdown_job, 8000);
    }
    UnmapViewOfFile(s);
    CloseHandle(hm);
    ExitProcess(0);
    return 0;
}
