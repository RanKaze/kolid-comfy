/* ── KolidAudio ──────────────────────────────────────────────────────────────────────────────
 *
 * 原生发声引擎。声音不经过浏览器：这个 DLL 自己开声卡、自己跑音频线程、自己把样本写进设备。
 * 页面那边只负责「按了哪个键」和「现在第几帧」。
 *
 * 为什么不是 WASAPI：这台机器只装了 MSVC 编译器，没有 Windows SDK —— 没有 mmdeviceapi.h /
 * audioclient.h，也没有 ole32.lib。所以走 winmm 的 waveOut：纯 C 的推送式 API，7 个导出、
 * 两个结构体，可以像 KolidClock 那样手写声明 + 用 .def 造导入库。代价是延迟（4 块 × 512 帧
 * ≈ 43ms），换来零 SDK 依赖。试听够用。
 *
 * 线程纪律（照抄 music-learning 的 native-daw.md）：
 *   · 音频线程只做「填这块缓冲」，不等锁、不分配、不发 HTTP；
 *   · 不用设备回调（CALLBACK_NULL），在自己的线程里轮询 WHDR_DONE ——
 *     在驱动线程里跑我们的代码是最容易把整台机器卡住的做法；
 *   · 跨线程状态走几十纳秒的自旋锁，临界区里只有拷贝。
 *
 * 时间：位置**不由这里产生**。谁在第几帧，KolidClock 说了算；这里每块问一次「现在该播到哪」，
 * 然后按样本往前推，差得多就硬跳、差得少就不管。这是 music-learning 的反面教训 ——
 * 它让设备回调当唯一时钟；我们的唯一时钟已经在上游，这里绝不能长第二只。
 *
 * 合成：24 声部减法合成 + 按 GM 大类挑波形与包络。不用任何 CRT 数学函数（没有 UCRT），
 * 正弦查表、指数衰减用一阶近似 (1 - 1/(t*rate))、音高表递推 (×2^(1/12))。
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

#include <stdint.h>
#include "ka_sine.h"

int _fltused = 0;

/* ── memcpy / memset ─────────────────────────────────────────────────────────────────────────
 *
 * /NODEFAULTLIB 意味着它们不存在，而 /O2 一看见"整段 float 赋值"就会把循环换成一次 memcpy
 * （sfz_load_wav 里那次 16/24/32 位转换就是这么被逮到的：LNK2019 无法解析 memcpy）。
 * 所以自己给一份，并用 #pragma function 禁止编译器把这两个实现再优化回对自身的调用。
 * ──────────────────────────────────────────────────────────────────────────────────────────── */
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

/* ── 手写 API 声明（无 windows.h） ─────────────────────────────────────────────────────────── */

typedef struct {
    uint16_t wFormatTag;
    uint16_t nChannels;
    uint32_t nSamplesPerSec;
    uint32_t nAvgBytesPerSec;
    uint16_t nBlockAlign;
    uint16_t wBitsPerSample;
    uint16_t cbSize;
} WAVEFORMATEX;

/* x64 布局：8+4+4+8+4+4+8+8 = 48。别加 pack，默认对齐正好是它。 */
typedef struct WAVEHDR_S {
    char*             lpData;
    uint32_t          dwBufferLength;
    uint32_t          dwBytesRecorded;
    uint64_t          dwUser;
    uint32_t          dwFlags;
    uint32_t          dwLoops;
    struct WAVEHDR_S* lpNext;
    uint64_t          reserved;
} WAVEHDR;

/* wType 是 UINT，u.sample 紧跟其后在偏移 4 —— 写成 u64 会读到填充，位置永远是 0。 */
typedef struct {
    uint32_t wType;
    uint32_t sample;
    uint32_t pad[4];
} MMTIME;

__declspec(dllimport) uint32_t __stdcall waveOutOpen(uint64_t* phwo, uint32_t uDeviceID,
                                                     const WAVEFORMATEX* pwfx, uint64_t dwCallback,
                                                     uint64_t dwInstance, uint32_t fdwOpen);
__declspec(dllimport) uint32_t __stdcall waveOutPrepareHeader(uint64_t hwo, WAVEHDR* pwh, uint32_t cbwh);
__declspec(dllimport) uint32_t __stdcall waveOutUnprepareHeader(uint64_t hwo, WAVEHDR* pwh, uint32_t cbwh);
__declspec(dllimport) uint32_t __stdcall waveOutWrite(uint64_t hwo, WAVEHDR* pwh, uint32_t cbwh);
__declspec(dllimport) uint32_t __stdcall waveOutReset(uint64_t hwo);
__declspec(dllimport) uint32_t __stdcall waveOutClose(uint64_t hwo);
__declspec(dllimport) uint32_t __stdcall waveOutGetPosition(uint64_t hwo, MMTIME* pmmt, uint32_t cbmmt);
/* 定时器精度。默认 15.6ms —— 我们靠 Sleep 等缓冲，被它一拖就是一处爆音。 */
__declspec(dllimport) uint32_t __stdcall timeBeginPeriod(uint32_t ms);
__declspec(dllimport) uint32_t __stdcall timeEndPeriod(uint32_t ms);

__declspec(dllimport) void* __stdcall CreateThread(void* sa, uint64_t stack,
                                                  uint32_t (__stdcall* fn)(void*), void* arg,
                                                  uint32_t flags, uint32_t* tid);
__declspec(dllimport) uint32_t __stdcall WaitForSingleObject(void* handle, uint32_t ms);
__declspec(dllimport) int32_t __stdcall SetThreadPriority(void* thread, int32_t prio);
#define KA_THREAD_PRIORITY_ABOVE_NORMAL 1
__declspec(dllimport) void __stdcall Sleep(uint32_t ms);
__declspec(dllimport) void* __stdcall LoadLibraryA(const char* path);
__declspec(dllimport) void* __stdcall LoadLibraryW(const uint16_t* path);
__declspec(dllimport) int32_t __stdcall FreeLibrary(void* mod);
__declspec(dllimport) void* __stdcall GetProcAddress(void* mod, const char* name);
__declspec(dllimport) uint32_t __stdcall GetModuleFileNameA(void* mod, char* buf, uint32_t size);

/* SFZ 装载要用到的三个新面：文件、堆、路径。仍然没有 windows.h —— 声明照旧手写，
 * 导入库照旧用 kernel32.def 造。名字带 KA_ 前缀是因为宏在 ka_sfz.h 里也用。 */
__declspec(dllimport) void* __stdcall CreateFileW(const uint16_t* name, uint32_t access, uint32_t share,
                                                  void* sa, uint32_t disposition, uint32_t flags, void* tmpl);
__declspec(dllimport) int32_t __stdcall ReadFile(void* h, void* buf, uint32_t n, uint32_t* got, void* ov);
__declspec(dllimport) int32_t __stdcall GetFileSizeEx(void* h, int64_t* size);
__declspec(dllimport) int32_t __stdcall CloseHandle(void* h);
__declspec(dllimport) void* __stdcall VirtualAlloc(void* addr, uint64_t size, uint32_t type, uint32_t protect);
__declspec(dllimport) int32_t __stdcall VirtualFree(void* addr, uint64_t size, uint32_t type);

#define KA_GENERIC_READ        0x80000000u
#define KA_FILE_SHARE_READ     0x00000001u
#define KA_OPEN_EXISTING       3u
#define KA_INVALID_HANDLE      ((void*)(int64_t)-1)
#define KA_MEM_COMMIT          0x00001000u
#define KA_MEM_RESERVE         0x00002000u
#define KA_MEM_RELEASE         0x00008000u
#define KA_PAGE_READWRITE      4u

/* ── 常量 ─────────────────────────────────────────────────────────────────────────────────── */
#define KA_VERSION 1
#define WAVE_MAPPER_ 0xFFFFFFFFu
#define WAVE_FORMAT_PCM_ 1u
#define WHDR_DONE_ 0x00000001u
#define TIME_SAMPLES_ 0x0002u
#define MMSYSERR_NOERROR_ 0u

#define KA_FRAMES 512
/* 4 块 = 42ms。系统定时器默认只有 15.6ms 精度，供缓冲的线程一被拖就是一处爆音，
 * 所以给到 6 块（64ms）—— 反正输出延迟已经按 queued 补偿掉了，多几块不影响同步，
 * 只多一点点"按下播放到听见"的等待。 */
#define KA_BUFS   6
#define KA_RATE   48000

/* 24 个声部在"一个和弦 + 上一串的 release 尾巴"面前就不够用了 —— 满了要抢，抢掉的那一枚
 * 就是用户听到的"这个音没响/响一半"。抢还会把正在响的音拦腰截断。现代 CPU 上 64 枚
 * 减法合成（每枚每帧十来次浮点）根本不算什么，所以直接给够，抢声部退成兜底而不是常态。 */
#define KA_VOICES 64
#define KA_MAX_NOTES 8192
#define KA_MAX_TRACKS 32

/* 波形 */
#define W_SINE  0
#define W_TRI   1
#define W_SAW   2
#define W_SQUARE 3
#define W_NOISE 4

/* 包络阶段 */
#define S_ATTACK 0
#define S_DECAY  1
#define S_SUSTAIN 2
#define S_RELEASE 3

/* 与 ctypes 一一对应：28 字节 / 32 字节。字段顺序别动。 */
typedef struct {
    int32_t program;
    int32_t channel;
    float   vel_scale;
    float   gain;
    float   pan;
    int32_t mute;
    int32_t solo;
} ka_track;

typedef struct {
    int32_t track;
    int32_t note;
    int32_t vel;
    int32_t pad;
    int64_t start;   /* 帧，相对歌曲起点 */
    int64_t len;     /* 帧 */
} ka_note;

/* ── SFZ 采样库 ─────────────────────────────────────────────────────────────────────────────
 *
 * 合成器是"什么声音都像一点"，采样是"这一颗就是它"。两者共用同一套声部与调度 —— 差别只在
 * 声部每帧取值的那一行。装载/解析/解码都在 ka_sfz.h 里，这里只管把它接上。
 * ──────────────────────────────────────────────────────────────────────────────────────────── */
#include "ka_sfz.h"

/* ── 全局状态 ─────────────────────────────────────────────────────────────────────────────── */
static uint64_t g_hwo = 0;
static int      g_rate = KA_RATE;
static int      g_open = 0;
static int      g_stop = 0;
static void*    g_thread = 0;
static WAVEHDR  g_hdr[KA_BUFS];
static int16_t  g_pcm[KA_BUFS][KA_FRAMES * 2];

/* 插件不再在这一进程里加载 —— 那一段（ka_vst3.h）整个搬进了 KaPluginWorker.exe。
 * 这里只留"跟那个进程说话"的通道（ka_shm.h）：命令走共享内存，样本走 ring。
 * 理由见 ka_shm.h 文件头：真插件里有一个一开就把整个进程带崩的，崩在 ComfyUI 里
 * 就是连人带工程一起没。 */
#include "ka_shm.h"

static volatile int32_t g_lock = 0;
long _InterlockedCompareExchange(long volatile* dest, long exchange, long comparand);
long _InterlockedExchange(long volatile* dest, long value);
void __nop(void);
static void ka_lock(void) {
    while (_InterlockedCompareExchange((long*)&g_lock, 1, 0) != 0) { __nop(); __nop(); }
}
static void ka_unlock(void) { _InterlockedExchange((long*)&g_lock, 0); }

/* 时钟绑定（KolidClock.dll 的 kc_frames / kc_playing）。空则退化为「自己数帧」。 */
typedef int64_t (*kc_frames_fn)(void);
typedef int     (*kc_playing_fn)(void);
static kc_frames_fn  g_kc_frames = 0;
static kc_playing_fn g_kc_playing = 0;
static void*         g_kc_mod = 0;

/* 轨道与音符（双缓冲：主线程写 inactive，音频线程读 live，切换是原子的） */
static ka_track g_tracks[2][KA_MAX_TRACKS];
static volatile int32_t g_tn[2] = {0, 0};
static volatile int32_t g_tlive = 0;
/* 轨道增益/声像的**当前值**，每块向目标线性逼近一次（见 ka_render_block）。
 * 初值由 ka_init_pitch 统一置 1。 */
static float g_tgl[KA_MAX_TRACKS];
static float g_tgr[KA_MAX_TRACKS];

static ka_note g_notes[2][KA_MAX_NOTES];
static volatile int32_t g_nn[2] = {0, 0};
static volatile int32_t g_nlive = 0;

/* 每个槽位各有一个调度指针。新表先在 inactive 槽里算好下标、最后才切 g_nlive；
 * 共用一个指针时，切换那一瞬间音频线程可能拿到「旧下标 + 新表」（或者反过来），
 * 表现就是重放一串旧音 / 跳过一串新音。 */
static int32_t g_sched[2] = {0, 0};   /* 已调度到的音符下标（按槽位） */
static volatile int64_t g_sched_end = 0; /* 调度已经处理到的时间线位置（最后一块的末尾） */
static int64_t g_pos = 0;         /* 下一个要渲染的帧（音频自己的推进位置） */
static int64_t g_free_pos = 0;    /* 没绑时钟时的自由计数 */

/* 装了 VST3 乐器就让内置合成器闭嘴：两边吃的是同一张音符表，开着就是两层声音叠在一起。 */
static volatile int32_t g_synth_off = 0;

/* SFZ 引擎在整个进程里只有一套采样内存（见 ka_sfz.h 的 AB 双槽），所以它一次只能属于
 * 一条轨（2b）。-1 = 还没绑（按老语义谁都能用）；>=0 = 只有这条轨采样，别的轨走合成器。 */
static volatile int32_t g_sfz_track = -1;

/* 试听：界面点 ♪ 时塞一枚音符进来，由音频线程在下一块开头接手。
 * 不在调用方直接改声部 —— 那是跨线程写渲染状态，会抢锁或撕裂。 */
static volatile int32_t g_pend_note = -1;
static volatile int32_t g_pend_vel = 0;
static volatile int32_t g_pend_track = 0;

/* 试听用的自由帧计数：**不管播不播都往前走**。暂停时 g_pos 是钉住的（它跟时钟），
 * 试听音若拿 g_pos 当起点算长度，就会永远到不了 end —— 表现为"暂停时点 ♪ 一声不出"，
 * 或者更糟：响一声卡住不放。所以暂停期间的时间轴由这一条顶上。 */
static int64_t g_aud_clock = 0;

/* 上一块是不是在播。用来抓「播放 → 暂停」这个边沿：那一刻要当场收声，
 * 否则工程音会被「有没有声部活着」这条新判据当成"还有东西要响"，拖成一段残响
 * （暂停后 peak 久久不归零）。试听音不受影响 —— 它是边沿之后才触发的新声部。 */
static int g_was_playing = 0;

/* 诊断 */
static volatile int32_t g_peak = 0;
static volatile int32_t g_wr_ok = 0;
static volatile int32_t g_wr_err = 0;
static volatile int32_t g_loops = 0;
static volatile int32_t g_seeks = 0;
static volatile int32_t g_voices_used = 0;

/* 播放质量的四个数。"音质差/不同步/漏音"这三句抱怨对应的就是它们，别靠耳朵猜：
 *   g_fired   —— 真的被触发了几个音（对着音符表数，少一个就是漏音）
 *   g_late    —— 有几个音是"迟到"触发的（位置跳过去了，立刻补发，不算漏）
 *   g_steals  —— 抢过几次声部（一直涨 = 声部不够，音会被拦腰截断）
 *   g_drift   —— 引擎位置与权威时钟差多少帧（一直很大 = 同步差） */
static volatile int32_t g_fired = 0;
static volatile int32_t g_late = 0;
static volatile int32_t g_steals = 0;
static volatile int32_t g_starve = 0;   /* 设备追上我们几次（= 供不上了几次 = 爆了几处） */
static volatile int32_t g_drift = 0;
static volatile int32_t g_drift_max = 0;

/* 已经交给设备、但**还没出声**的帧数 = g_written - 设备播到的位置。
 * 这是输出延迟，也是"同步差"的那一半：见下面音频线程里的注释。
 *
 * 直接拿 waveOutGetPosition 减会踩一个坑：它**按整块跳**（一块播完才前进 512 帧），
 * 于是"排队帧数"是一列 512 高的阶梯，用它当靶子就会让修正量也跟着 ±512 抖 ——
 * 实测稳态偏差在 550 帧上下晃就是这么来的（真实漂移只有几十帧）。
 * 所以排队量要**平滑**后再用（定点 ×256，一阶，时间常数 ≈ 8 块 ≈ 85ms）。 */
