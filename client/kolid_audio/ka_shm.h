/* ── KolidAudio · 插件隔离用的共享内存（worker ↔ 宿主） ──────────────────────────────────────
 *
 * 为什么要有这一层：真插件里有一个一开就把整个进程带崩的（AGT 附近那个）。只要它在
 * ComfyUI 进程里 LoadLibrary，崩的就是整台 ComfyUI —— 所以插件**只准**在一个独立进程
 * （KaPluginWorker.exe）里加载，宿主进程里一根插件代码都不跑。
 *
 * 三条通道共用一块 file mapping：
 *   1. **命令槽**（宿主 → worker）：宿主填 cmd/参数，敲 ev_cmd，等 ev_done。
 *      一次一条，不排队 —— 命令本来就都是"界面点一下"的量级，排队只会把"卡在哪一条"藏起来。
 *   2. **文本/整数回执**：worker 把结果写进 text[] / iv[]，宿主自己去取。
 *   3. **音频 ring**（worker → 宿主）：单生产单消费，块数固定，索引单调递增。
 *      worker 有空就往前渲染，宿主按自己的节奏取。**两边都不等对方** —— 音频路径上
 *      谁等谁，谁就是下一处爆音。
 *
 * 单向所有权（别搞反）：
 *   · cmd 与 a0..a3 与 path 只有宿主写、worker 读；
 *   · ret/text/iv 只有 worker 写、宿主读；
 *   · w 只有 worker 写、r 只有宿主写，两边各读对方那一个 —— SPSC 的经典形态，
 *     不需要锁，只需要这两条是 volatile 的（x64 上对齐的 32 位读写本身是原子的）。
 *
 * 心跳：worker 每圈给 beat 加一。宿主**在任何一次等待之前之后都要看它** ——
 * 命令超时与"worker 已经死了"是同一件事的两种说法，不能让宿主傻等一个不存在的人。
 * ──────────────────────────────────────────────────────────────────────────────────────────── */
#ifndef KA_SHM_H
#define KA_SHM_H

#include <stdint.h>

#define KA_SHM_MAGIC  0x4B415348u          /* 'KASH' —— 宿主 attach 时先认它，认不出就是旧版/错名 */
#define KA_SHM_ABI    4                    /* 4：事件槽 —— 调度归宿主，worker 只按块渲染（3 是 ed_mon） */
#define KA_SHM_BLOCK  512                  /* 每块帧数，与设备的 KA_FRAMES 对齐 */
#define KA_SHM_RING   8                    /* ring 里最多压 8 块 ≈ 85ms 的余量 */
#define KA_SHM_PATH   320
#define KA_SHM_TEXT   2048
#define KA_SHM_IV     16
#define KA_SHM_NOTES  8192                 /* 与宿主那边的 KA_MAX_NOTES 一致 */
#define KA_SHM_EV_SLOTS 32                 /* 事件槽数：按 worker 的块号取模，必须 > 提前量 + 2 */
#define KA_SHM_EV_MAX   64                 /* 一块最多这么多事件（和弦 + 收声 + 试听） */

