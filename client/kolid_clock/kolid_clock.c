/* ── KolidClock ──────────────────────────────────────────────────────────────────────────────
 *
 * 一款"公共时间基准"：整个进程（以及守在它前面的那个页面）只认它一个说法。
 *
 * 为什么要有它：MIDI 播放里最容易长歪的不是编辑，是**时间** —— 传输条按 rAF 算一遍、钢琴卷帘
 * 按 performance.now() 算一遍、外部音源按自己的定时器算一遍，三份钟各自漂，听到的和看到的就
 * 永远差一点点，而且差多少每次都不一样。所以时间只在一个地方产生，别处只准读数。
 *
 * 权威是 QueryPerformanceCounter（Windows 上唯一可靠的单调查时钟）。传输状态（播/停/位置/
 * 倍速）挂在这条轴上，位置由 **(锚点帧, 锚点 QPC)** 一对数算出，而不是每次累加 dt —— 累加会
 * 把每一处取整误差攒进去，锚点不会。
 *
 * 这个 DLL 不产声音、不开设备。它只回答"现在是第几帧"。将来真要接设备时钟，只需把
 * kc_anchor() 喂成设备自己的播放位置，其余代码一行不改。
 *
 * 为什么没有 `#include <windows.h>`：这台机器的 BuildTools 只装了编译器，没装 Windows SDK
 * （连 windows.h 和 kernel32.lib 都没有）。所以这里自己声明那两个 API，并用 build.ps1 里的
 * `lib /def:kernel32.def` 造一份导入库。锁也就不用 SRWLOCK，改成一条 intrinsic 自旋 —— 临界区
 * 全是几十纳秒的算术，自旋比进内核更合适，还省掉一个 SDK 依赖。
 *
 * 所有导出都是 cdecl + 纯 C ABI（int64 走寄存器，ctypes 的 c_longlong 对得上）。
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

#include <stdint.h>

/* intrin.h 在这台机器上不可用（它拉 xmmintrin.h → malloc.h，都在缺掉的 UCRT 里），
 * 所以三个 intrinsic 自己声明、用 #pragma intrinsic 让编译器就地展开 —— 不生成外部调用。 */
long long _InterlockedCompareExchange64(long long volatile* dest, long long exchange, long long comparand);
long long _InterlockedExchange64(long long volatile* dest, long long value);
void __nop(void);
#pragma intrinsic(_InterlockedCompareExchange64)
#pragma intrinsic(_InterlockedExchange64)
#pragma intrinsic(__nop)

#define KC_VERSION 1
/* 链接 CRT 时这个符号由 CRT 定义；这里没有 CRT（见 build.ps1 的 /NODEFAULTLIB），而编译器只要
 * 看到浮点运算就会引用它。自己定义一个空的就够 —— 它只是个"我用过浮点"的记号。 */
int _fltused = 0;
/* 上限只是防呆：24 小时 @192kHz 也才 1.6e10 帧。 */
#define KC_MAX_FRAMES (INT64_C(1) << 62)

/* ── 那两个系统调用（等价于 <windows.h> 里对应的声明） ── */
__declspec(dllimport) int __stdcall QueryPerformanceCounter(int64_t* counter);
__declspec(dllimport) int __stdcall QueryPerformanceFrequency(int64_t* frequency);

typedef void* KC_HMODULE;
typedef unsigned long KC_DWORD;
typedef int KC_BOOL;

/* ── 锁：一条自旋，纯 intrinsic ──
 * 临界区全是几十纳秒的算术，抢不到的概率极低；退避用 __nop 而不是 _mm_pause —— 后者会把
 * xmmintrin.h 拉进来，那份头要 malloc.h（UCRT，同样在这台机器上缺）。 */
static volatile int64_t kc_lock_word = 0;

static __forceinline void kc_lock(void) {
    while (_InterlockedCompareExchange64(&kc_lock_word, 1, 0) != 0) { __nop(); __nop(); __nop(); }
}
static __forceinline void kc_unlock(void) {
    _InterlockedExchange64(&kc_lock_word, 0);
}

/* ── 状态 ── */
static int64_t kc_freq = 0;          /* QPC 每秒计数 */
static int64_t kc_sr = 48000;        /* 采样率 = 每秒多少"帧" */
static double  kc_speed = 1.0;       /* 倍速，1.0 = 原速 */
static int64_t kc_anchor_qpc = 0;    /* 锚点：在那个 QPC 刻度上 ... */
static int64_t kc_anchor_frames = 0; /* ... 传输头在这个帧 */
static int     kc_playing_flag = 0;
static int64_t kc_epoch_qpc = 0;     /* init 那一刻，前端对齐用的公共起点 */
/* 循环区间：区间是**时钟自己的**能力 —— 页面不再每帧检查出点再发 seek（那会在后台页
 * 被节流时错过、也会有整帧的延迟）。回绕时只挪帧，不挪 QPC 锚点：时间轴照走。 */