static int64_t g_written = 0;
static int64_t g_queued_q8 = 0;
/* 每块该"多走/少走"几帧才能追上靶子（定点 ×256）。在循环里算、在落块时用 ——
 * 见音频线程里那段注释：修正必须按块施加，按循环次数施加会荡。 */
static int64_t g_corr_q8 = 0;

/* ── 设备的真速率 ───────────────────────────────────────────────────────────────────────────
 *
 * 声卡的晶振跟系统时钟不是同一颗。本机实测：公共时钟 48000.9 帧/秒，而设备只按
 * **47633 帧/秒**把我们的样本吃掉 —— 慢 0.76%。
 *
 * 后果有两层，而两层都会被听成"不对"：
 *   · **同步**：每秒差 367 帧，30 秒就是 230ms。位置修正再快也是在追一列永远追不上的火车。
 *   · **音高**：按 48000 算的 440Hz 被设备按 47633 播出来就是 436.6Hz —— 低了 13 音分。
 *
 * 所以不能靠位置修正硬拽，要**按真速率重采样**：
 *   g_ratio_q20 = 时间线帧 / 输入帧（本机 ≈ 1.0077），落块时 g_pos 按它推进；
 *   g_rate_eff  = 输入帧 / 真实秒（本机 ≈ 47633），音高与包络按它算。
 * 两者是一件事的两面，别只改一个 —— 只改位置会把音高留在错的地方。
 * ──────────────────────────────────────────────────────────────────────────────────────────── */
static int64_t g_ratio_q20 = 1 << 20;     /* 1.0 起步，测出来之后慢慢收敛过去 */
static int64_t g_pos_frac_q20 = 0;        /* 位置推进的小数部分，免得每块都截掉 0.0077 帧 */
static int     g_rate_eff = KA_RATE;      /* 合成用的"每秒多少输入帧" */
static int64_t g_win_played = -1;         /* 开播那一刻设备播到哪（累计估计的起点） */
static int64_t g_win_want = 0;            /* 开播那一刻权威时钟走到哪 */
static int     g_win_n = 0;               /* 已结算过几个窗口，用来衰减权重 */
/* 开播 / 从暂停恢复的那一刻要**硬对表一次**。见下面音频线程里那段注释：
 * 排队帧数是从 0 爬到满的，慢增益要 3 秒才追得上，那 3 秒里声音会早 56ms。 */
static int     g_need_sync = 1;
static int     g_thr_playing_prev = 0;    /* 音频线程上一圈看到的 playing */

/* ── 声部 ─────────────────────────────────────────────────────────────────────────────────── */
typedef struct {
    int      active;
    int      track;
    int      wave;
    float    phase;
    float    inc;
    float    inc_target;
    float    inc_sweep;
    float    noise_mix;
    float    env;
    int      stage;
    float    atk_inc;
    float    dec_coef;
    float    sus;
    float    rel_coef;
    float    amp;
    float    lp;
    float    lp_coef;
    uint32_t rng;
    int64_t  end;
    int      delay;
    /* 试听音：混音时**不吃轨道增益** —— 试听是"我想听一下这个音色"，不该被 M/S 掐掉，
     * 更不该因为"还没推过轨道表"（tn==0，tl[] 全是 0）就一声不出。 */
    int      aud;

    /* 采样声部：zone 非 0 就走采样路径，上面那一组振荡器字段整组不用。
       zone_gen 是装载代数 —— 换了乐器之后旧声部还指着上一槽的内存，靠它判悬空。 */
    ka_zone* zone;
    int32_t  zone_gen;
    double   sp;      /* 采样位置（帧，带小数） */
    double   step;    /* 每输出帧前进多少采样帧 */
    float    pl, pr;  /* zone 的声像折成的左右增益（1.0 = 原样） */
} ka_voice;

static ka_voice g_voice[KA_VOICES];
static float    g_pitch[128];
static float    g_inv[65];        /* 1/k，加性振荡器用（避免每个谐波都做一次除法） */

/* ── 小工具 ───────────────────────────────────────────────────────────────────────────────── */
static float ka_sin01(float p) {
    float x = p * (float)KA_SIN_POINTS;
    int i = (int)x;
    float f = x - (float)i;
    if (i < 0) { i = 0; f = 0.0f; }
    if (i >= KA_SIN_POINTS) i = KA_SIN_POINTS - 1;
    return KA_SIN[i] + (KA_SIN[i + 1] - KA_SIN[i]) * f;
}

static float ka_noise(uint32_t* s) {
    *s = (*s) * 1664525u + 1013904223u;
    return (float)((int32_t)((*s) >> 9)) * (1.0f / 4194304.0f);
}

/* ── 抗锯齿（PolyBLEP） ──────────────────────────────────────────────────────────────────────
 *
 * 朴素锯齿就是 `2*phase-1`，方波就是 `±a` —— 它们在跳变那一点有无穷多谐波。48k 下
 * Nyquist 以上的全部**折回来**，折回来的那些跟基频不成整数比，听感就是"沙沙的毛刺 +
 * 音高发飘"。一个 A4 的锯齿有 50 多个谐波越过 Nyquist，一阶低通根本压不住（它 6dB/oct，
 * 而锯齿的谐波只按 6dB/oct 衰减 —— 正好抵消）。
 *
 * 带限波表要每个音高一份表，太重。PolyBLEP 只做一件事：把跳变那一瞬间换成一段两个样本
 * 长的二次曲线，跳变点本身落在中点（这正是带限阶跃该有的值）。代价是一次除法 + 几次乘法。
 *
 * 返回值是**要从朴素波形里减掉**的量，按"落差 Δ"线性缩放：锯齿在 phase=0 处落差 -2，
 * 所以它减 1 个 blep；方波落差是 ±2a，就相应地 ±a 个。
 *
 * 三角形不改：它的不连续在**导数**上，谐波按 1/n² 衰减，A4 的第 55 个谐波只有 3e-4，
 * 听不见，不值得为它再写一套。
 * ──────────────────────────────────────────────────────────────────────────────────────────── */
static float ka_blep(float t, float dt) {
    float x;
    if (t < dt) {                    /* 跳变之后：t 是距跳变的相位 */
        x = t / dt;                  /* 0..1 */
        return (x + x) - x * x - 1.0f;
    }
    if (t > 1.0f - dt) {             /* 跳变之前：phase 快到 1 了 */
        x = (t - 1.0f) / dt;         /* -1..0 */
        return x * x + (x + x) + 1.0f;
    }
    return 0.0f;
}

/* ── 加性（带限）振荡器 ──────────────────────────────────────────────────────────────────────
 *
 * 高音区改用谐波求和：超过 Nyquist 的谐波**根本不生成**，于是没有可折返的东西。
 * PolyBLEP 只是一阶修正 —— 实测 program 18（方波）在 C8 上仍有 -35dB 的折返峰，
 * 在 C9 附近到 -30dB；这些分量与基频不成整数比，听感就是"沙沙的毛刺"。
 *
 * 只在高音区（dt > 0.015 ≈ f0 > 720Hz）走这条路：那里谐波少，一次求和最多十几个正弦；
 * 低音区仍用 PolyBLEP，否则要几十个谐波才够亮，白费 CPU 还容易丢掉高频。
 * ──────────────────────────────────────────────────────────────────────────────────────────── */
#define KA_BL_ADD_DT 0.015f

static float ka_sin_wrap(float p) {
    p = p - (float)(int)p;          /* p >= 0，截断即取小数 */
    return ka_sin01(p);
}

static float ka_osc_bl_square(float phase, float dt) {
    int k, kmax;
    float s = 0.0f;
    if (dt <= 0.0f) return 0.0f;
    kmax = (int)(0.5f / dt);
    if (kmax > 64) kmax = 64;
    for (k = 1; k <= kmax; k += 2) s += ka_sin_wrap(phase * (float)k) * g_inv[k];
    return s * 1.0946f;             /* (4/π) × 0.86：与朴素方波的幅度对齐 */
}

static float ka_osc_bl_saw(float phase, float dt) {
    int k, kmax;
    float s = 0.0f;
    if (dt <= 0.0f) return 0.0f;
    kmax = (int)(0.5f / dt);
    if (kmax > 64) kmax = 64;
    for (k = 1; k <= kmax; ++k) s -= ka_sin_wrap(phase * (float)k) * g_inv[k];
    return s * 0.63661977f;         /* 2/π：与 2φ-1 的幅度对齐 */
}

static float ka_osc(int wave, float phase, float dt, uint32_t* rng) {
    switch (wave) {
    case W_SINE:   return ka_sin01(phase);
    case W_TRI: {
        float d = phase - 0.5f;
        if (d < 0.0f) d = -d;
        return 1.0f - 4.0f * d;
    }
    case W_SAW: {
        float v;
        if (dt > KA_BL_ADD_DT) return ka_osc_bl_saw(phase, dt);
        v = 2.0f * phase - 1.0f;
        /* dt 太大（极高音）时跳变一个样本里就来回好几次，BLEP 没意义还容易除爆。 */
        if (dt > 0.0f && dt < 0.5f) v -= ka_blep(phase, dt);
        return v;
    }
    case W_SQUARE: {
        float a = 0.86f;
        float v;
        if (dt > KA_BL_ADD_DT) return ka_osc_bl_square(phase, dt);
        v = (phase < 0.5f) ? a : -a;
        if (dt > 0.0f && dt < 0.5f) {
            /* 两处跳变：phase=0 处 +2a，phase=0.5 处 -2a。
             * p2 是"从 0.5 那个跳变量起算"的相位，好复用同一个 ka_blep。 */
            float p2 = (phase < 0.5f) ? (phase + 0.5f) : (phase - 0.5f);
            v += a * ka_blep(phase, dt);
            v -= a * ka_blep(p2, dt);
        }
        return v;
    }
    default:       return ka_noise(rng);
    }
}

/* 每样本的系数：一阶近似 exp(-1/(t*rate))，不需要 exp/pow。 */
static float ka_coef_for(float seconds, int rate) {
    float n = seconds * (float)rate;
    if (n < 1.0f) n = 1.0f;
    return 1.0f - 1.0f / n;
}

static void ka_init_pitch(void) {
    int n;
    double f = 8.175798915643707;          /* MIDI 0 */
    for (n = 0; n < 128; ++n) { g_pitch[n] = (float)f; f *= 1.0594630943592953; }
    for (n = 1; n <= 64; ++n) g_inv[n] = 1.0f / (float)n;
    for (n = 0; n < KA_MAX_TRACKS; ++n) { g_tgl[n] = 1.0f; g_tgr[n] = 1.0f; }
}

/* ── 音色：按 GM 大类（program/8）挑波形与包络 ─────────────────────────────────────────────── */
typedef struct {
    int   wave;
    float atk;   /* 秒 */
    float dec;   /* 到 sustain 的时间常量 */
    float sus;   /* 0..1 */
    float rel;
    float lp;    /* 低通系数，越小声越闷 */
    float nmix;  /* 噪声混合 */
} ka_patch;

static ka_patch ka_patch_for(int program) {
    ka_patch p;
    int fam;
    if (program < 0) program = 0;
    if (program > 127) program = 127;
    fam = program / 8;

    p.wave = W_TRI; p.atk = 0.004f; p.dec = 0.9f; p.sus = 0.0f; p.rel = 0.22f; p.lp = 0.55f; p.nmix = 0.0f;
    switch (fam) {
        case 0:  p.wave = W_TRI;    p.atk = 0.002f; p.dec = 1.6f;  p.sus = 0.0f;  p.rel = 0.20f; p.lp = 0.60f; break; /* 钢琴 */
        case 1:  p.wave = W_SINE;   p.atk = 0.001f; p.dec = 0.8f;  p.sus = 0.0f;  p.rel = 0.18f; p.lp = 0.75f; break; /* 色彩打击 */
        case 2:  p.wave = W_SQUARE; p.atk = 0.012f; p.dec = 0.3f;  p.sus = 0.85f; p.rel = 0.08f; p.lp = 0.55f; break; /* 风琴 */
        case 3:  p.wave = W_SAW;    p.atk = 0.004f; p.dec = 1.2f;  p.sus = 0.0f;  p.rel = 0.28f; p.lp = 0.48f; break; /* 吉他 */
        case 4:  p.wave = W_SAW;    p.atk = 0.004f; p.dec = 0.6f;  p.sus = 0.55f; p.rel = 0.10f; p.lp = 0.26f; break; /* 贝斯 */
        case 5:  p.wave = W_SAW;    p.atk = 0.11f;  p.dec = 0.5f;  p.sus = 0.82f; p.rel = 0.42f; p.lp = 0.38f; break; /* 弦乐 */
        case 6:  p.wave = W_SAW;    p.atk = 0.18f;  p.dec = 0.5f;  p.sus = 0.82f; p.rel = 0.55f; p.lp = 0.34f; break; /* 合奏 */
        case 7:  p.wave = W_SQUARE; p.atk = 0.045f; p.dec = 0.4f;  p.sus = 0.76f; p.rel = 0.18f; p.lp = 0.42f; break; /* 铜管 */
        case 8:  p.wave = W_SQUARE; p.atk = 0.03f;  p.dec = 0.4f;  p.sus = 0.80f; p.rel = 0.14f; p.lp = 0.45f; break; /* 簧管 */
        case 9:  p.wave = W_SINE;   p.atk = 0.04f;  p.dec = 0.4f;  p.sus = 0.80f; p.rel = 0.18f; p.lp = 0.70f; break; /* 管乐 */
        case 10: p.wave = W_SAW;    p.atk = 0.008f; p.dec = 0.5f;  p.sus = 0.80f; p.rel = 0.14f; p.lp = 0.52f; break; /* 合成主音 */
        case 11: p.wave = W_TRI;    p.atk = 0.32f;  p.dec = 0.6f;  p.sus = 0.86f; p.rel = 0.80f; p.lp = 0.40f; break; /* 铺底 */
        case 12: p.wave = W_SAW;    p.atk = 0.05f;  p.dec = 0.7f;  p.sus = 0.60f; p.rel = 0.30f; p.lp = 0.50f; break; /* 效果 */
        case 13: p.wave = W_TRI;    p.atk = 0.01f;  p.dec = 0.7f;  p.sus = 0.10f; p.rel = 0.22f; p.lp = 0.52f; break; /* 民族 */
        case 14: p.wave = W_TRI;    p.atk = 0.001f; p.dec = 0.22f; p.sus = 0.0f;  p.rel = 0.15f; p.lp = 0.62f; break; /* 打击 */
        default: p.wave = W_NOISE;  p.atk = 0.005f; p.dec = 0.5f;  p.sus = 0.3f;  p.rel = 0.30f; p.lp = 0.60f; p.nmix = 0.6f; break;
    }
    return p;
}

/* ── 软饱和 ──────────────────────────────────────────────────────────────────────────────────
 *
 * 多个声部直接相加，和弦一响总电平轻松过 2。老写法是"膝盖 0.95 + 上面乘 0.25 再夹到 1.0"
 * —— 超过 1.15 就是**硬削**：波形被削平的那一段就是一片方波失真，这就是"音质很差"的
 * 另一半（另一半是上面那个裸锯齿的混叠）。
 *
 * 这里换成一条**渐近到 1.0、永远不会到 1.0** 的曲线：膝盖处斜率连续（不换手感），
 * 越往上压得越紧，但再响也只是"变厚"而不是"破音"。
 * ──────────────────────────────────────────────────────────────────────────────────────────── */
/* 总线限幅：饱和曲线是「音色」，不该拿它当限幅器用 —— 它一工作就会产生与基频
 * 不成整数比的分量（实测四音和弦 inharm≈2%），听感就是发毛。所以前面先加一级
 * **立体声联动**的峰值限幅：超过门限就整体压增益，稳态和弦只是变小声，波形不变形。
 * 门限 0.90 留约 1dB 余量，饱和曲线只兜真正极端的瞬态。
 * 增益按子块（≈10ms）更新：块内恒定，块间线性过渡；逐样本压会跟着波形抽动，
 * 反而往和弦里塞互调分量。 */
#define KA_LIM_THRESH 0.90f
static float g_lim = 1.0f;        /* 限幅器当前增益（左右共用，不动声像） */
static float g_lim_env = 0.0f;    /* 限幅器参考电平：取最大值后缓慢回落 */

#define KA_SAT_KNEE 0.90f
/* 限幅子块的浮点混音缓冲。放静态区而不是栈上：/NODEFAULTLIB 下 4KB 以上的
 * 栈分配会拉进 __chkstk，而这里没有 CRT 可以提供它。音频线程只有一条。 */