/* 命令。编号就是协议版本号的一部分，改了记得一起改 ABI。 */
#define KA_CMD_NONE    0
#define KA_CMD_PING    1
#define KA_CMD_SCAN    2                   /* a0 无；path = .vst3 路径      → ret = 类数或负错误码 */
#define KA_CMD_CLASS   3                   /* a0 = idx                      → text = 类信息 */
#define KA_CMD_CID     4                   /* a0 = idx                      → text = CID 十六进制 */
#define KA_CMD_FACTORY 5                   /*                               → text = 厂商信息 */
#define KA_CMD_OPEN    6                   /* path + a0 = cls_index         → ret = 0 或负错误码 */
#define KA_CMD_CLOSE   7
#define KA_CMD_NOTE    8                   /* a0 = on, a1 = ch, a2 = pitch, a3 = vel */
#define KA_CMD_BUSES   9                   /*                               → text */
#define KA_CMD_INFO    10                  /*                               → text */
#define KA_CMD_STAGE   11                  /*                               → iv[] */
#define KA_CMD_EVENTS  12                  /* a0 = 期望有几条               → iv[] */
#define KA_CMD_QUEUE   13                  /*                               → iv[] */
#define KA_CMD_LIVE    14                  /* a0 = 0/1：要不要往 ring 里渲染 */
#define KA_CMD_QUIT    15
#define KA_CMD_STATE   16                  /*                               → ret = 类数, iv[0]=err, iv[1]=opened */
#define KA_CMD_DBG     17                  /*                               → text = 诊断串 */
#define KA_CMD_PROBE   18                  /* a0 = cls, a1 = which, path     → ret = 原始 tresult */
#define KA_CMD_ADDR    19                  /*                               → ret = 宿主输出缓冲低 32 位 */
#define KA_CMD_RENDER  20                  /* a0 = 帧数                     → rout[] 同步的一块 */
#define KA_CMD_CTRL    21                  /* 控制器状态                    → ret=ctrl_ok, iv=rc/restarts/flags/hostreq, text=hostreq */
#define KA_CMD_PCOUNT  22                  /*                               → ret = 参数个数 */
#define KA_CMD_PINFO   23                  /* a0 = 参数下标                 → text = id|flags|steps|unit|title|short|units */
#define KA_CMD_PSET    24                  /* a0 = id, a1 = 归一值×1e6       → ret = 控制器 tresult */
#define KA_CMD_PGET    25                  /* a0 = id                       → ret = 归一值×1e6 */
#define KA_CMD_PSCAN   26                  /* a0 = 起始下标, a1 = 最多几行  → text = 命中行, ret=命中数, iv[0]=扫到哪 */
#define KA_CMD_UNITS   27                  /*                               → text = u|… 与 p|… 两组行 */
#define KA_CMD_PROGNAME 28                 /* a0 = 列表 id, a1 = 程序下标   → text = 程序名 */
#define KA_CMD_PROGINFO 29                 /* a0 = 列表 id                  → ret = 程序总数 */
#define KA_CMD_STATE_LOAD 30               /* path = .vstpreset             → ret = 0/负, iv = comp/ctrl/字节 */
#define KA_CMD_STATE_SAVE 31               /* path = 输出 .vstpreset        → ret = 字节数或负 */
#define KA_CMD_NOTES_OFF 32                /* 所有通道收声（拖播放头/换乐器/暂停） */
#define KA_CMD_AUDITION 33                 /* a0 = pitch, a1 = vel, a2 = ch, a3 = 块数
                                            * 立即发 note-on，a3 块之后自己收 —— 暂停时点 ♪ 用 */
#define KA_CMD_EDITOR_OPEN  34             /* 开插件自己的编辑器窗口（worker 的 UI 线程）
                                            * → ret = 0/负, iv[0] = 是否开着, iv[1..2] = 客户区宽高 */
#define KA_CMD_EDITOR_CLOSE 35             /* 关编辑器（removed + release view）→ ret = 0/负 */
#define KA_CMD_EDITOR_STATE 36             /* → ret = 1 开着, iv[0] = 用户点 X 关过几次, iv[1..2] = 宽高 */

/* 错误码（与插件自己的错误码错开，负数段归"通道"这一层） */
#define KA_SHM_ERR_NO_WORKER  (-91)        /* 还没 attach */
#define KA_SHM_ERR_DEAD       (-92)        /* 心跳不动了：worker 大概已经崩了 */
#define KA_SHM_ERR_TIMEOUT    (-93)        /* 等回执超时 */
#define KA_SHM_ERR_SHAPE      (-94)        /* magic / abi 对不上 */

/* worker 的退出码。**一个名字只能有一个 worker**：两支进程连同一块共享内存就是两件乐器
 * 同时出同一个声（重复音），而且后起来的那支会 memset 掉先来者的状态。 */
#define KA_WORKER_EXIT_TAG    5            /* 这个名字已经有活着的 worker 了，拒绝当第二份 */

/* 一条要交给插件（worker 里那个乐器）的音符。**与宿主 ka_note 同宽（32 字节）**，
 * 区别只在第 4 格：那边是 pad，这边是 MIDI 通道（多声部乐器靠它分槽）。
 * 升序按 start 排好（宿主排），worker 用二分+游标推进。 */
typedef struct {
    int32_t track;
    int32_t note;
    int32_t vel;
    int32_t ch;
    int64_t start;
    int64_t len;
} ka_shm_note;

/* 一块里的一个事件。调度在**宿主**里做（它同时知道走带位置与音符表），worker 只按
 * 槽渲染 —— 以前两边各排一遍，暂停收声的语义就此分叉（一叠音就是这么来的）。 */
typedef struct {
    int32_t on;                        /* 1 = note-on，0 = note-off */
    int32_t track;
    int32_t note;
    int32_t vel;
    int32_t off;                       /* 块内偏移帧 */
} ka_shm_event;

/* 一块的事件槽。按 worker 的块号（`ka_shm.w`）取模索引；gen 对不上 = seek / 换表之前
 * 的旧槽，worker 一律当"没有事件"处理。 */
typedef struct {
    int32_t w;                         /* 这张槽是 worker 的第几块 */
    int32_t gen;                       /* 调度代数（撞上 ka_shm.sched_gen 才算数） */
    int32_t count;
    int32_t drop;                      /* 放不下的事件数（诊断） */
    ka_shm_event ev[KA_SHM_EV_MAX];
} ka_shm_evblock;