static int kc_loop_on = 0;
static int64_t kc_loop_a = 0;
static int64_t kc_loop_b = 0;
static volatile int64_t kc_wrap_count = 0;

static __forceinline int64_t kc_qpc_raw(void) {
    int64_t v = 0;
    QueryPerformanceCounter(&v);
    return v;
}

/* 调用方必须持锁。返回 1 = 频率有效。 */
static int kc_init_locked(void) {
    if (kc_freq != 0) return 1;
    int64_t f = 0;
    if (!QueryPerformanceFrequency(&f) || f <= 0) return 0;
    kc_freq = f;
    kc_anchor_qpc = kc_qpc_raw();
    kc_epoch_qpc = kc_anchor_qpc;
    kc_anchor_frames = 0;
    return 1;
}

/* 调用方必须持锁。把"从锚点到此刻"折进锚点，返回帧数。
 * 只吃**整帧**：零头留在 qpc 差里下次再算，读多少次都不会攒出误差。 */
static int64_t kc_render_locked(void) {
    if (kc_playing_flag && kc_freq > 0 && kc_speed != 0.0) {
        int64_t now = kc_qpc_raw();
        int64_t delta = now - kc_anchor_qpc;
        if (delta > 0) {
            double frames = (double)delta * (double)kc_sr * kc_speed / (double)kc_freq;
            int64_t whole = (int64_t)frames;   /* 向零取整：倒放时也成立 */
            if (whole != 0) {
                kc_anchor_frames += whole;
                kc_anchor_qpc += (int64_t)((double)whole * (double)kc_freq / ((double)kc_sr * kc_speed));
            }
        }
    }
    /* 循环：越过出点就在同一次读里折回入点。多圈也一次折完（长暂停后恢复不会攒一堆）。 */
    if (kc_loop_on && kc_loop_b > kc_loop_a) {
        while (kc_anchor_frames >= kc_loop_b) {
            kc_anchor_frames -= (kc_loop_b - kc_loop_a);
            kc_wrap_count = kc_wrap_count + 1;
        }
    }
    if (kc_anchor_frames < 0) kc_anchor_frames = 0;
    if (kc_anchor_frames > KC_MAX_FRAMES) kc_anchor_frames = KC_MAX_FRAMES;
    return kc_anchor_frames;
}

/* ── 导出 ── */

__declspec(dllexport) int kc_version(void) { return KC_VERSION; }

__declspec(dllexport) int kc_init(void) {
    int ok;
    kc_lock();
    ok = kc_init_locked();
    kc_unlock();
    return ok;
}

__declspec(dllexport) int64_t kc_qpc_freq(void) {
    int64_t f;
    kc_lock();
    kc_init_locked();
    f = kc_freq;
    kc_unlock();
    return f;
}

__declspec(dllexport) int64_t kc_qpc(void) { return kc_qpc_raw(); }

/* init 那一刻的 QPC —— 对齐时用它当共同起点，免得 64 位计数在 JS 里失真。 */
__declspec(dllexport) int64_t kc_epoch(void) {
    int64_t e;
    kc_lock();
    kc_init_locked();
    e = kc_epoch_qpc;
    kc_unlock();
    return e;
}

/* 从 epoch 起算的秒数（单调）。 */
__declspec(dllexport) double kc_now_seconds(void) {
    int64_t e, f;
    kc_lock();
    kc_init_locked();
    e = kc_epoch_qpc;
    f = kc_freq ? kc_freq : 1;
    kc_unlock();
    return (double)(kc_qpc_raw() - e) / (double)f;
}

__declspec(dllexport) int kc_sample_rate(void) {
    int sr;
    kc_lock();
    sr = (int)kc_sr;
    kc_unlock();
    return sr;
}

__declspec(dllexport) int kc_set_sample_rate(int sr) {
    if (sr < 1000 || sr > 768000) return 0;
    kc_lock();
    kc_render_locked();                 /* 先按旧含义把位置结算掉，再换单位 */
    kc_sr = (int64_t)sr;
    kc_anchor_qpc = kc_qpc_raw();
    kc_unlock();
    return 1;
}

__declspec(dllexport) void kc_play(void) {
    kc_lock();
    if (!kc_playing_flag) {
        kc_render_locked();
        kc_anchor_qpc = kc_qpc_raw();
        kc_playing_flag = 1;
    }
    kc_unlock();
}