static float g_dry[KA_FRAMES * 2];
static float ka_sat(float x) {
    float a = x < 0.0f ? -x : x;
    float t, y;
    if (a <= KA_SAT_KNEE) return x;
    t = (a - KA_SAT_KNEE) / (1.0f - KA_SAT_KNEE);       /* 0..∞ */
    y = KA_SAT_KNEE + (1.0f - KA_SAT_KNEE) * (t / (1.0f + t));
    return x < 0.0f ? -y : y;
}

/* ── 声部分配与触发 ───────────────────────────────────────────────────────────────────────── */
static ka_voice* ka_voice_alloc(void) {
    int i, worst = 0;
    float low = 2.0f;
    for (i = 0; i < KA_VOICES; ++i) if (!g_voice[i].active) return &g_voice[i];

    /* 真满了才抢。挑人的顺序很重要：
     *   ① 先挑**已经在 release 里**的（它已经在收尾了，砍掉几乎听不出来）；
     *   ② 都不在 release 才挑 env 最小的。
     * 只按 env 挑会砍掉刚起音、包络还没爬上去的那个新音 —— 听起来就是"这个音没响"。
     * 两轮都挑 env 最小的，只是第一轮把候选池限定在 release 里。 */
    for (i = 0; i < KA_VOICES; ++i) {
        if (g_voice[i].stage == S_RELEASE && g_voice[i].env < low) { low = g_voice[i].env; worst = i; }
    }
    if (low <= 2.0f) { g_steals = g_steals + 1; return &g_voice[worst]; }
    low = 2.0f;
    for (i = 0; i < KA_VOICES; ++i) if (g_voice[i].env < low) { low = g_voice[i].env; worst = i; }
    g_steals = g_steals + 1;
    return &g_voice[worst];
}

static void ka_voice_off_all(void) {
    int i;
    /* 12ms 的释放时间常数：够短（听感上就是"停住了"），又够长（不会把波形从 0.7
     * 一步砍到 0 —— 那一下就是一个宽带咔哒声，正是"毛躁"里最刺耳的那部分）。 */
    float rel = ka_coef_for(0.012f, g_rate_eff);
    for (i = 0; i < KA_VOICES; ++i) {
        if (g_voice[i].active) { g_voice[i].stage = S_RELEASE; g_voice[i].rel_coef = rel; }
    }
}

static void ka_trigger(const ka_note* n, int delay, int aud) {
    ka_voice* v;
    float amp, velN;
    int track, trackN;
    ka_patch p;

    if (n->note < 0 || n->note > 127) return;
    if (n->vel <= 0) return;

    track = n->track;
    if (track < 0 || track >= KA_MAX_TRACKS) track = 0;

    velN = (float)n->vel / 127.0f;
    amp = velN * (0.45f + 0.55f * velN);      /* 近似 vel^1.5，避开 pow */

    v = ka_voice_alloc();
    v->active = 1;
    v->track = track;
    v->delay = delay;
    v->phase = 0.0f;
    v->env = 0.0f;
    v->stage = S_ATTACK;
    v->lp = 0.0f;
    v->rng = (uint32_t)(n->note * 2654435761u + n->track * 40503u + 1u);
    v->end = n->start + n->len;
    v->inc_sweep = 0.0f;
    v->noise_mix = 0.0f;
    v->aud = aud ? 1 : 0;
    /* 声像先置中：只有采样分支会改写它，合成分支若不设就是上一枚声部留下的残值。 */
    v->pl = 1.0f;
    v->pr = 1.0f;

    {
        /* 轨道上的 velScale 乘进振幅（0.1x..2x）。track 越界时按第 0 条算，别读表外。 */
        float vs = 1.0f;
        int tl = g_tlive;
        int tn = g_tn[tl];
        if (track < tn) { vs = g_tracks[tl][track].vel_scale; if (vs <= 0.0f) vs = 1.0f; }
        amp *= vs;
        if (amp > 1.6f) amp = 1.6f;
        trackN = (track < tn) ? track : 0;
    }
    v->track = trackN;
    v->amp = amp;

    /* 采样优先：装了 SFZ 就先问它。鼓也一样 —— 一套鼓的 sfz 本来就是按音符分 zone 的，
     * 这时候再叠一层"GM 鼓合成"只会把采样盖掉。
     * 2b 之后采样内存只能属于一个主人（g_sfz_track）：
     *   >=0 = 那条轨的时间轴音符与试听都这里出声；
     *   -2  = 只给试听槽用（工程里的音符不许拿到这套采样）；
     *   -1  = 没绑（谁都不采样）。 */
    if (aud ? (g_sfz_track == -2 || g_sfz_track == track) : (g_sfz_track == track)) {
        ka_zone* z = sfz_pick(n->note, n->vel);
        if (z) {
            float cents = (float)(n->note - z->keycenter) * 100.0f + z->tune;
            float velamp = velN * (0.45f + 0.55f * velN);
            float veltrack = (z->veltrack > 0.0f) ? z->veltrack : 1.0f;
            float va = 1.0f - veltrack + veltrack * velamp;
            float vs = 1.0f;
            float pan = z->pan;
            int tn2 = g_tn[g_tlive];
            if (trackN < tn2) { vs = g_tracks[g_tlive][trackN].vel_scale; if (vs <= 0.0f) vs = 1.0f; }

            v->zone = z;
            v->zone_gen = g_sfz_gen;
            v->sp = (double)z->offset;
            v->step = ((double)z->rate / (double)g_rate_eff) * (double)sfz_exp2(cents / 1200.0f);
            v->wave = W_SINE;
            v->phase = 0.0f;
            v->inc = 0.0f;
            v->inc_target = 0.0f;
            v->inc_sweep = 0.0f;
            v->noise_mix = 0.0f;
            v->atk_inc = (z->atk > 0.0005f) ? (1.0f / (z->atk * (float)g_rate_eff)) : 1.0f;
            v->dec_coef = ka_coef_for(z->dec, g_rate_eff);
            v->sus = z->sus;
            v->rel_coef = ka_coef_for(z->rel, g_rate_eff);
            v->lp_coef = 1.0f;                 /* 采样不用再磨高频 */
            v->amp = z->gain * va * vs;
            if (v->amp > 1.8f) v->amp = 1.8f;
            /* 声像折成两个增益：pan<0 只压右，pan>0 只压左。 */
            v->pl = (pan > 0.0f) ? (1.0f - pan) : 1.0f;
            v->pr = (pan < 0.0f) ? (1.0f + pan) : 1.0f;
            g_voices_used = g_voices_used + 1;
            return;
        }
    }

    v->zone = 0;

    /* 到这儿还走合成器的，就是"这条轨没装乐器"。合成器关着时这里不再出声 ——
     * 声音只来自乐器，没装就安静（采样分支在上面已经返回，这根闸不挡 SFZ 与试听槽）。 */
    if (g_synth_off) { v->active = 0; return; }

    if (g_tn[g_tlive] > trackN && g_tracks[g_tlive][trackN].channel == 9) {
        /* 鼓：按音高分四族，全是噪声或扫频正弦，不吃 program。 */
        int nn = n->note;
        v->wave = W_NOISE;
        v->atk_inc = 1.0f / (0.0015f * (float)g_rate_eff);
        v->dec_coef = ka_coef_for(0.09f, g_rate_eff);
        v->sus = 0.0f;
        v->rel_coef = 0.995f;
        v->lp_coef = 0.65f;
        v->inc = 0.0f;
        v->inc_target = 0.0f;
        if (nn == 35 || nn == 36) {                 /* kick */
            v->wave = W_SINE;
            v->inc = 150.0f / (float)g_rate_eff;
            v->inc_target = 46.0f / (float)g_rate_eff;
            v->inc_sweep = 0.0016f;
            v->dec_coef = ka_coef_for(0.16f, g_rate_eff);
            v->lp_coef = 0.9f;
        } else if (nn == 38 || nn == 40) {          /* snare */
            v->noise_mix = 0.75f;
            v->inc = 190.0f / (float)g_rate_eff;
            v->inc_target = 160.0f / (float)g_rate_eff;
            v->inc_sweep = 0.002f;
            v->dec_coef = ka_coef_for(0.14f, g_rate_eff);
            v->lp_coef = 0.55f;
        } else if (nn == 42 || nn == 44) {          /* closed hat */
            v->dec_coef = ka_coef_for(0.045f, g_rate_eff);
            v->lp_coef = 0.95f;
        } else if (nn == 46) {                      /* open hat */
            v->dec_coef = ka_coef_for(0.26f, g_rate_eff);
            v->lp_coef = 0.95f;
        } else if (nn == 49 || nn == 57) {          /* crash */
            v->dec_coef = ka_coef_for(0.55f, g_rate_eff);
            v->lp_coef = 0.85f;
        } else {                                    /* 其它打击：短噪声 */
            v->dec_coef = ka_coef_for(0.12f, g_rate_eff);
            v->lp_coef = 0.7f;
        }
        /* 鼓声按音高微调亮度，避免一片一样。 */
        if (v->inc == 0.0f) v->lp_coef = v->lp_coef * (0.72f + (float)(n->note & 7) * 0.045f);
        v->phase = 0.5f;
        g_voices_used = g_voices_used + 1;
        return;
    }

    p = ka_patch_for(g_tracks[g_tlive][trackN].program);
    v->wave = p.wave;
    v->noise_mix = p.nmix;
    v->inc = g_pitch[n->note] / (float)g_rate_eff;
    v->inc_target = v->inc;
    v->atk_inc = 1.0f / (p.atk * (float)g_rate_eff + 1.0f);
    v->dec_coef = ka_coef_for(p.dec, g_rate_eff);
    v->sus = p.sus;
    v->rel_coef = ka_coef_for(p.rel, g_rate_eff);
    v->lp_coef = p.lp;
    g_voices_used = g_voices_used + 1;
}

/* ── 插件通道（宿主侧：只说话，不加载） ───────────────────────────────────────────────────────
 *
 * 一次命令 = 填参数 → 敲 ev_cmd → 等 ev_done。**超时不是一个结果，是两个**：
 * 心跳还在动 = worker 活着但慢（大插件开一秒很正常，别急着重来）；心跳不动 = 它崩了，
 * 这时候一定要把 cmd 槽清掉 —— 否则后面每一条命令都撞在"上一条还没做完"上，
 * 表现是界面从此**卡住而不是报错**，那就把"插件崩了"这件本来就看得见的事藏起来了。
 *
 * 音频反方向不进这条通道：worker 有空就把块推进 ring，宿主按自己的节奏取。
 * 音频路径上谁等谁，谁就是下一处爆音。
 * ──────────────────────────────────────────────────────────────────────────────────────────── */
/* ── 实例槽（2b：一条轨 = 一支插件实例）──────────────────────────────────────────────────────
 *
 * 一个槽 = 一个 KaPluginWorker.exe + 一块共享内存 + 一条命令通道。**worker 本身没改**：
 * 它一直就是"一个进程一支插件"，多实例就是把它的那套再起一份，名字靠 tag 分开。
 *
 * 两条路分开走，别混：
 *   · **命令路**（scan / open / setState / 参数 / 试听…）走"选中槽"。Python 桥是唯一调用者，
 *     而且每一条插件命令都在 `Engine._lock` 里，所以 `ka_plug_select(slot)` 之后再调老函数
 *     就够了 —— 导出名一个没变，老脚本照跑。
 *   · **音频路**（每块混音、按轨裁音符表）走 g_plugs[] 全表，音频线程**从不**读选中槽。
 *     它只看 g_plug_on / g_plug_track_of 两个纯整数快照：attach/close 时整型写，
 *     所以就算主线程正在开关插件，音频线程也不会摸到一个半建的指针。 */
#define KA_MAX_PLUG 16
typedef struct {
    ka_shm* shm;
    void*   map;
    void*   evc;
    void*   evd;
} ka_plug_slot;
static ka_plug_slot g_plugs[KA_MAX_PLUG];
static int32_t g_plug_cur = 0;
#define g_plug (g_plugs[g_plug_cur].shm)

/* 音频线程只读这两个。g_plug_on = 这支实例开着（open 成功过、还没 close）；
 * g_plug_track_of = 它吃哪条轨（-1 = 不喂任何轨）。 */
static volatile int32_t g_plug_on[KA_MAX_PLUG];
static volatile int32_t g_plug_track_of[KA_MAX_PLUG];
static float   g_plug_gain = 1.0f;

/** 这条轨是不是由插件发声（内置合成器要闭嘴的那几轨）。音频线程调，只读整数快照。 */
static int ka_track_has_plugin(int track) {
    int i;
    for (i = 0; i < KA_MAX_PLUG; ++i) {
        if (g_plug_on[i] && g_plug_track_of[i] == track) return 1;
    }
    return 0;
}

static void ka_plug_beat(void) { if (g_plug) g_plug->host_beat = g_plug->host_beat + 1; }

static int32_t ka_plug_call(int32_t cmd, int32_t a0, int32_t a1, int32_t a2, int32_t a3,
                            const uint16_t* path, uint32_t ms) {
    ka_shm* s = g_plug;
    ka_plug_slot* p = &g_plugs[g_plug_cur];
    int32_t beat0, i;
    if (!s || !p->evc || !p->evd) return KA_SHM_ERR_NO_WORKER;
    if (s->cmd != KA_CMD_NONE) return -95;                 /* 上一次还没做完 */
    if (path) {
        for (i = 0; i < KA_SHM_PATH - 1 && path[i]; ++i) s->path[i] = path[i];
        s->path[i] = 0;
        s->has_path = 1;
    } else { s->path[0] = 0; s->has_path = 0; }   /* NULL 与空串是两回事，插件那边分开报 */
    s->a0 = a0; s->a1 = a1; s->a2 = a2; s->a3 = a3;
    s->ret = 0;
    s->text[0] = 0;
    ResetEvent(p->evd);
    s->cmd = cmd;
    beat0 = s->beat;
    ka_plug_beat();
    SetEvent(p->evc);
    if (WaitForSingleObject(p->evd, ms) != KA_WAIT_OBJECT_0) {
        if (s->beat == beat0) { s->cmd = KA_CMD_NONE; return KA_SHM_ERR_DEAD; }
        return KA_SHM_ERR_TIMEOUT;
    }
    return s->ret;
}

/** 把 worker 写回来的 text 抄给调用方（worker 那边是固定 2048，cap 是调用方给的）。 */
static int ka_plug_text(char* buf, int cap) {
    int i = 0;
    if (!buf || cap <= 0 || !g_plug) return 0;
    for (; i < cap - 1 && g_plug->text[i]; ++i) buf[i] = g_plug->text[i];
    buf[i] = 0;
    return i;
}

/** 走带锚点：ring 里第 r 块 = 时钟第 pos 帧。worker 拿它算出"我正在渲的这一块落在哪"，
 *  音符才能落在块内的正确帧上（不然整块都挤在块首，听感一抖一抖）。 */
static void ka_plug_anchor(ka_shm* s, int64_t pos, int playing) {
    s->tr_pos_lo = (int32_t)(pos & 0x7FFFFFFF);
    s->tr_pos_hi = (int32_t)(pos >> 32);
    s->tr_read = s->r;
    s->tr_playing = playing ? 1 : 0;
}

/** 硬对表：开播 / 拖播放头。所有实例的游标一起重排 —— 它们跟的是同一只钟。 */
static void ka_plug_epoch(void) {
    int i;
    for (i = 0; i < KA_MAX_PLUG; ++i) {
        ka_shm* s = g_plugs[i].shm;
        if (s) s->tr_epoch = s->tr_epoch + 1;
    }
}

/** 所有实例混进设备输出。一个取不到块不影响别的 —— 宁可这一件静音，也不能等（等 = 爆音）。
 *
 *  每块都要给每个**连着**的槽敲一次心跳，不只是出声的那些：worker 靠心跳认出"宿主还在"，
 *  一个暂时没音符的实例若被漏掉，它会以为宿主没了，自己退出。 */