typedef struct {
    uint32_t magic;
    uint32_t abi;
    int32_t  rate;
    int32_t  block;
    int32_t  ring_blocks;
    int32_t  opened;                       /* worker 那边插件开着吗（只有 worker 写） */
    int32_t  worker_tid;                   /* worker 主线程 id（诊断：AV 的线程和它比） */

    volatile int32_t beat;                 /* worker 心跳（只有 worker 写） */
    volatile int32_t host_beat;            /* 宿主心跳（只有宿主写）—— worker 据此认出"宿主没了"并自退 */
    volatile int32_t live;                 /* 要不要往 ring 里渲染（宿主写，worker 读） */

    /* ── 命令槽 ───────────────────────────────────────────────────────────── */
    volatile int32_t cmd;
    volatile int32_t ret;
    int32_t a0, a1, a2, a3;
    int32_t has_path;                      /* 0 = 这条命令没带路径（path 是 NULL，不是空串）
                                            * —— 宿主那边的 -1 与 -2 就靠它分开，别省 */
    int32_t iv[KA_SHM_IV];
    char     cid[16];                      /* 原始 16 字节 cid（createInstance 要的就是它） */
    uint16_t path[KA_SHM_PATH];
    char     text[KA_SHM_TEXT];

    /* 同步渲染的回程缓冲。**不是** ring 的一部分：ring 是"提前渲染好等你取"，
     * 这里是"我现在就要这一块" —— 测试与离线要用后者，因为提前 8 块 ≈ 85ms，
     * 音符会晚 85ms 才响，量出来的力度/音高全是上一块的。 */
    float    rout[KA_SHM_BLOCK * 2];

    /* ── 乐器：音符表 + 走带锚点（宿主写、worker 读） ────────────────────────
     * worker 提前渲一块，所以它必须知道"这一块将来落在时钟的哪一帧"：
     * 锚点说的是"ring 里第 tr_read 块 = 时钟第 tr_pos 帧"，渲染第 w 块时按
     * tr_pos + (w - tr_read) * block 外推（误差是块内的几帧漂移，听不出来）。
     * tr_epoch 变号 = 硬对表（开播 / 拖播放头 / 换乐器）：worker 要重排游标、
     * 把正在响的音收掉。notes_gen 变号 = 音符表换了，同理重排。
     * aud_blocks：暂停时点 ♪ 也要出声 —— 宿主把它设成几十块，worker 就照着渲，
     * 到 0 就停（与走带无关，音符从即时事件队列来）。 */
    volatile int32_t notes_gen;
    int32_t note_count;
    ka_shm_note notes[KA_SHM_NOTES];
    volatile int32_t tr_playing;
    volatile int32_t tr_epoch;
    volatile int32_t tr_read;
    volatile int32_t tr_pos_lo;
    volatile int32_t tr_pos_hi;
    volatile int32_t aud_blocks;

    /* ── 音频 ring ────────────────────────────────────────────────────────── */
    volatile int32_t w;                    /* worker 已写块数（单调） */
    volatile int32_t r;                    /* 宿主已读块数（单调） */
    volatile int32_t peak;                 /* 上一块峰值（千分比），跟着 ring 一起更新 */
    volatile int32_t frames_hi;            /* 已渲染帧数（高 32 位） */
    volatile int32_t frames_lo;            /* 已渲染帧数（低 32 位） */
    volatile int32_t underrun;             /* 宿主取空了几次（只有宿主写，给自己看） */
    volatile int32_t ed_mon;               /* 插件自己的界面开着（宿主写、worker 读）。
                                            * 界面里的键盘/试听按钮只会从 process() 出声，而暂停时
                                            * 本来一块都不渲 —— 于是"编辑界面里完全没声音"。
                                            * 开着窗口 = 用户正在里面试音，照渲；量按 block 压小，
                                            * 别提前灌满整条 ring（那手感就晚了 85ms）。 */

    /* ── 事件槽（宿主写、worker 读）：调度只有一个作者 ────────────────────────────
     * 宿主每块把 worker 提前量覆盖到的未来块都填好；worker 渲染第 W 块时读 evs[W % SLOTS]，
     * 只读不改。硬对表（开播 / seek / 换表 / 暂停收声）翻 sched_gen，旧槽当场作废。 */
    volatile int32_t sched_gen;
    volatile int32_t flush_seq;            /* 宿主写：暂停 / seek 时 +1；worker 见到就全音收声。
                                            * 收声不是"排到未来某一块"的事件 —— worker 可能已经
                                            * 跨过那一块了，所以它必须是一个立即生效的信号。 */
    int32_t sched_w;                       /* 宿主已填到哪个块（诊断） */
    ka_shm_evblock evs[KA_SHM_EV_SLOTS];
    /* 紧跟着 ring_blocks × block × 2 个 float（交错立体声） */
} ka_shm;