__declspec(dllexport) void kc_pause(void) {
    kc_lock();
    if (kc_playing_flag) {
        kc_render_locked();
        kc_playing_flag = 0;
    }
    kc_unlock();
}

__declspec(dllexport) void kc_seek_frames(int64_t frames) {
    if (frames < 0) frames = 0;
    if (frames > KC_MAX_FRAMES) frames = KC_MAX_FRAMES;
    kc_lock();
    kc_anchor_frames = frames;
    kc_anchor_qpc = kc_qpc_raw();
    kc_unlock();
}

/* 倍速：1.0 原速，-1.0 倒放（位置夹到 0 就停在那儿，不报错）。 */
__declspec(dllexport) int kc_set_speed(double speed) {
    if (!(speed > -16.0 && speed < 16.0)) return 0;
    kc_lock();
    kc_render_locked();
    kc_speed = speed;
    kc_anchor_qpc = kc_qpc_raw();
    kc_unlock();
    return 1;
}

__declspec(dllexport) double kc_speed_get(void) {
    double s;
    kc_lock();
    s = kc_speed;
    kc_unlock();
    return s;
}

__declspec(dllexport) int kc_playing(void) {
    int p;
    kc_lock();
    p = kc_playing_flag;
    kc_unlock();
    return p;
}

/* 读位置。幂等：读多少次都不改变答案（只会把锚点推进到此刻）。 */
__declspec(dllexport) int64_t kc_frames(void) {
    int64_t f;
    kc_lock();
    f = kc_render_locked();
    kc_unlock();
    return f;
}

/* 外部时钟接管：宣告"此刻 = frames"（将来接音频设备位置时用）。 */
__declspec(dllexport) void kc_anchor(int64_t frames) {
    if (frames < 0) frames = 0;
    kc_lock();
    kc_anchor_frames = frames;
    kc_anchor_qpc = kc_qpc_raw();
    kc_unlock();
}

/* 循环区间（帧）。on=1 且 b>a 才生效；设的时候如果已经越过出点，当场折回。 */
__declspec(dllexport) int kc_set_loop(int on, int64_t a, int64_t b) {
    if (a < 0) a = 0;
    if (b > KC_MAX_FRAMES) b = KC_MAX_FRAMES;
    kc_lock();
    kc_render_locked();
    if (on && b > a) {
        kc_loop_on = 1;
        kc_loop_a = a;
        kc_loop_b = b;
        if (kc_anchor_frames >= kc_loop_b) {
            kc_anchor_frames = kc_loop_a + (kc_anchor_frames - kc_loop_a) % (kc_loop_b - kc_loop_a);
            kc_wrap_count = kc_wrap_count + 1;
        }
    } else {
        kc_loop_on = 0;
        kc_loop_a = 0;
        kc_loop_b = 0;
    }
    on = kc_loop_on;
    kc_unlock();
    return on;
}

__declspec(dllexport) int kc_loop_get(int64_t* a, int64_t* b) {
    int on;
    kc_lock();
    on = kc_loop_on;
    if (a) *a = kc_loop_a;
    if (b) *b = kc_loop_b;
    kc_unlock();
    return on;
}

/* 回绕次数（单调）。音频线程拿它当"硬对表"的信号 —— 短循环的位移可能小于 125ms，
 * 靠位置跳变是判不出来的。 */
__declspec(dllexport) int64_t kc_loop_wraps(void) { return kc_wrap_count; }

/* 一次取全，给 HTTP 一个来回就够：帧 / 采样率 / 在播 / 现在 / 频率。
 * 时间戳最后取 —— 它必须"不早于"位置，否则前端对齐时会把时间往回拨。 */
__declspec(dllexport) int kc_snapshot(int64_t* frames, int* sample_rate, int* playing,
                                      double* now_seconds, int64_t* freq) {
    int64_t f, sr, fq, e;
    int p;
    kc_lock();
    kc_init_locked();
    f = kc_render_locked();
    sr = kc_sr;
    p = kc_playing_flag;
    fq = kc_freq ? kc_freq : 1;
    e = kc_epoch_qpc;
    kc_unlock();
    if (frames) *frames = f;
    if (sample_rate) *sample_rate = (int)sr;
    if (playing) *playing = p;
    if (freq) *freq = fq;
    if (now_seconds) *now_seconds = (double)(kc_qpc_raw() - e) / (double)fq;
    return 1;
}

KC_BOOL __stdcall DllMain(KC_HMODULE module, KC_DWORD reason, void* reserved) {
    (void)module; (void)reserved;
    if (reason == 1 /* DLL_PROCESS_ATTACH */) kc_init();
    return 1;
}