static void ka_plug_mix(int16_t* out, int frames, int playing, int64_t pos) {
    int si;
    for (si = 0; si < KA_MAX_PLUG; ++si) {
        ka_shm* s = g_plugs[si].shm;
        const float* blk;
        int i;
        if (!s) continue;
        s->host_beat = s->host_beat + 1;
        if (!s->live || !s->opened) continue;
        ka_plug_anchor(s, pos, playing);
        if (!playing && s->aud_blocks <= 0 && !s->ed_mon) {
            /* 停了就把 ring 抽干：不然恢复播放时先甩出一段几秒前的旧块。
             * 但这儿要放试听音过去 —— 暂停时点 ♪ 也要出声；插件窗口开着时同理，
             * 用户是在里面试音（ed_mon），抽干就等于静音。 */
            while (ka_shm_ready(s) > 0) s->r = s->r + 1;
            continue;
        }
        if (ka_shm_ready(s) <= 0) { s->underrun = s->underrun + 1; continue; }
        blk = ka_shm_block_at(s, s->r);
        for (i = 0; i < frames && i < s->block; ++i) {
            int32_t vl = (int32_t)out[i * 2]     + (int32_t)(blk[i * 2]     * 30000.0f * g_plug_gain);
            int32_t vr = (int32_t)out[i * 2 + 1] + (int32_t)(blk[i * 2 + 1] * 30000.0f * g_plug_gain);
            if (vl > 32767) vl = 32767; if (vl < -32768) vl = -32768;
            if (vr > 32767) vr = 32767; if (vr < -32768) vr = -32768;
            out[i * 2]     = (int16_t)vl;
            out[i * 2 + 1] = (int16_t)vr;
        }
        s->r = s->r + 1;                 /* 最后一步才公布，worker 才知道这块空出来了 */
    }
}

/** 从 ring 里取一块（测试/离线用）。这边不是音频线程，等得起 —— 但也不能无限等，
 *  心跳不动了就当 worker 没了。 */
static int ka_plug_pull(float* dst, int frames) {
    ka_shm* s = g_plug;
    int32_t beat0, stall = 0;
    int i, n;
    if (!s) return KA_SHM_ERR_NO_WORKER;
    if (!s->opened) return -1;
    beat0 = s->beat;
    while (ka_shm_ready(s) <= 0) {
        ka_plug_beat();
        Sleep(1);
        if (s->beat == beat0) { if (++stall > 400) return KA_SHM_ERR_DEAD; }
        else { beat0 = s->beat; stall = 0; }
    }
    {
        const float* blk = ka_shm_block_at(s, s->r);
        n = frames < s->block ? frames : s->block;
        if (dst) for (i = 0; i < n * 2; ++i) dst[i] = blk[i];
    }
    s->r = s->r + 1;
    return 0;
}

/** 把音符表按**槽的绑定**裁好，一槽一份交下去（2b：一条轨 = 一支实例）。
 *
 *  每个槽只收到"自己那条轨"的音符：别的轨在别的实例里，混进来就是两件乐器叠在一起。
 *  通道统一写 0（MIDI 第 1 通道）—— 一支实例只持一件乐器，它默认就听第 1 通道
 *  （Kontakt 是 omni、HALion Sonic 的槽默认 ch1）；轨自己的通道号留给外部 MIDI 与内置合成器。
 *
 *  静音/独奏在这里落地：被掐掉的轨干脆不给插件 —— 插件那边就少一个同时发声的声部，
 *  CPU 也省。力度缩放同理（在宿主里就算好，插件只认 1..127）。
 *  notes_gen 当 seqlock：奇数 = 正在写，worker 看到奇数就不读。 */
static void ka_plug_push_notes(void) {
    int nl, tn, si, i, any_solo = 0;
    nl = g_nlive;
    tn = g_tn[g_tlive];
    if (tn > KA_MAX_TRACKS) tn = KA_MAX_TRACKS;
    for (i = 0; i < tn; ++i) if (g_tracks[g_tlive][i].solo) { any_solo = 1; break; }

    for (si = 0; si < KA_MAX_PLUG; ++si) {
        ka_shm* s = g_plugs[si].shm;
        int n = g_nn[nl], out = 0, want = g_plug_track_of[si];
        if (!s) continue;
        if (n > KA_SHM_NOTES) n = KA_SHM_NOTES;
        s->notes_gen = s->notes_gen + 1;
        for (i = 0; i < n && want >= 0; ++i) {
            const ka_note* nt = &g_notes[nl][i];
            const ka_track* tr;
            int t = nt->track, vel;
            if (t != want) continue;
            if (t >= tn) continue;              /* 绑到了一条已经不存在的轨 */
            tr = &g_tracks[g_tlive][t];
            if (tr->mute || (any_solo && !tr->solo)) continue;
            vel = (int)((float)nt->vel * (tr->vel_scale > 0.0f ? tr->vel_scale : 1.0f) + 0.5f);
            if (vel > 127) vel = 127;
            if (vel < 1) vel = 1;
            s->notes[out].track = t;
            s->notes[out].note = nt->note;
            s->notes[out].vel = vel;
            s->notes[out].ch = 0;
            s->notes[out].start = nt->start;
            s->notes[out].len = nt->len;
            ++out;
        }
        s->note_count = out;
        s->notes_gen = s->notes_gen + 1;
    }
}

/* 二分到第一个 start >= pos 的音符（表按 start 升序）。换表 / seek 后恢复调度用它。 */
static int32_t ka_note_index_at(const ka_note* notes, int count, int64_t pos) {    int lo = 0, hi = count, mid;
    if (count <= 0) return 0;
    while (lo < hi) {
        mid = (lo + hi) / 2;
        if (notes[mid].start < pos) lo = mid + 1; else hi = mid;
    }
    return lo;
}

/* ── 渲染一块 ─────────────────────────────────────────────────────────────────────────────── */
static void ka_render_block(int16_t* out, int frames, int64_t pos, int playing) {
    float tgtl[KA_MAX_TRACKS], tgtr[KA_MAX_TRACKS];
    float dl[KA_MAX_TRACKS], dr[KA_MAX_TRACKS];
    float lim_env_coef;
    int tn, i, v, t, anySolo = 0;
    int64_t pos_end = pos + frames;

    tn = g_tn[g_tlive];
    if (tn > KA_MAX_TRACKS) tn = KA_MAX_TRACKS;

    /* 轨道增益/声像按块**线性过渡**，不直接跳。M/S、推子、声像都是在播放中改的，
     * 一步跳过去就是方波沿 —— 每改一次响一声"啪"。11ms 内走完，听不出来。 */
    for (i = 0; i < KA_MAX_TRACKS; ++i) { tgtl[i] = 0.0f; tgtr[i] = 0.0f; }
    for (i = 0; i < tn; ++i) {
        if (g_tracks[g_tlive][i].solo) { anySolo = 1; break; }
    }
    for (i = 0; i < tn; ++i) {
        const ka_track* tr = &g_tracks[g_tlive][i];
        float g = tr->gain > 0.0f ? tr->gain : 1.0f;
        float p = tr->pan;
        int audible;
        if (g > 2.0f) g = 2.0f;
        if (p < 0.0f) p = 0.0f;
        if (p > 1.0f) p = 1.0f;
        audible = !tr->mute && (!anySolo || tr->solo);
        if (!audible) continue;
        tgtl[i] = g * (1.0f - 0.55f * p);
        tgtr[i] = g * (0.45f + 0.55f * p);
    }
    for (i = 0; i < KA_MAX_TRACKS; ++i) {
        dl[i] = (tgtl[i] - g_tgl[i]) / (float)frames;
        dr[i] = (tgtr[i] - g_tgr[i]) / (float)frames;
    }
    lim_env_coef = ka_coef_for(0.250f, g_rate_eff);


    /* 工不工作，看两件事：在不在播，**或者**有没有试听音正要响/正在响。
     * 老写法是「!playing 就整块短路成静音」—— 试听音的触发排在短路之后，
     * 于是暂停时点 ♪ 一声不出。试听不该看传输的脸色：它是"我想听一下这个音色"，
     * 跟播不播放头没关系。 */
    if (!playing) {
        /* 待触发的试听音一律算"在工作"，**不看合成器开关**：ka_trigger 里采样分支
         * 排在合成器那道闸之前（见 SFZ 那一段），关了合成器正是 SFZ 试听的常态。
         * 老写法带着 !g_synth_off，于是暂停时点 ♪ 会被下面整块短路吞掉。 */
        int k, live = (g_pend_note >= 0);
        if (g_was_playing) {
            /* 播放 → 暂停：收声，但**不是**把波形一步砍到 0 —— 那一下就是一个宽带咔哒。
             * 走 12ms 的释放，听感上仍然是"停住了"，频谱里却没有台阶。
             * 试听音在这个边沿之后才触发，不受影响。 */
            float rel = ka_coef_for(0.012f, g_rate_eff);
            for (k = 0; k < KA_VOICES; ++k) {
                if (g_voice[k].active) { g_voice[k].stage = S_RELEASE; g_voice[k].rel_coef = rel; }
            }
            g_was_playing = 0;
        }
        if (!live) {
            for (k = 0; k < KA_VOICES; ++k) if (g_voice[k].active) { live = 1; break; }
        }
        if (!live) {
            ka_voice_off_all();
            g_lim = 1.0f;
            g_lim_env = 0.0f;
            for (k = 0; k < frames; ++k) { out[k * 2] = 0; out[k * 2 + 1] = 0; }
            /* 停了也要把包络走完，否则恢复时一片残响突然冒出。 */
            for (k = 0; k < KA_VOICES; ++k) if (g_voice[k].active) { g_voice[k].env *= 0.9f; if (g_voice[k].env < 0.001f) g_voice[k].active = 0; }
            ka_plug_mix(out, frames, playing, pos);   /* 暂停时的试听音从这里出去 */
            /* 混完再量：插件试听、以及插件窗口开着时界面里试的音，都只从这条小路出声。
             * 以前这里硬写 0（"峰值要跟着停"），于是明明有声音，电平表却是死的。 */
            {
                int32_t pk = 0;
                for (k = 0; k < frames; ++k) {
                    int32_t a = out[k * 2] < 0 ? -(int32_t)out[k * 2] : out[k * 2];
                    int32_t b = out[k * 2 + 1] < 0 ? -(int32_t)out[k * 2 + 1] : out[k * 2 + 1];
                    if (a > pk) pk = a;
                    if (b > pk) pk = b;
                }
                ka_lock();
                g_peak = (pk * 1000) / 32768;
                ka_unlock();
            }
            return;
        }
    } else {
        int nl, nn, sched;
        g_was_playing = 1;
        /* 本块要触发的音符（音符表按 start 升序，见 ka_set_notes）。 */
        nl = g_nlive;
        nn = g_nn[nl];
        sched = g_sched[nl];
        while (sched < nn) {
            const ka_note* n = &g_notes[nl][sched];
            int delay;
            if (n->start >= pos_end) break;
            /* 迟到了也要响，不能丢。老写法是 `if (n->start < pos) { g_sched++; continue; }` ——
             * 位置一旦被下面的漂移修正往前推过这个音的起点，它就**永远**没人管了，
             * 用户听到的就是"这一段里少了几个音"。晚一点点总比没有强：
             * delay 夹成 0，这一块开头立刻补发。 */
            delay = (int)(n->start - pos);
            if (delay < 0) { delay = 0; g_late = g_late + 1; }
            if (delay >= frames) delay = frames - 1;
            /* 这条轨装着插件 → 声音在 worker 那边，合成器别跟着响（2b：每轨一个实例）。
             * 合成器整体关着的时候（现在就是：声音只来自乐器）这里照样进 ka_trigger ——
             * 采样分支还要走，只把合成器那半截挡在里面。 */
            if (!ka_track_has_plugin(n->track)) ka_trigger(n, delay, 0);
            g_fired = g_fired + 1;
            sched = sched + 1;
        }
        g_sched[nl] = sched;
        g_sched_end = pos_end;
    }

    /* 试听音：不挂在时间轴上，从"现在"起响 0.7 秒。起点用 g_aud_clock 而不是 pos ——
     * 暂停时 pos 是钉住的，拿它算长度这个音就永远到不了头。 */
    if (g_pend_note >= 0) {
        ka_note pn;
        pn.track = g_pend_track;
        pn.note = g_pend_note;
        pn.vel = g_pend_vel;
        pn.pad = 0;
        pn.start = g_aud_clock;
        pn.len = (int64_t)((float)g_rate_eff * 0.7f);   /* g_aud_clock 数的是输入帧 */
        /* aud=1：混音时绕开轨道增益 —— 试听不该被 M/S 掐掉，也不该因为还没推过
         * 轨道表（tn==0，g_tgl[] 全是 0）就一声不出。 */
        ka_trigger(&pn, 0, 1);
        g_pend_note = -1;
    }

    {
        float peak = 0.0f;
        /* 暂停时时间轴由 g_aud_clock 顶上（g_pos 钉在时钟上不动），否则试听音的
         * "到点了松手"永远判不到。 */
        int64_t base = playing ? pos : g_aud_clock;
        int off = 0;
        while (off < frames) {
            /* 限幅要"先看后压"：先把一个子块混成浮点、量出峰值，再统一乘增益。
             * 逐样本压会让增益跟着波形每个周期上下抽动，给和弦塞进互调分量
             * （实测那样做 gain 1.5 时 inharm 仍有 2.2%，等于没修）。子块内增益恒定，
             * 子块之间线性过渡 —— 稳态和弦完全不变形，瞬态由饱和曲线兜底。 */
            float bpeak = 0.0f, g0, gnew, tgt;
            int n = frames - off, ramp;
            if (n > KA_FRAMES) n = KA_FRAMES;

            for (i = 0; i < n; ++i) {
                float l = 0.0f, r = 0.0f;
                int64_t here = base + off + i;

                /* 轨道增益朝这一块的目标走一小步（见块首）。放在混音之前，
                 * 第一个样本就已经在过渡路径上，块边界不会出现台阶。 */
                for (t = 0; t < KA_MAX_TRACKS; ++t) {
                    g_tgl[t] += dl[t];
                    g_tgr[t] += dr[t];
                }

                for (v = 0; v < KA_VOICES; ++v) {
                    ka_voice* vo = &g_voice[v];
                    float s, s2;
                    if (!vo->active) continue;
                    if (vo->delay > 0) { vo->delay = vo->delay - 1; continue; }

                    if (vo->zone) {
                        /* 采样声部：换过乐器就当场掐掉（zone 指着上一槽的内存）。 */
                        if (vo->zone_gen != g_sfz_gen) { vo->active = 0; continue; }
                        s = sfz_read(vo->zone, &vo->sp, vo->step);
                        if (!vo->zone->loop_mode && vo->sp >= (double)vo->zone->frames
                            && vo->stage != S_RELEASE) {
                            vo->stage = S_RELEASE;      /* 采样播到头 = 松手，走 release 尾音 */
                        }
                    } else {
                        s = ka_osc(vo->wave, vo->phase, vo->inc, &vo->rng);
                        if (vo->noise_mix > 0.0f) {
                            float nz = ka_noise(&vo->rng);
                            s = s * (1.0f - vo->noise_mix) + nz * vo->noise_mix;
                        }
                        if (vo->inc > 0.0f) {
                            vo->phase += vo->inc;
                            if (vo->phase >= 1.0f) vo->phase -= 1.0f;
                            if (vo->inc_sweep > 0.0f) vo->inc += (vo->inc_target - vo->inc) * vo->inc_sweep;
                        }
                    }

                    /* 包络 */
                    if (vo->stage == S_ATTACK) {
                        vo->env += vo->atk_inc;
                        if (vo->env >= 1.0f) { vo->env = 1.0f; vo->stage = S_DECAY; }
                    } else if (vo->stage == S_DECAY) {
                        vo->env = vo->sus + (vo->env - vo->sus) * vo->dec_coef;
                        if (vo->env < vo->sus + 0.0008f) { vo->env = vo->sus; vo->stage = S_SUSTAIN; }
                    } else if (vo->stage == S_RELEASE) {
                        vo->env *= vo->rel_coef;
                        if (vo->env < 0.0006f) { vo->active = 0; continue; }
                    }
                    if (here >= vo->end && vo->stage != S_RELEASE) vo->stage = S_RELEASE;

                    s = s * vo->env * vo->amp;
                    /* 试听音直接进总线（只带 zone 自己的声像）：它的音量由 vel 决定，
                     * 不吃轨道增益 —— 否则"还没推过轨道表"或"这条轨被 M 掉"就变成一声不出。 */
                    if (vo->aud) {
                        l += s * vo->pl;
                        r += s * vo->pr;
                    } else if (vo->zone) {
                        /* 采样已经录好了音色，不再过那个"磨高频"的低通，只走 zone 自己的声像。 */
                        l += s * vo->pl * g_tgl[vo->track];
                        r += s * vo->pr * g_tgr[vo->track];
                    } else {
                        vo->lp += (s - vo->lp) * vo->lp_coef;  /* 一阶低通：把锯齿的高频磨掉 */
                        s2 = vo->lp;
                        l += s2 * g_tgl[vo->track];
                        r += s2 * g_tgr[vo->track];
                    }
                }

                g_dry[i * 2] = l;
                g_dry[i * 2 + 1] = r;
                if (l > bpeak) bpeak = l; if (-l > bpeak) bpeak = -l;
                if (r > bpeak) bpeak = r; if (-r > bpeak) bpeak = -r;
            }

            /* 左右联动、不动声像：这一子块共用一个目标增益。
             * 参考电平取"最大值 + 慢回落"，不直接跟每一块的峰值走 ——
             * 跟峰值走的话，和弦自己的拍频会让增益跟着一起摆，又变成互调。 */
            if (bpeak > g_lim_env) g_lim_env = bpeak;
            else {
                float env = g_lim_env;
                for (i = 0; i < n; ++i) env *= lim_env_coef;
                g_lim_env = env;
            }
            tgt = (g_lim_env > KA_LIM_THRESH) ? (KA_LIM_THRESH / g_lim_env) : 1.0f;
            if (tgt > 1.0f) tgt = 1.0f;
            g0 = g_lim;
            /* 往下压要快（起音/瞬态），往上放要慢（避免抽气）。
             * 释放还走一级 120ms 的平滑：参考电平每块是台阶式更新的，
             * 直接照抄会让增益变成 93Hz 的锯齿，又给频谱添一排边带。 */
            if (tgt < g0) gnew = tgt;
            else {
                float step = (float)n / (0.120f * (float)g_rate_eff);
                if (step > 1.0f) step = 1.0f;
                gnew = g0 + (tgt - g0) * step;
            }
            /* 压得不够快时，多出来的那一点由 ka_sat 兜 —— 它只是变厚，不会硬削。 */
            ramp = n;
            if (gnew < g0) { ramp = n / 8; if (ramp < 1) ramp = 1; }
            for (i = 0; i < n; ++i) {
                float g = gnew;
                float l, r;
                if (i < ramp) g = g0 + (gnew - g0) * ((float)(i + 1) / (float)ramp);
                l = ka_sat(g_dry[i * 2] * g);
                r = ka_sat(g_dry[i * 2 + 1] * g);

                if (l > peak) peak = l; if (-l > peak) peak = -l;
                if (r > peak) peak = r; if (-r > peak) peak = -r;

                out[(off + i) * 2] = (int16_t)(l * 30000.0f);
                out[(off + i) * 2 + 1] = (int16_t)(r * 30000.0f);
            }
            g_lim = gnew;
            off += n;
        }
        ka_lock();
        g_peak = (int32_t)(peak * 1000.0f);
        ka_unlock();

        /* 插件那一层在另一个进程里，它的声音从 ring 回来 —— 混在这儿，而不是让它自己出声。 */
        ka_plug_mix(out, frames, playing, pos);
    }
}