/* 整块共享内存要多大。ring 数据跟在结构体后面，按 64 字节对齐免得跨缓存行。 */
static uint64_t ka_shm_bytes(int32_t block, int32_t ring_blocks) {
    uint64_t n = (uint64_t)sizeof(ka_shm)
               + (uint64_t)block * 2u * 4u * (uint64_t)ring_blocks;
    return (n + 63u) & ~(uint64_t)63u;
}

static float* ka_shm_ring(ka_shm* s) {
    return (float*)((char*)s + sizeof(ka_shm));
}

/* 第 i 块（i 是单调计数，取模才是槽位）。 */
static float* ka_shm_block_at(ka_shm* s, int32_t i) {
    int32_t slot = i % s->ring_blocks;
    if (slot < 0) slot += s->ring_blocks;
    return ka_shm_ring(s) + (uint64_t)slot * (uint64_t)s->block * 2u;
}

static int32_t ka_shm_pending(const ka_shm* s) {   /* worker 视角：还能写几块 */
    return s->ring_blocks - (s->w - s->r);
}
static int32_t ka_shm_ready(const ka_shm* s) {     /* 宿主视角：还有几块没读 */
    return s->w - s->r;
}

/* ── 名字（宿主与 worker 各调一次，所以放这儿，别在两边各拼一份） ─────────────────────────
 * tag 由宿主那边给（现在就是 ComfyUI 的 pid），保证多个实例互不打架。
 * 三个名字：mapping 本体 + 两条命令用的事件（:c 宿主敲、:d worker 答）。 */

static void ka_shm_wstr(uint16_t* d, const char* s) {
    while (*s) *d++ = (uint16_t)(unsigned char)*s++;
    *d = 0;
}
static void ka_shm_wcat(uint16_t* d, const uint16_t* s) {
    while (*d) ++d;
    while (*s) *d++ = *s++;
    *d = 0;
}
static void ka_shm_names(const uint16_t* tag, uint16_t* map, uint16_t* evc, uint16_t* evd) {
    int i;
    ka_shm_wstr(map, "Local\\KaPlug_");
    ka_shm_wcat(map, tag);
    for (i = 0; map[i]; ++i) { evc[i] = map[i]; evd[i] = map[i]; }
    evc[i] = (uint16_t)':'; evc[i + 1] = (uint16_t)'c'; evc[i + 2] = 0;
    evd[i] = (uint16_t)':'; evd[i + 1] = (uint16_t)'d'; evd[i + 2] = 0;
}

/* ── 手写 Win32 声明（无 windows.h；导入库由 kernel32.def 造） ─────────────────────────────
 * 共享内存这一段两边都要用，所以放这里；谁 include 谁就拿到，别再各自抄一份。
 * 名字不带 KA_ 前缀：这些就是系统函数的真名，改名反而看不出是什么。 */

#define KA_FILE_MAP_ALL_ACCESS 0x000F001Fu
#define KA_SECTION_ALL_ACCESS  0x000F001Fu   /* 与 FILE_MAP_ALL_ACCESS 同值，够用 */
#define KA_EVENT_ALL_ACCESS    0x001F0003u
#define KA_WAIT_OBJECT_0       0u
#define KA_WAIT_TIMEOUT        258u
#define KA_INFINITE            0xFFFFFFFFu

__declspec(dllimport) void* __stdcall CreateFileMappingW(void* hFile, void* attrs,
                                                         uint32_t protect, uint32_t maxHigh,
                                                         uint32_t maxLow, const uint16_t* name);
__declspec(dllimport) void* __stdcall OpenFileMappingW(uint32_t access, int32_t inherit,
                                                       const uint16_t* name);
__declspec(dllimport) void* __stdcall MapViewOfFile(void* h, uint32_t access, uint32_t offHigh,
                                                    uint32_t offLow, uint64_t numBytes);
__declspec(dllimport) int32_t __stdcall UnmapViewOfFile(void* addr);
__declspec(dllimport) void* __stdcall CreateEventW(void* sa, int32_t manualReset,
                                                   int32_t initial, const uint16_t* name);
__declspec(dllimport) void* __stdcall OpenEventW(uint32_t access, int32_t inherit,
                                                 const uint16_t* name);
__declspec(dllimport) int32_t __stdcall SetEvent(void* h);
__declspec(dllimport) int32_t __stdcall ResetEvent(void* h);
__declspec(dllimport) void __stdcall ExitProcess(uint32_t code);
__declspec(dllimport) uint16_t* __stdcall GetCommandLineW(void);
/* CreateFileMappingW 认不出"这个名字已经有了"：它照样返回一个有效句柄，只把错误码放这儿。
 * worker 的单实例闸就靠它（见 ka_worker.c 的 kaMain）。 */
__declspec(dllimport) uint32_t __stdcall GetLastError(void);
#define KA_ERROR_ALREADY_EXISTS 183u

#endif /* KA_SHM_H */
