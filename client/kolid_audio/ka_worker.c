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

static void wk_render(ka_shm* s) {
    int32_t rc;
    int64_t fr;
    if (!s->live || !s->opened) return;
    if (ka_shm_pending(s) <= 0) return;                  /* ring 满了：宿主没在取，别白干 */
    rc = ka_v3_render(ka_shm_block_at(s, s->w), s->block);
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

/* 返回 0 = 收到 QUIT，该退了。 */
static int wk_cmd(ka_shm* s) {
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
        if (s->rate > 0) g_rate = s->rate;
        g_veh_seen = 0;
        s->ret = ka_v3_open(s->has_path ? s->path : 0, s->a0, s->a1);
        s->opened = (s->ret == 0) ? 1 : 0;
        /* 帧计数要跟着归零：它只在渲染时才被推进，不开这一下宿主会一直读到上一轮的旧值
         * （"重开之后 frames 没归零"就是这么来的）。 */
        s->peak = 0;
        s->frames_hi = 0; s->frames_lo = 0;
        break;
    case KA_CMD_CLOSE:
        ka_v3_close();
        s->opened = 0;
        s->live = 0;
        s->w = 0; s->r = 0;
        s->peak = 0;
        s->frames_hi = 0; s->frames_lo = 0;
        break;
    case KA_CMD_NOTE:
        s->ret = ka_v3_note(s->a0 ? 1 : 0, s->a1, s->a2, s->a3);
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
        s->ret = ka_v3_render(s->rout, n);
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
    s = (ka_shm*)MapViewOfFile(hm, KA_FILE_MAP_ALL_ACCESS, 0, 0, bytes);
    if (!s) ExitProcess(3);

    memset(s, 0, (uint64_t)bytes);
    s->magic = KA_SHM_MAGIC;
    s->abi = KA_SHM_ABI;
    s->rate = 48000;
    s->block = KA_SHM_BLOCK;
    s->ring_blocks = KA_SHM_RING;
    s->peak = 0;
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
        wk_render(s);

        /* 宿主没了就自己退：不留孤儿进程占着插件。5 秒没动静算走人了。 */
        if (s->host_beat == hb) {
            stall = stall + 1;
            if (stall > 5000) break;
        } else { hb = s->host_beat; stall = 0; }
    }

    if (s->opened) ka_v3_close();
    UnmapViewOfFile(s);
    CloseHandle(hm);
    ExitProcess(0);
    return 0;
}