/* 设备播到哪一帧（定义在导出那一节，这里先用一下）。 */
static int64_t ka_device_played(void);

/* ── 音频线程 ─────────────────────────────────────────────────────────────────────────────── */
static uint32_t __stdcall ka_audio_thread(void* arg) {
    (void)arg;
    for (;;) {
        int i, wrote = 0;
        uint32_t err;
        int64_t want = 0;
        int playing;

        if (g_stop) break;
        g_loops = g_loops + 1;

        /* 每块问一次「现在该播到哪」。clock 是权威，这里只跟。 */
        if (g_kc_frames && g_kc_playing) {
            want = g_kc_frames();
            playing = g_kc_playing();
            /* 注意别用 g_was_playing —— 那是渲染块里判"播放→暂停"边沿的，语义不同。
             * 这里是音频线程自己的上一圈状态。 */
            if (playing && !g_thr_playing_prev) { g_need_sync = 1; ka_plug_epoch(); }   /* 0→1：重新对表 */
            g_thr_playing_prev = playing;
        } else {
            want = g_free_pos;
            playing = 1;
            g_free_pos += KA_FRAMES;
        }

        if (playing) {
            /* 同步的靶子不是"钟现在在哪"，而是"**这一块出声的时候**钟会在哪"。
             *
             * 老写法拿 g_pos 直接跟 want 比，而 g_pos 是"已经渲染到第几帧" —— 渲染出来的
             * 东西还要在设备里排队 ~2048 帧（42ms）才出声。于是这个比较天生就差一个输出延迟，
             * 而修正逻辑还拼命把这个差拉回 0：每块把 g_pos 往回拽，拽得比设备消耗还快，
             * 同一段时间被渲染第二遍，落在里面的音符就成了"迟到补发"（实测 late=4）。
             * 更糟的是**拉平之后声音就正好晚 42ms** —— 这就是"与播放器同步很差"。
             *
             * 正确的靶子：target = want + 还压在设备里的帧数。等这一块真的出声时，
             * 钟刚好走到 target。这样自然状态下 delta ≈ 0，几乎不需要修正；
             * 需要修的只剩"设备晶振与公共时钟真的对不上"那一点，量级是每块几帧。 */
            int64_t played = ka_device_played();
            int64_t q, queued, target, delta, ad;
            if (played >= 0) {
                q = g_written - played;
                if (q < 0) q = 0;
                if (q > (int64_t)KA_BUFS * KA_FRAMES) q = (int64_t)KA_BUFS * KA_FRAMES;
                /* 第一个采样直接落位，不从 0 平滑上来 —— 否则开机那 85ms 里滤波器
                 * 一直低估排队帧数，delta 是个假的 -3000，慢积分要几秒才爬回来。 */
                if (g_need_sync) g_queued_q8 = q << 8;
                else g_queued_q8 += ((q << 8) - g_queued_q8) >> 3;  /* 一阶平滑 */
            }
            /* 设备把队列抽干了 = 这一刻没东西给它播 = 一处爆音。 */
            if (played >= 0 && g_written - played <= 0) g_starve = g_starve + 1;
            queued = g_queued_q8 >> 8;
            if (queued < 0) queued = 0;
            if (queued > (int64_t)KA_BUFS * KA_FRAMES) queued = (int64_t)KA_BUFS * KA_FRAMES;

            /* 开播吸附一次位置，但**绝不碰 g_sched**。
             *
             * 为什么必须吸附：开播那一刻设备里还是空的，queued 读到 0，于是靶子
             * target = want + 0 —— 可这一块其实要等"设备延迟"才出声。等队列填满之后
             * queued 才是真的（本机 ≈2700 帧 = 56ms）。不吸附的话这 56ms 全靠慢积分去追，
             * 实测稳态偏差中位数从 127 帧涨到 558、峰值涨到 3250 —— 开机头几秒明显不同步。
             *
             * 为什么不能配二分查找：试过 `g_sched = 第一个 start >= g_pos 的音`，
             * 结果 fired 从 48 掉到 47 —— **跳过去那一段里的音符既不响也不算 late**
             * （late 仍然是 0），就这么被静默丢掉了，正是用户说的"有音节没响"。
             * 不碰 g_sched 的话，跨界的那一个音会走调度器里那条"迟到了也要响"的支路，
             * 当场补发 —— 它本来就该响（时间线上它还没结束），补发是对的。
             *
             * 真 seek（|delta| > 125ms）走下面那个分支，那里**要**二分查找：
             * 用户主动拖了播放头，跳过去的那段本来就不该再响。 */
            {
                /* 时钟自己跳没跳，与 queued 无关 —— 见下面那段"要看时钟"的注释。
                 * 这里还得**提前**算一次：吸附若抢在前面把 g_pos 挪到 want+queued 上，
                 * 下面那句 `ad > rate/8` 就永远判不出这是一次拖播放头。 */
                int64_t jump = want - g_pos;
                if (jump < 0) jump = -jump;
                g_need_sync = g_need_sync && !(jump > (int64_t)(g_rate / 8));
            }
            if (g_need_sync && played > 0) {
                g_need_sync = 0;
                g_pos = want + queued;
                g_pos_frac_q20 = 0;
                g_corr_q8 = 0;
                g_win_played = -1;
                g_win_n = 0;
                g_drift_max = 0;
                ka_plug_epoch();                 /* 位置跳过了：插件的游标也要跟着跳 */
            }
            /* ── 真速率测量（每约 1 秒结算一次） ──────────────────────────────────
             * 拿"设备实际播了多少输入帧"比"权威时钟走了多少时间线帧"，两者之比就是要的
             * 重采样比。
             *
             * **累计式，不是滑窗式。** waveOutGetPosition 是 512 一跳的阶梯，1 秒窗口的
             * 两个端点各自能差半块 —— 48000 上就是 ±1%，比要测的那 0.7% 还大，滑窗量
             * 出来的全是噪声（实测比值一直在 1.000 附近乱跳，看不出设备其实是慢的）。
             * 累计从开播那一刻算起，样本越长噪声越小；权重 1/(n+1) 递减到 1/8，
             * 换设备时还能跟得上。
             */
            if (played >= 0) {
                if (g_win_played < 0) { g_win_played = played; g_win_want = want; g_win_n = 0; }
                else if (played - g_win_played >= (int64_t)g_rate) {
                    int64_t dp = played - g_win_played;
                    int64_t dw = want - g_win_want;
                    if (dp > 0 && dw > 0) {
                        double r = (double)dw / (double)dp;
                        int64_t tgt, wq;
                        if (r < 0.90) r = 0.90;
                        if (r > 1.10) r = 1.10;
                        tgt = (int64_t)(r * 1048576.0);
                        wq = (int64_t)g_win_n + 1;
                        if (wq > 8) wq = 8;
                        g_ratio_q20 += (tgt - g_ratio_q20) / wq;
                        g_rate_eff = (int)((double)g_rate * 1048576.0 / (double)g_ratio_q20 + 0.5);
                        if (g_rate_eff < 8000) g_rate_eff = 8000;
                        if (g_rate_eff > 192000) g_rate_eff = 192000;
                        g_win_n = g_win_n + 1;
                    }
                }
            }

            target = want + queued;
            delta = target - g_pos;
            ad = delta < 0 ? -delta : delta;
            /* **是不是"播放头被拖走了"，要看时钟自己跳没跳，不能看 delta。**
             * delta 里混着 queued（本机常驻 ~2700 帧），而开播吸附会先把 g_pos 挪到
             * want+queued 上，等轮到下面这行判定时 delta 已经是 0 了 —— 实测结果就是
             * seek 到 2 秒之后 seeks 仍然是 0（`test_audio.py` 的那一项因此 FAIL）。
             * 这里单独拿 want 与 g_pos 比：稳态下它恒 ≈ queued（< 3072），
             * 只有真的拖了播放头才会超过 125ms。 */
            {
                int64_t jump = want - g_pos;
                if (jump < 0) jump = -jump;
                if (jump > (int64_t)(g_rate / 8)) ad = jump + 1;
            }
            g_drift = (int64_t)delta > 2147483647LL ? 2147483647 : (int32_t)delta;
            /* 头几块不算：设备还没开始报位置，queued 从 0 爬到满，这期间的大偏差是
             * 开机过程不是失步 —— 记进来会让 drift_max 永远显示开机那一下，看不出真问题。 */
            if (played > 0 && g_written > (int64_t)KA_BUFS * KA_FRAMES && ad > (int64_t)g_drift_max)
                g_drift_max = (int32_t)ad;
            if (ad > (int64_t)(g_rate / 8)) {   /* >125ms：换位置了（播放/暂停/seek） */
                g_pos = target;
                g_pos_frac_q20 = 0;
                g_corr_q8 = 0;
                g_win_played = -1;
                g_win_n = 0;
                ka_voice_off_all();
                g_seeks = g_seeks + 1;
                ka_plug_epoch();
                /* ring 里压着的是**旧位置**的块（最多 8 块 ≈ 85ms）。不清掉的话，新位置
                 * 的头几十毫秒会和旧位置的尾巴叠在一起 —— 循环回卷时听感就是"重复音"。
                 * 游标一并丢掉，worker 才有空位按新锚点重新渲。 */
                {
                    int pi;
                    for (pi = 0; pi < KA_MAX_PLUG; ++pi) {
                        ka_shm* ps = g_plugs[pi].shm;
                        if (ps) ps->r = ps->w;
                    }
                }
                g_drift_max = 0;
                /* 音符指针重新二分到 pos（表按 start 升序）。 */
                {
                    int nl = g_nlive;
                    g_sched[nl] = ka_note_index_at(g_notes[nl], g_nn[nl], g_pos);
                    g_sched_end = g_pos;
                }
            } else {
                /* 小漂移：慢慢追，别硬跳（硬跳会咔嚓）。
                 *
                 * 两处都改了：
                 * ① **没有死区**。老写法要 |delta| > 256 才动手，于是偏差永远修不到 256 以内：
                 *    修到 255 就放手，自由漂回 256 以上再修 —— 实测就在 -200..-700 之间来回。
                 *    修正量本身是 delta/8 且夹了上限，delta 小的时候动作自然就小，
                 *    不需要靠死区防抖；死区只会留下一个"修不掉的偏差"。
                 * ② **修正按"块"施加，不按"循环次数"施加**。循环一圈可能渲染 0 块也可能 2 块，
                 *    而 g_pos 是每块 +512。老写法在循环开头改 g_pos —— 两种速率不一致，
                 *    结果就是一个振幅好几百帧的锯齿（实测 drift 在 -100..-730 之间规律地荡）。
                 *    这里只算出一个"每块该多走/少走几帧"的量，落块的时候才真的加进去。
                 * ③ **增益 1/256，不是 1/8**。这台机器的 waveOutGetPosition 是几秒才跳
                 *    一次的阶梯（实测 raw_q 在 2384..2914 之间以约 5.5 秒为周期锯齿），
                 *    瞬时值里的噪声比要修的误差还大。1/8 的时间常数是 85ms —— 完全在噪声
                 *    频段里，于是它就在追噪声（实测 drift 跟着锯齿在 -39..-503 之间荡）。
                 *    1/256 的时间常数是 2.7 秒，阶梯噪声被积分成每块 ±2 帧，只剩真正的
                 *    长期误差会被修掉。开播那一次大跳由上面的硬对表负责，不靠它。 */
                int64_t c = delta / 256;
                int64_t cap = KA_FRAMES / 4;
                if (c > cap) c = cap;
                if (c < -cap) c = -cap;
                g_corr_q8 = c << 8;
            }
        }

        for (i = 0; i < KA_BUFS; ++i) {
            if (g_hdr[i].dwFlags & WHDR_DONE_) {
                g_hdr[i].dwFlags &= ~WHDR_DONE_;
                /* 试听钟每渲染一块走一块 —— 挂在渲染上而不是循环上，才跟"实际出了多少帧"一致。 */
                g_aud_clock += KA_FRAMES;
                ka_render_block(g_pcm[i], KA_FRAMES, g_pos, playing);
                /* 位置的推进只在这里发生：
                 *   基准 = 这一块的输入帧数 × 重采样比（把"设备慢 0.76%"折进去）
                 *   再加上修正量（把剩下的相位差慢慢抹掉）
                 * 两者同一个节拍 —— 按循环次数修正是会荡的，见上面那段注释。
                 * 小数部分留着：每块 0.0077 帧看着小，一秒 94 块就是 7 帧。 */
                if (playing) {
                    int64_t adv = (int64_t)KA_FRAMES * g_ratio_q20 + g_pos_frac_q20 + ((g_corr_q8 >> 8) << 20);
                    g_pos_frac_q20 = adv & ((1 << 20) - 1);
                    g_pos += adv >> 20;
                }
                err = waveOutWrite(g_hwo, &g_hdr[i], (uint32_t)sizeof(WAVEHDR));
                if (err == MMSYSERR_NOERROR_) { g_wr_ok = g_wr_ok + 1; g_written += KA_FRAMES; }
                else g_wr_err = (int32_t)err;
                wrote = 1;
            }
        }
        if (!wrote) Sleep(2);
    }
    return 0;
}

/* ── 导出 ─────────────────────────────────────────────────────────────────────────────────── */
__declspec(dllexport) int ka_version(void) { return KA_VERSION; }

/** 绑上公共时钟。传 KolidClock.dll 的绝对路径；失败返回 0（此后按内部帧计数自由跑）。 */
__declspec(dllexport) int ka_bind_clock(const char* path) {
    void* mod;
    if (!path) return 0;
    mod = LoadLibraryA(path);
    if (!mod) return 0;
    g_kc_frames = (kc_frames_fn)GetProcAddress(mod, "kc_frames");
    g_kc_playing = (kc_playing_fn)GetProcAddress(mod, "kc_playing");
    if (!g_kc_frames || !g_kc_playing) {
        g_kc_frames = 0;
        g_kc_playing = 0;
        return 0;
    }
    g_kc_mod = mod;
    return 1;
}

__declspec(dllexport) int ka_clock_bound(void) { return (g_kc_frames && g_kc_playing) ? 1 : 0; }

__declspec(dllexport) int ka_open(int rate) {
    WAVEFORMATEX fmt;
    uint32_t err;
    int i;

    if (g_open) return 0;
    if (rate < 8000 || rate > 192000) rate = KA_RATE;

    g_rate = rate;
    g_rate_eff = rate;            /* 先按标称算，设备的真速率测出来之后会被改掉 */
    fmt.wFormatTag = (uint16_t)WAVE_FORMAT_PCM_;
    fmt.nChannels = 2;
    fmt.nSamplesPerSec = (uint32_t)rate;
    fmt.nBlockAlign = 4;
    fmt.nAvgBytesPerSec = (uint32_t)rate * 4u;
    fmt.wBitsPerSample = 16;
    fmt.cbSize = 0;

    err = waveOutOpen(&g_hwo, WAVE_MAPPER_, &fmt, 0, 0, 0);
    if (err != MMSYSERR_NOERROR_) { g_hwo = 0; return (int)err; }

    for (i = 0; i < KA_BUFS; ++i) {
        g_hdr[i].lpData = (char*)g_pcm[i];
        g_hdr[i].dwBufferLength = (uint32_t)(KA_FRAMES * 2 * 2);
        g_hdr[i].dwBytesRecorded = 0;
        g_hdr[i].dwUser = 0;
        g_hdr[i].dwFlags = 0;
        g_hdr[i].dwLoops = 0;
        g_hdr[i].lpNext = 0;
        g_hdr[i].reserved = 0;
        if (waveOutPrepareHeader(g_hwo, &g_hdr[i], (uint32_t)sizeof(WAVEHDR)) != MMSYSERR_NOERROR_) {
            waveOutClose(g_hwo);
            g_hwo = 0;
            return -2;
        }
        /* prepare **重写** dwFlags（只留 WHDR_PREPARED），「已完成」位必须在它之后补，
         * 否则线程一块也等不到 —— 症状是设备开着、位置恒为 0、一声不响。 */
        g_hdr[i].dwFlags |= WHDR_DONE_;
    }

    ka_init_pitch();
    for (i = 0; i < KA_VOICES; ++i) { g_voice[i].active = 0; g_voice[i].env = 0.0f; }
    g_pos = 0;
    g_free_pos = 0;
    g_written = 0;
    g_queued_q8 = 0;
    g_corr_q8 = 0;
    g_ratio_q20 = 1 << 20;
    g_pos_frac_q20 = 0;
    g_win_played = -1;
    g_win_want = 0;
    g_win_n = 0;
    g_need_sync = 1;
    g_thr_playing_prev = 0;
    g_sched[0] = 0;
    g_sched[1] = 0;
    g_sched_end = 0;
    g_lim = 1.0f;
    g_lim_env = 0.0f;
    g_wr_ok = 0;
    g_wr_err = 0;
    g_loops = 0;
    g_seeks = 0;
    g_peak = 0;
    g_stop = 0;
    timeBeginPeriod(1);           /* 与 ka_close 里的 timeEndPeriod 配对 */
    g_thread = CreateThread(0, 0, ka_audio_thread, 0, 0, 0);
    if (g_thread) {
        /* 提一级优先级。这一层是"给设备供样本"的人：被别的线程挤掉一次就是一处爆音，
         * 而爆音在听感上就是"音质很差" —— 跟波形好不好是两回事。
         * 只提一级（ABOVE_NORMAL），不提 TIME_CRITICAL：那会把别的线程饿死，
         * 在 ComfyUI 这种满载的进程里反而更糟。 */
        SetThreadPriority(g_thread, KA_THREAD_PRIORITY_ABOVE_NORMAL);
    }
    if (!g_thread) {
        waveOutClose(g_hwo);
        g_hwo = 0;
        return -3;
    }
    g_open = 1;
    return 0;
}

__declspec(dllexport) void ka_close(void) {
    int i;
    if (!g_open) return;
    g_stop = 1;
    if (g_thread) { WaitForSingleObject(g_thread, 2000); g_thread = 0; }
    waveOutReset(g_hwo);
    Sleep(60);
    for (i = 0; i < KA_BUFS; ++i) waveOutUnprepareHeader(g_hwo, &g_hdr[i], (uint32_t)sizeof(WAVEHDR));
    waveOutClose(g_hwo);
    timeEndPeriod(1);
    g_hwo = 0;
    g_open = 0;
    g_stop = 0;
    for (i = 0; i < KA_VOICES; ++i) { g_voice[i].active = 0; g_voice[i].env = 0.0f; }
    g_peak = 0;
}

__declspec(dllexport) int ka_is_open(void) { return g_open; }
__declspec(dllexport) int ka_sample_rate(void) { return g_rate; }

/** 设备真实播放到第几帧 —— 驱动报的，不是我们算的，所以能证明声音真的出去了。 */
/** 设备播到哪一帧了（它自己的计数）。拿不到就 -1。 */
static int64_t ka_device_played(void) {
    MMTIME t;
    uint32_t* raw = (uint32_t*)&t;
    int i;
    if (!g_open) return -1;
    for (i = 0; i < 6; ++i) raw[i] = 0;
    t.wType = TIME_SAMPLES_;
    if (waveOutGetPosition(g_hwo, &t, (uint32_t)sizeof(MMTIME)) != MMSYSERR_NOERROR_) return -1;
    return (int64_t)t.sample;
}

__declspec(dllexport) int64_t ka_played(void) { return ka_device_played(); }

/** 还压在设备里没出声的帧数（= 输出延迟）。同步要用它把"渲染位置"和"听到位置"对齐。 */
__declspec(dllexport) int64_t ka_latency(void) {
    int64_t p = ka_device_played();
    int64_t q;
    if (p < 0) return -1;
    q = g_written - p;
    if (q < 0) q = 0;
    if (q > (int64_t)KA_BUFS * KA_FRAMES) q = (int64_t)KA_BUFS * KA_FRAMES;
    return q;
}

__declspec(dllexport) int ka_peak(void) { return g_peak; }
__declspec(dllexport) int64_t ka_position(void) { return g_pos; }

/** 诊断：圈数 / write 成功 / 最后写错误 / 峰值 / 是否打开 / 声部数 / seek 次数 / 是否绑时钟 */
__declspec(dllexport) int ka_debug(int32_t* out, int n) {
    if (!out || n < 8) return 0;
    out[0] = g_loops;
    out[1] = g_wr_ok;
    out[2] = g_wr_err;
    out[3] = g_peak;
    out[4] = g_open;
    out[5] = g_voices_used;
    out[6] = g_seeks;
    out[7] = (g_kc_frames && g_kc_playing) ? 1 : 0;
    /* 8..13 是播放质量那一组。n 不够就只给前 8 个 —— 老调用方不受影响。 */
    if (n < 14) return 8;
    out[8]  = g_fired;        /* 真的触发了几个音 */
    out[9]  = g_late;         /* 其中有几个是迟到补发的 */
    out[10] = g_steals;       /* 抢过几次声部 */
    out[11] = g_drift;        /* 当前 引擎位置 - 权威时钟（帧，带符号） */
    out[12] = g_drift_max;    /* 上一次硬跳以来最大偏差 */
    out[13] = g_voices_used;
    if (n < 16) return 14;
    out[14] = (int32_t)(g_queued_q8 >> 8);      /* 平滑后的排队帧数 */
    out[15] = (int32_t)(g_written - ka_device_played());   /* 原始排队帧数（阶梯） */
    if (n < 18) return 16;
    out[16] = g_rate_eff;                                  /* 实测出来的设备真速率 */
    out[17] = (int32_t)(g_ratio_q20 * 1000 >> 20);         /* 重采样比 ×1000（1000 = 1.000） */
    if (n < 19) return 18;
    out[18] = g_starve;
    return 19;
}

/** 把播放质量那一组计数清零（跑闸之前调，不然上一次的数会混进来）。 */
__declspec(dllexport) void ka_stats_reset(void) {
    g_fired = 0; g_late = 0; g_steals = 0;
    g_drift = 0; g_drift_max = 0;
    g_seeks = 0;
}

/* ── 离线渲染（测试 / 将来的导出）──────────────────────────────────────────────────────────
 *
 * 设备那条路上，一块什么时候来、播放头在哪，都由声卡和时钟说了算 —— 所以"音色听起来毛躁"
 * 这种事没法在播放中稳定复现，只能靠耳朵。这里给测试一条**确定性**的路：不碰设备、不读时钟，
 * 同一条音符表进去，同一串样本出来。频谱、THD、循环接缝都在这一串样本上量。
 *
 * 用法（见 test_timbre.py）：ka_offline_begin(rate) → ka_set_tracks/ka_set_notes →
 * 从 pos=0 起按块调 ka_render_offline，每块把 pos 前移 frames。
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/** 重置渲染状态，不打开设备。必须在推音符表之前调。 */
__declspec(dllexport) void ka_offline_begin(int rate) {
    int i;
    if (rate < 8000 || rate > 192000) rate = KA_RATE;
    g_rate = rate;
    g_rate_eff = rate;
    g_ratio_q20 = 1 << 20;
    g_pos_frac_q20 = 0;
    g_corr_q8 = 0;
    g_sched[0] = 0;
    g_sched[1] = 0;
    g_sched_end = 0;
    g_pos = 0;
    g_aud_clock = 0;
    g_was_playing = 0;
    g_peak = 0;
    g_lim = 1.0f;
    g_lim_env = 0.0f;
    for (i = 0; i < KA_VOICES; ++i) {
        g_voice[i].active = 0;
        g_voice[i].env = 0.0f;
        g_voice[i].zone = 0;
    }
    ka_init_pitch();
}

/** 渲染一块到 out（交错立体声 int16）。pos 是该块第一帧的时间线位置。 */
__declspec(dllexport) int ka_render_offline(int16_t* out, int frames, int64_t pos, int playing) {
    if (!out || frames <= 0) return -1;
    ka_render_block(out, frames, pos, playing ? 1 : 0);
    return frames;
}

/* 两张表是不是一模一样。重推同一份工程是常态（拖界面、切选择、开音色窗），
 * 表没变就不该叫醒 worker —— 每一次 notes_gen 变号都等于让它重排一次调度。 */
static int ka_notes_same(const ka_note* a, int an, const ka_note* b, int bn) {
    int i;
    if (an != bn) return 0;
    for (i = 0; i < an; ++i) {
        if (a[i].track != b[i].track || a[i].note != b[i].note || a[i].vel != b[i].vel
            || a[i].pad != b[i].pad || a[i].start != b[i].start || a[i].len != b[i].len) return 0;
    }
    return 1;
}

static int ka_tracks_same(const ka_track* a, int an, const ka_track* b, int bn) {
    int i;
    if (an != bn) return 0;
    for (i = 0; i < an; ++i) {
        if (a[i].program != b[i].program || a[i].channel != b[i].channel
            || a[i].vel_scale != b[i].vel_scale || a[i].gain != b[i].gain
            || a[i].pan != b[i].pan || a[i].mute != b[i].mute || a[i].solo != b[i].solo) return 0;
    }
    return 1;
}

/** 整张音符表推过来（必须按 start 升序，前端那边排好）。
 *  `notes == NULL && count == 0` 是**清空**（工程里的音全删了）—— 早先这里把 NULL 一律
 *  当坏参数挡掉，于是清空的表从来没落到引擎里，旧音符会一直在后台响。 */
__declspec(dllexport) int ka_set_notes(const ka_note* notes, int count) {
    int nl, i;
    int64_t prev = -1;
    if (count < 0) return -1;
    if (!notes && count > 0) return -1;
    if (count > KA_MAX_NOTES) count = KA_MAX_NOTES;
    nl = g_nlive ? 0 : 1;
    for (i = 0; i < count; ++i) {
        g_notes[nl][i] = notes[i];
        if ((int)g_notes[nl][i].track < 0) g_notes[nl][i].track = 0;
        if (g_notes[nl][i].len < 1) g_notes[nl][i].len = 1;
        /* 顺手校验升序：错序会让二分调度跳过音符，这里直接钳住。 */
        if (g_notes[nl][i].start < prev) g_notes[nl][i].start = prev;
        prev = g_notes[nl][i].start;
    }
    if (ka_notes_same(g_notes[nl], count, g_notes[g_nlive], g_nn[g_nlive])) return count;
    g_nn[nl] = count;
    /* 调度指针落在**新表**的"当前位置"上，不能归零：
     * 播放途中改工程 / 换选择会把整张谱重新推一遍，归零 = 从第 0 帧开始把
     * 已经播过的音全部重放一遍。一瞬间几十个音同时起音、互相抢声部，
     * 听感就是"糊成一片 + 毛刺"（离线复现：一次重推补发 116 个音、抢 24 次声部）。
     *
     * 用 g_sched_end（调度已经处理到的时间线位置）而不是 g_pos：后者可能正指向
     * 正在渲染的那一块，从它算会把这一块里刚响过的音再来一遍。最后才切 g_nlive，
     * 音频线程要么看到「旧表 + 旧下标」，要么看到「新表 + 新下标」。 */
    g_sched[nl] = ka_note_index_at(g_notes[nl], count, g_sched_end);
    g_nlive = nl;
    ka_plug_push_notes();
    return count;
}

__declspec(dllexport) int ka_set_tracks(const ka_track* tracks, int count) {
    int tl, i;
    if (!tracks || count < 0) return -1;
    if (count > KA_MAX_TRACKS) count = KA_MAX_TRACKS;
    tl = g_tlive ? 0 : 1;
    for (i = 0; i < count; ++i) {
        g_tracks[tl][i] = tracks[i];
        if (g_tracks[tl][i].gain <= 0.0f) g_tracks[tl][i].gain = 1.0f;
        if (g_tracks[tl][i].vel_scale <= 0.0f) g_tracks[tl][i].vel_scale = 1.0f;
    }
    /* 一字不差就别换表：下面那次 ka_plug_push_notes 会让每个槽的音符表 generation 变号，
     * worker 于是把调度重排一遍 —— 表没变的时候这纯属白叫醒。 */
    if (ka_tracks_same(g_tracks[tl], count, g_tracks[g_tlive], g_tn[g_tlive])) return count;
    g_tn[tl] = count;
    g_tlive = tl;
    ka_plug_push_notes();          /* 通道/静音/独奏/力度都在这张表里 */
    return count;
}

__declspec(dllexport) void ka_all_notes_off(void) {
    ka_lock();
    ka_voice_off_all();
    ka_unlock();
}

/** 试听一个音（界面点 ♪ 用的）。下一块开头由音频线程接手，0.7 秒后自然结束。 */
__declspec(dllexport) void ka_audition(int note, int vel, int track) {
    if (note < 0 || note > 127 || vel <= 0) return;
    /* 这条轨的乐器在插件里 —— 合成器这条路上没有它的音色，敲下去只会是假的 GM 钢琴。
     * track < 0 = 试听槽（采样乐器专用），不对应工程里的任何一条轨，别拿第 0 条去挡它。 */
    if (track >= 0 && ka_track_has_plugin(track)) return;
    g_pend_track = (track < 0) ? 0 : track;
    g_pend_vel = (vel > 127) ? 127 : vel;
    g_pend_note = note;
}

/** 内置合成器闭嘴/开嘴。**界面侧常闭**（audio_bridge 开设备时调 ka_synth_off(1)）：
 *  声音只来自乐器，没装乐器的轨就该安静，不再拿 GM 合成音顶替。
 *  这根闸只挡合成器那半截（ka_trigger 里采样分支已经在它上面返回），
 *  SFZ、VST3 槽、试听槽都不受影响。
 *  打开开关时把还在响的合成器声部当场收掉。 */
__declspec(dllexport) int ka_synth_off(int off) {
    int prev = g_synth_off;
    g_synth_off = off ? 1 : 0;
    if (!prev && g_synth_off) {
        ka_lock();
        ka_voice_off_all();
        ka_unlock();
    }
    return g_synth_off;
}

/* ── SFZ 乐器 ─────────────────────────────────────────────────────────────────────────────── */
static void ka_voice_kill_all(void) {
    int i;
    for (i = 0; i < KA_VOICES; ++i) { g_voice[i].active = 0; g_voice[i].zone = 0; }
}

/** 等音频线程走完 n 块 —— 正在读采样内存的那一帧必须跑完，才允许释放。 */
static void ka_wait_blocks(int n) {
    int start = g_loops, waited = 0;
    while (g_loops - start < n && waited < 200) { Sleep(5); ++waited; }
}

/** 换/卸乐器前先把旧声部收掉：先走 8ms 释放（不"啪"），再等它们真的落到 0，
 *  最后才允许释放采样内存。以前是当场 active=0 —— 换乐器就是一声宽带咔哒。 */
static void ka_voice_fade_out_and_wait(void) {
    int i, waited = 0;
    ka_lock();
    ka_voice_off_all();
    for (i = 0; i < KA_VOICES; ++i) {
        if (g_voice[i].active) g_voice[i].rel_coef = ka_coef_for(0.008f, g_rate_eff);
    }
    ka_unlock();
    /* 8ms 时间常数 → 到 -60dB 约 55ms；5ms 一步，最多等 400ms（设备没开时也有出路）。 */
    while (waited < 80) {
        int live = 0;
        ka_lock();
        for (i = 0; i < KA_VOICES; ++i) if (g_voice[i].active) { live = 1; break; }
        ka_unlock();
        if (!live) break;
        Sleep(5);
        ++waited;
    }
    ka_lock();
    ka_voice_kill_all();       /* 超时兜底：真等不到也必须放手，不能永远卡住装载 */
    ka_unlock();
}

/**
 * 装载一个 .sfz（UTF-16 路径，中文路径不会被 ANSI 代码页吃掉）。
 * 返回 zone 数；-1 读不到 / -2 没有 region / -3 采样全部解码失败。
 */
__declspec(dllexport) int ka_load_sfz(const uint16_t* path) {
    int n;
    if (!path) return -1;
    ka_voice_fade_out_and_wait();
    ka_wait_blocks(1);          /* 让正在渲染的那一块放手，之后才允许 VirtualFree */
    n = sfz_load(path);
    return n;
}

__declspec(dllexport) void ka_unload_sfz(void) {
    ka_voice_fade_out_and_wait();
    ka_wait_blocks(1);
    sfz_unload();
    g_sfz_track = -1;
}

/** 把这套采样绑给一条轨（2b）。track >= 0 = 那条轨；-1 = 解绑；-2 = 只给试听。
 *  只决定"谁问 sfz_pick"，不动已装载的采样内存。 */
__declspec(dllexport) int ka_sfz_bind(int track) {
    if (track < -2 || track >= KA_MAX_TRACKS) return -1;
    g_sfz_track = track;
    return track;
}

/** 当前乐器：zone 数 / 解码失败的采样数 / 驻留 KB。没装乐器时三个都是 0。
 *  第三格是 KB 而不是 MB：小乐器（几百 KB）按 MB 截断会报 0，界面读起来像"没装上"。 */
__declspec(dllexport) int ka_sfz_state(int32_t* out, int n) {
    int slot = g_sfz_live;
    if (!out || n < 3) return 0;
    if (slot < 0) { out[0] = 0; out[1] = 0; out[2] = 0; return 3; }
    out[0] = g_sfz[slot].nzone;
    out[1] = g_sfz[slot].nfail;
    out[2] = (int32_t)(g_sfz[slot].bytes >> 10);   /* KB */
    return 3;
}

/** 诊断：最近一次采样解码失败在哪一步（0 = 没失败）。1 打不开文件 / 2 不是 RIFF 或 WAVE /
 *  3+ 缺 data|ch|rate|bits 的组合 / 4 内存分配失败 / 5 位深不支持。 */
__declspec(dllexport) int ka_sfz_err(void) { return g_sfz_err; }

/** 诊断：最后一步用的路径（ASCII 降级，中文会变 ?）。 */
__declspec(dllexport) const char* ka_sfz_dbg(void) { return g_sfz_dbg; }

/** 一个 zone 的说明："<name>|<keycentre>|<lokey>-<hikey>|<lovel>-<hivel>|<rate>|<frames>"。 */
__declspec(dllexport) int ka_sfz_zone(int idx, char* buf, int cap) {
    int slot = g_sfz_live;
    ka_zone* z;
    char* p = buf;
    int left;
    if (!buf || cap < 8) return 0;
    buf[0] = 0;
    if (slot < 0) return 0;
    if (idx < 0 || idx >= g_sfz[slot].nzone) return 0;
    z = &g_sfz[slot].zones[idx];
    /* 自己的小格式化：itoa 不存在，手写。 */
    {
        int i = 0;
        while (z->name[i] && i < cap - 1) { buf[i] = z->name[i]; ++i; }
        buf[i] = 0; p = buf + i;
    }
#define KA_PUT(ch) do { if ((int)(p - buf) < cap - 1) *p++ = (char)(ch); } while (0)
#define KA_NUM(v) do { \
        int _v = (v), _d = 0, _t[12], _k; \
        if (_v < 0) { KA_PUT('-'); _v = -_v; } \
        do { _t[_d++] = _v % 10; _v /= 10; } while (_v && _d < 12); \
        for (_k = _d - 1; _k >= 0; --_k) KA_PUT('0' + _t[_k]); \
    } while (0)
    KA_PUT('|'); KA_NUM(z->keycenter);
    KA_PUT('|'); KA_NUM(z->lokey); KA_PUT('-'); KA_NUM(z->hikey);
    KA_PUT('|'); KA_NUM(z->lovel); KA_PUT('-'); KA_NUM(z->hivel);
    KA_PUT('|'); KA_NUM(z->rate);
    KA_PUT('|'); KA_NUM(z->frames);
    *p = 0;
#undef KA_PUT
#undef KA_NUM
    left = cap;
    (void)left;
    return (int)(p - buf);
}

/** 测试音（保留给设备自检）：hz=0 关掉，amp 用百分比。 */
__declspec(dllexport) void ka_test_tone(int hz, int amp) {
    (void)hz; (void)amp;   /* 合成器接管后不再需要；留着是为了旧的自检脚本还能跑 */
}

/* ── VST3（经 KaPluginWorker.exe） ────────────────────────────────────────────────────────────
 *
 * 这些导出的**名字、参数、语义跟进程内那一版一模一样**，只是实现换成了"问 worker"。
 * 这样 Python 桥 / 界面 / 测试一行都不用改 —— 隔离是本层的事，不该漏到上面去。
 *
 * 多出来的只有生命周期：worker 是另一个进程，得有人把它拉起来（Python 用 subprocess），
 * 起来之后把 tag 交给 ka_plug_attach。tag 现在就是宿主 pid，保证多开 ComfyUI 互不打架。
 *
 * 负错误码分两段：插件自己的（-1..-10，见 ka_vst3.h）与**通道**的（-91 没连上 / -92 worker
 * 死了 / -93 超时 / -94 版本对不上 / -95 上一条命令还没做完）。上层要把 -92 当成"这个
 * 插件不能用"而不是"再试一次" —— 它崩一次就会崩第二次。
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

#define KA_PLUG_MS_FAST  5000
#define KA_PLUG_MS_SLOW  60000      /* 开插件/扫清单：大插件一秒很正常，给足 */

/** 命令路选一个槽。之后的 ka_vst3_* / ka_plug_* 都打在这个槽上。
 *  越界就返回 -1 且**不改**选中槽 —— 打错槽比报错可怕得多。 */
__declspec(dllexport) int ka_plug_select(int slot) {
    if (slot < 0 || slot >= KA_MAX_PLUG) return -1;
    g_plug_cur = slot;
    return slot;
}

static int ka_plug_attach_one(int slot, const uint16_t* tag) {
    uint16_t nm[160], evc[176], evd[176];
    ka_plug_slot* p = &g_plugs[slot];
    if (!tag) return -1;
    if (p->shm) return 1;
    ka_shm_names(tag, nm, evc, evd);
    p->map = OpenFileMappingW(KA_FILE_MAP_ALL_ACCESS, 0, nm);
    if (!p->map) return -2;                           /* worker 还没建好 / 名字不对 */
    p->shm = (ka_shm*)MapViewOfFile(p->map, KA_FILE_MAP_ALL_ACCESS, 0, 0, 0);
    if (!p->shm) { CloseHandle(p->map); p->map = 0; return -3; }
    if (p->shm->magic != KA_SHM_MAGIC || p->shm->abi != KA_SHM_ABI) {
        UnmapViewOfFile(p->shm); p->shm = 0;
        CloseHandle(p->map); p->map = 0;
        return KA_SHM_ERR_SHAPE;
    }
    p->evc = OpenEventW(KA_EVENT_ALL_ACCESS, 0, evc);
    p->evd = OpenEventW(KA_EVENT_ALL_ACCESS, 0, evd);
    if (!p->evc || !p->evd) {
        if (p->evc) CloseHandle(p->evc);
        if (p->evd) CloseHandle(p->evd);
        p->evc = 0; p->evd = 0;
        UnmapViewOfFile(p->shm); p->shm = 0;
        CloseHandle(p->map); p->map = 0;
        return -4;
    }
    p->shm->rate = g_rate;
    p->shm->host_beat = p->shm->host_beat + 1;
    /* 新连上的槽默认不喂任何轨。静态数组初值是 0，不写这一句的话它就会去认第 0 条轨 ——
     * 试听槽（15）没人绑它，一装上就会把第 0 轨的音弹两遍。 */
    g_plug_track_of[slot] = -1;
    g_plug_on[slot] = 0;
    return 0;
}

/** 连上第 slot 个 worker。tag 是共享内存名的后半段（每个 worker 一个，互不打架）。
 *  返回 0 / 1=已经连着 / 负数=连不上。 */
__declspec(dllexport) int ka_plug_attach_s(int slot, const uint16_t* tag) {
    if (slot < 0 || slot >= KA_MAX_PLUG) return -1;
    return ka_plug_attach_one(slot, tag);
}

/** 老签名 = 槽 0。 */
__declspec(dllexport) int ka_plug_attach(const uint16_t* tag) {
    return ka_plug_attach_one(0, tag);
}

/** 断开一个槽。worker 自己会因为"宿主心跳停了"而退出，这里只是把这一侧的映射放掉。 */
__declspec(dllexport) int ka_plug_detach_s(int slot) {
    ka_plug_slot* p;
    if (slot < 0 || slot >= KA_MAX_PLUG) return -1;
    p = &g_plugs[slot];
    g_plug_on[slot] = 0;
    g_plug_track_of[slot] = -1;
    if (!p->shm) return 0;
    p->shm->ed_mon = 0;                      /* worker 要退出了，界面监视没有意义 */
    if (p->evc) CloseHandle(p->evc);
    if (p->evd) CloseHandle(p->evd);
    UnmapViewOfFile(p->shm);
    CloseHandle(p->map);
    p->shm = 0; p->map = 0; p->evc = 0; p->evd = 0;
    return 0;
}

__declspec(dllexport) int ka_plug_detach(void) { return ka_plug_detach_s(0); }

/** 已连上？（按槽 / 选中槽） */
__declspec(dllexport) int ka_plug_ready_s(int slot) {
    if (slot < 0 || slot >= KA_MAX_PLUG) return 0;
    return g_plugs[slot].shm ? 1 : 0;
}
__declspec(dllexport) int ka_plug_ready(void) { return ka_plug_ready_s(0); }

/** worker 心跳值。连着两次取到同一个值 = 它死了（崩在插件里的典型下场）。未连上返回 -1。 */
__declspec(dllexport) int ka_plug_heartbeat_s(int slot) {
    if (slot < 0 || slot >= KA_MAX_PLUG || !g_plugs[slot].shm) return -1;
    return (int)g_plugs[slot].shm->beat;
}
__declspec(dllexport) int ka_plug_heartbeat(void) { return ka_plug_heartbeat_s(0); }

/** ring 取空了几块。一直在涨 = worker 供不上，或者宿主压根没在取。 */
__declspec(dllexport) int ka_plug_underruns_s(int slot) {
    if (slot < 0 || slot >= KA_MAX_PLUG || !g_plugs[slot].shm) return -1;
    return (int)g_plugs[slot].shm->underrun;
}
__declspec(dllexport) int ka_plug_underruns(void) { return ka_plug_underruns_s(0); }

/** 把一条轨绑到某个槽：那个 worker 从此只收这条轨的音符。
 *  track < 0 = 解绑（槽还留着，只是不喂东西）。改完立刻重推一遍音符表。 */
__declspec(dllexport) int ka_vst3_bind(int slot, int track) {
    if (slot < 0 || slot >= KA_MAX_PLUG) return -1;
    if (track < -1 || track >= KA_MAX_TRACKS) return -1;
    g_plug_track_of[slot] = track;
    ka_plug_push_notes();
    return track;
}

/** 一个槽上开着的那件插件的峰值（千分比）。没开 = 0。 */
__declspec(dllexport) int ka_vst3_peak_s(int slot) {
    if (slot < 0 || slot >= KA_MAX_PLUG || !g_plugs[slot].shm) return 0;
    return (int)g_plugs[slot].shm->peak;
}

/** 插件总线的音量（混进设备输出时用）。 */
__declspec(dllexport) void ka_plug_gain(float g) {
    if (g < 0.0f) g = 0.0f;
    if (g > 2.0f) g = 2.0f;
    g_plug_gain = g;
}

/** 扫一个 .vst3（UTF-16 路径），返回类数量；负数是卡在哪一步：
 *  -1 传空 / -2 加载失败 / -3 没有 GetPluginFactory / -4 工厂为空 / -5 countClasses 为负。 */
__declspec(dllexport) int ka_vst3_scan(const uint16_t* path) {
    return (int)ka_plug_call(KA_CMD_SCAN, 0, 0, 0, 0, path, KA_PLUG_MS_SLOW);
}

/** 最近一次扫描的类数量。 */
__declspec(dllexport) int ka_vst3_count(void) {
    return (int)ka_plug_call(KA_CMD_STATE, 0, 0, 0, 0, 0, KA_PLUG_MS_FAST);
}

/** 最近一次扫描的错误码。 */
__declspec(dllexport) int ka_vst3_err(void) {
    (void)ka_plug_call(KA_CMD_STATE, 0, 0, 0, 0, 0, KA_PLUG_MS_FAST);
    return g_plug ? (int)g_plug->iv[0] : KA_SHM_ERR_NO_WORKER;
}

/** 诊断：加载失败时拼出来的 bundle 路径（猜错路径时看这里，错误码看不出来）。
 *  返回的指针**指向共享内存**，调用方要读就现在读，别存着。 */
__declspec(dllexport) const char* ka_vst3_dbg(void) {
    (void)ka_plug_call(KA_CMD_DBG, 0, 0, 0, 0, 0, KA_PLUG_MS_FAST);
    return g_plug ? g_plug->text : "";
}

/** 工厂信息："<vendor>|<url>|<email>|<flags>"。 */
__declspec(dllexport) int ka_vst3_factory(char* buf, int cap) {
    int r = (int)ka_plug_call(KA_CMD_FACTORY, 0, 0, 0, 0, 0, KA_PLUG_MS_FAST);
    if (r <= 0) return r;
    return ka_plug_text(buf, cap);
}

/** 第 idx 个类："<cid hex 32>|<cardinality>|<category>|<name>"。 */
__declspec(dllexport) int ka_vst3_class(int idx, char* buf, int cap) {
    int r = (int)ka_plug_call(KA_CMD_CLASS, idx, 0, 0, 0, 0, KA_PLUG_MS_FAST);
    if (r <= 0) return r;
    return ka_plug_text(buf, cap);
}

/** 第 idx 个类的原始 16 字节 cid（createInstance 要的就是这个，不是文本）。 */
__declspec(dllexport) int ka_vst3_class_cid(int idx, char* out) {
    int i;
    int r = (int)ka_plug_call(KA_CMD_CID, idx, 0, 0, 0, 0, KA_PLUG_MS_FAST);
    if (r != 16 || !g_plug || !out) return 0;
    for (i = 0; i < 16; ++i) out[i] = g_plug->cid[i];
    return 16;
}

/** 打开一个插件（UTF-16 路径 + 扫描清单里的类下标）。返回 0 或见 ka_v3_open 的负数表。
 *  打开成功就是"这条轨由插件发声"—— g_plug_on 立刻置位，内置合成器在那条轨上闭嘴。 */
__declspec(dllexport) int ka_vst3_open(const uint16_t* path, int cls_index) {
    int rc;
    if (g_plug) g_plug->rate = g_rate;
    rc = (int)ka_plug_call(KA_CMD_OPEN, cls_index, 0, 0, 0, path, KA_PLUG_MS_SLOW);
    if (rc == 0) g_plug_on[g_plug_cur] = 1;
    return rc;
}

/** 带开关的打开：flags 见 KA_V3_OPEN_*（1 = 不建控制器）。 */
__declspec(dllexport) int ka_vst3_open_ex(const uint16_t* path, int cls_index, int flags) {
    int rc;
    if (g_plug) g_plug->rate = g_rate;
    rc = (int)ka_plug_call(KA_CMD_OPEN, cls_index, flags, 0, 0, path, KA_PLUG_MS_SLOW);
    if (rc == 0) g_plug_on[g_plug_cur] = 1;
    return rc;
}

__declspec(dllexport) void ka_vst3_close(void) {
    (void)ka_plug_call(KA_CMD_CLOSE, 0, 0, 0, 0, 0, KA_PLUG_MS_FAST);
    g_plug_on[g_plug_cur] = 0;
    if (g_plug) g_plug->ed_mon = 0;          /* 实例没了，那扇窗跟着没了 */
}

/** 排障：上次打开走到第几步 + 那一步的原始 tresult。 */
__declspec(dllexport) int ka_vst3_stage(int* seq) {
    int r = (int)ka_plug_call(KA_CMD_STAGE, 0, 0, 0, 0, 0, KA_PLUG_MS_FAST);
    if (seq && g_plug) *seq = (int)g_plug->iv[0];
    return r;
}

/** 排障：用第 which 个候选 iid 调一次 createInstance，返回原始 tresult。 */
__declspec(dllexport) int ka_vst3_probe(const uint16_t* path, int cls_index, int which) {
    return (int)ka_plug_call(KA_CMD_PROBE, cls_index, which, 0, 0, path, KA_PLUG_MS_SLOW);
}

/** 事件统计：out[0]=插件问过几次"有几条"，out[1]=实际取走几条，out[2]=最近一块的事件数。 */
__declspec(dllexport) int ka_vst3_events(int* out, int n) {
    (void)ka_plug_call(KA_CMD_EVENTS, 0, 0, 0, 0, 0, KA_PLUG_MS_FAST);
    if (!out || n < 3 || !g_plug) return 0;
    out[0] = (int)g_plug->iv[0];
    out[1] = (int)g_plug->iv[1];
    out[2] = (int)g_plug->iv[2];
    return 3;
}

/** 排障：总线清单（多行 "a|i|0|ch=2|flags=1"）。返回行数。 */
__declspec(dllexport) int ka_vst3_buses(char* buf, int cap) {
    int r = (int)ka_plug_call(KA_CMD_BUSES, 0, 0, 0, 0, 0, KA_PLUG_MS_FAST);
    if (r <= 0) return r;
    return ka_plug_text(buf, cap);
}

/** 排障：宿主给插件的输出缓冲地址（低 32 位）。 */
__declspec(dllexport) int ka_vst3_outaddr(void) {
    return (int)ka_plug_call(KA_CMD_ADDR, 0, 0, 0, 0, 0, KA_PLUG_MS_FAST);
}

/** 排障：队列里第 0 条事件的原始 48 字节 + 队列状态（out[0..13]）。 */
__declspec(dllexport) int ka_vst3_queue_dump(int* out, int n) {
    int i;
    (void)ka_plug_call(KA_CMD_QUEUE, 0, 0, 0, 0, 0, KA_PLUG_MS_FAST);
    if (!out || n < 14 || !g_plug) return 0;
    for (i = 0; i < 14; ++i) out[i] = (int)g_plug->iv[i];
    return 14;
}

/** 打开状态下的几何信息："<inBus>|<outBus>|<inCh>|<outCh>|<evIn>|<rate>"。 */
__declspec(dllexport) int ka_vst3_info(char* buf, int cap) {
    int r = (int)ka_plug_call(KA_CMD_INFO, 0, 0, 0, 0, 0, KA_PLUG_MS_FAST);
    if (r <= 0) return r;
    return ka_plug_text(buf, cap);
}

/** 控制器（IEditController）状态。ret=1 已建；out[0..7] = rc/restarts/restartFlags/
 *  hostReqCount/paramCount/hasUnitInfo/hasCpComp/hasCpCtrl（见 ka_shm.h 的 KA_CMD_CTRL）。
 *  buf 收插件向宿主 createInstance 要过的 IID 串（逗号分隔），用来判断还缺哪一层。 */
__declspec(dllexport) int ka_vst3_ctrl(int* out, int n, char* buf, int cap) {
    int i, r;
    r = (int)ka_plug_call(KA_CMD_CTRL, 0, 0, 0, 0, 0, KA_PLUG_MS_FAST);
    if (out && n > 0 && g_plug) {
        int m = n < KA_SHM_IV ? n : KA_SHM_IV;
        for (i = 0; i < m; ++i) out[i] = (int)g_plug->iv[i];
    }
    if (buf && cap > 0) ka_plug_text(buf, cap);
    return r;
}

/** 进度戳：worker 在插件里卡住/崩掉时，这里说"走到第几步"（见 ka_vst3.h 的 ka_v3_trace）。
 *  正常返回的命令会清掉它，所以只在超时/断开之后读才有意义。 */
__declspec(dllexport) int ka_vst3_trace(void) {
    return g_plug ? (int)g_plug->iv[KA_SHM_IV - 1] : -1;
}

/** 第二格进度戳：现在存"组件是不是靠 FUnknown 兜底建出来的"（1 直连 / 2 兜底）。 */
__declspec(dllexport) int ka_vst3_trace2(void) {
    return g_plug ? (int)g_plug->iv[KA_SHM_IV - 2] : -1;
}

/** worker 崩在插件里时留下的现场：out = [最后宿主回调 1..5, 访问地址低, 模块基址低, 模块基址高,
 *  故障地址低, 故障地址高, 异常码]。正常路径里这几格是上一次崩留下的旧值，别看。 */
__declspec(dllexport) int ka_vst3_fault(int* out, int n) {
    int i;
    if (!out || n < 1 || !g_plug) return 0;
    for (i = 0; i < 7 && i < n; ++i) out[i] = (int)g_plug->iv[8 + i];
    return i;
}

/** worker 主线程 id（AV 现场里的 tid 跟它比，就知道是不是插件自己起的线程崩的）。 */
__declspec(dllexport) int ka_vst3_worker_tid(void) {
    return g_plug ? (int)g_plug->worker_tid : -1;
}

/** worker 里最后一段宿主侧备注（插件向宿主讨对象时记下的 IID 串）。worker 已经崩了
 *  也读得到 —— 它在共享内存里。 */
__declspec(dllexport) int ka_vst3_lasttext(char* buf, int cap) {
    if (!g_plug) return -1;
    return ka_plug_text(buf, cap);
}

/** 控制器参数个数（没建控制器回 -1）。 */
__declspec(dllexport) int ka_vst3_pcount(void) {
    return (int)ka_plug_call(KA_CMD_PCOUNT, 0, 0, 0, 0, 0, KA_PLUG_MS_FAST);
}

/** 第 idx 个参数："id|flags|steps|unit|title|short|units"。返回 1 / 0。 */
__declspec(dllexport) int ka_vst3_pinfo(int idx, char* buf, int cap) {
    int r = (int)ka_plug_call(KA_CMD_PINFO, idx, 0, 0, 0, 0, KA_PLUG_MS_FAST);
    if (r <= 0) return r;
    return ka_plug_text(buf, cap) > 0 ? 1 : 0;
}

/** 设归一化参数（value_micro = 0..1000000）。同时排进下一块 process 的参数变更。 */
__declspec(dllexport) int ka_vst3_pset(int id, int value_micro) {
    return (int)ka_plug_call(KA_CMD_PSET, id, value_micro, 0, 0, 0, KA_PLUG_MS_FAST);
}

/** 读归一化参数（×1e6）。 */
__declspec(dllexport) int ka_vst3_pget(int id) {
    return (int)ka_plug_call(KA_CMD_PGET, id, 0, 0, 0, 0, KA_PLUG_MS_FAST);
}

/** 扫参数找"选程序"那几个：从 from 起最多 maxlines 行，text 每行
 *  "idx|id|flags|unit|title"。ret=命中数，scanned 回填扫到哪个下标（下一页从这继续）。 */
__declspec(dllexport) int ka_vst3_pscan(int from, int maxlines, char* buf, int cap, int* scanned) {
    int r = (int)ka_plug_call(KA_CMD_PSCAN, from, maxlines, 0, 0, 0, KA_PLUG_MS_FAST);
    if (buf && cap > 0) ka_plug_text(buf, cap);
    if (scanned && g_plug) *scanned = (int)g_plug->iv[0];
    return r;
}

/** 单元与程序列表（text 每行 "u|id|parent|plist|name" 或 "p|id|count|name"）。ret=单元数，
 *  out[0]=程序列表数。 */
__declspec(dllexport) int ka_vst3_units(char* buf, int cap, int* out, int n) {
    int r = (int)ka_plug_call(KA_CMD_UNITS, 0, 0, 0, 0, 0, KA_PLUG_MS_FAST);
    if (buf && cap > 0) ka_plug_text(buf, cap);
    if (out && n > 0 && g_plug) out[0] = (int)g_plug->iv[0];
    return r;
}

/** 某列表里第 index 个程序的名字。 */
__declspec(dllexport) int ka_vst3_progname(int list_id, int index, char* buf, int cap) {
    int r = (int)ka_plug_call(KA_CMD_PROGNAME, list_id, index, 0, 0, 0, KA_PLUG_MS_FAST);
    if (r < 0) return r;
    return ka_plug_text(buf, cap);
}

/** 某列表里程序总数。 */
__declspec(dllexport) int ka_vst3_proginfo(int list_id) {
    return (int)ka_plug_call(KA_CMD_PROGINFO, list_id, 0, 0, 0, 0, KA_PLUG_MS_FAST);
}

/** 发一个音符：on=1/0，ch 0..15，pitch 0..127，vel 0..127。事件在下一块开头生效。 */
__declspec(dllexport) int ka_vst3_note(int on, int ch, int pitch, int vel) {
    return (int)ka_plug_call(KA_CMD_NOTE, on ? 1 : 0, ch, pitch, vel, 0, KA_PLUG_MS_FAST);
}

/** 试听：立即 note-on，blocks 块之后 worker 自己发 note-off（暂停时也照渲）。
 *  连点会先把上一个收掉，不会叠出一串挂着的音。 */
__declspec(dllexport) int ka_vst3_audition(int note, int vel, int ch, int blocks) {
    return (int)ka_plug_call(KA_CMD_AUDITION, note, vel, ch, blocks, 0, KA_PLUG_MS_FAST);
}

/** 所有通道收声（拖播放头 / 换乐器 / 暂停时宿主调用）。 */
__declspec(dllexport) int ka_vst3_notes_off(void) {
    return (int)ka_plug_call(KA_CMD_NOTES_OFF, 0, 0, 0, 0, 0, KA_PLUG_MS_FAST);
}

/** 装一个 .vstpreset（IComponent::setState + IEditController::setComponentState/setState）。
 *  返回 0 = 成功，其余见 ka_v3_state_load 的负数表（-10 段是文件错）。
 *  out[0..3] = component rc / setComponentState rc / controller rc / 文件字节数。 */
__declspec(dllexport) int ka_vst3_state_load(const uint16_t* path, int* out, int n) {
    int i, r;
    r = (int)ka_plug_call(KA_CMD_STATE_LOAD, 0, 0, 0, 0, path, KA_PLUG_MS_SLOW);
    if (out && n > 0 && g_plug) {
        int m = n < KA_SHM_IV ? n : KA_SHM_IV;
        for (i = 0; i < m; ++i) out[i] = (int)g_plug->iv[i];
    }
    return r;
}

/** 把当前音色存成 .vstpreset（整个 bundle 的状态，不用编辑器）。返回总字节数或负错误码。 */
__declspec(dllexport) int ka_vst3_state_save(const uint16_t* path) {
    return (int)ka_plug_call(KA_CMD_STATE_SAVE, 0, 0, 0, 0, path, KA_PLUG_MS_SLOW);
}

/** 开插件自己的编辑器窗口（worker 起了条 UI 线程来管窗口与消息泵，音频照跑）。
 *  0 = 窗口已经显示；负数是哪一步失败（-21 = 插件界面造不出来/超时）。
 *  out[0..2] = 是否开着 / 客户区宽 / 高。 */
__declspec(dllexport) int ka_vst3_editor_open(int* out, int n) {
    int i, r;
    r = (int)ka_plug_call(KA_CMD_EDITOR_OPEN, 0, 0, 0, 0, 0, KA_PLUG_MS_SLOW);
    if (out && n > 0 && g_plug) {
        int m = n < KA_SHM_IV ? n : KA_SHM_IV;
        for (i = 0; i < m; ++i) out[i] = (int)g_plug->iv[i];
    }
    /* 窗口开着 = 用户要在插件自己的界面里试音（见 ka_plug_mix / wk_render）。
     * 那边的键盘只从 process() 出声，不把这条告诉他们，界面里点了就是没声音。 */
    if (g_plug) g_plug->ed_mon = (out && n > 0 && out[0]) ? 1 : 0;
    return r;
}

__declspec(dllexport) int ka_vst3_editor_close(void) {
    int r = (int)ka_plug_call(KA_CMD_EDITOR_CLOSE, 0, 0, 0, 0, 0, KA_PLUG_MS_SLOW);
    if (r == 0 && g_plug) g_plug->ed_mon = 0;
    return r;
}

/** ret = 1 开着。out[0] = 用户点 X 关过几次 —— 变过就说明"音色挑完了"，
 *  宿主这时该把状态存成 .vstpreset（out[1..2] = 客户区宽高）。 */
__declspec(dllexport) int ka_vst3_editor_state(int* out, int n) {
    int i, r;
    r = (int)ka_plug_call(KA_CMD_EDITOR_STATE, 0, 0, 0, 0, 0, KA_PLUG_MS_FAST);
    if (out && n > 0 && g_plug) {
        int m = n < KA_SHM_IV ? n : KA_SHM_IV;
        for (i = 0; i < m; ++i) out[i] = (int)g_plug->iv[i];
    }
    /* 用户点 X 关掉窗口时这里才第一次知道 —— 监视跟着停，别再白渲。
     * 别的地方（卸载/换实例）也会清，见 ka_vst3_close / ka_plug_detach_s。 */
    if (g_plug) g_plug->ed_mon = (r == 1) ? 1 : 0;
    return r;
}

/** 开/关"往 ring 里渲染"。开之前取不到块（ka_vst3_render 会一直等到超时），
 *  所以要先开这个再取 —— 关掉是为了不让它白占 CPU。 */
__declspec(dllexport) int ka_vst3_live(int on) {
    return (int)ka_plug_call(KA_CMD_LIVE, on ? 1 : 0, 0, 0, 0, 0, KA_PLUG_MS_FAST);
}

/** 取一块。dst 可为空（只推进）；非空时收到交错立体声。
 *  返回 0 / -1 没打开 / -92 worker 死了。
 *
 *  **同步**：这一块是"我现在就要"，不是从 ring 里捞一块现成的。ring 那边是提前渲染好的，
 *  提前量最多 8 块 ≈ 85ms —— 音符会晚 85ms 才进声音，量出来的力度/音高全是上一块的。
 *  给设备混音用 ring（延迟换不卡顿），给测试和离线用这里（要确定性）。 */
__declspec(dllexport) int ka_vst3_render(float* dst, int frames) {
    int r, i, n;
    if (!g_plug) return KA_SHM_ERR_NO_WORKER;
    if (!g_plug->opened) return -1;
    r = (int)ka_plug_call(KA_CMD_RENDER, frames, 0, 0, 0, 0, KA_PLUG_MS_FAST);
    if (r != 0) return r;
    if (!dst) return 0;
    n = frames < KA_SHM_BLOCK ? frames : KA_SHM_BLOCK;
    for (i = 0; i < n * 2; ++i) dst[i] = g_plug->rout[i];
    return 0;
}

/** 从 ring 里捞一块（**不是**同步渲染）。给想自己接管音频的调用方用；
 *  正常情况下设备那边已经混好了，不需要调它。 */
__declspec(dllexport) int ka_plug_pull_block(float* dst, int frames) {
    return ka_plug_pull(dst, frames);
}

/** 所有实例里最大的那个峰值（千分比），和采样器那边同一个口径。
 *  单个实例的峰看 `ka_vst3_peak_s` —— 界面那条电平表要的是"现在有没有声"。 */
__declspec(dllexport) int ka_vst3_peak(void) {
    int i, v = 0;
    for (i = 0; i < KA_MAX_PLUG; ++i) {
        if (!g_plugs[i].shm) continue;
        if ((int)g_plugs[i].shm->peak > v) v = (int)g_plugs[i].shm->peak;
    }
    return v;
}

/** 已渲染的帧数。 */
__declspec(dllexport) int ka_vst3_frames(void) {
    int64_t fr;
    if (!g_plug) return 0;
    fr = ((int64_t)g_plug->frames_hi << 32) | (uint32_t)g_plug->frames_lo;
    return (int)fr;
}

int __stdcall DllMain(void* module, uint32_t reason, void* reserved) {
    (void)module; (void)reserved;
    if (reason == 0) { if (g_open) ka_close(); }
    return 1;
}
