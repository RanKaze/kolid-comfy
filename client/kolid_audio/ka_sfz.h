/* ── SFZ 采样库 ──────────────────────────────────────────────────────────────────────────────
 *
 * 为什么是 SFZ：它是**纯文本 + wav**。没有二进制容器、没有许可证服务、没有 COM。
 * 一颗乐器 = 一个 .sfz 文件 + 一堆 .wav，读得懂就能响。这是在没有 SDK、不引第三方二进制
 * 的前提下唯一能把「乐器」这个词兑现的格式。
 *
 * 这里不做的事（刻意的，第一版）：
 *   · 不做滤波器 / 效果链 —— 采样本身已经录好了音色，加了反而更远；
 *   · 不做 disk streaming —— 整个 wav 读进内存（上限 SFZ_MAX_BYTES），稀疏的巨型库会拒绝装载
 *     并如实报错，而不是悄悄播一半；
 *   · 不做 #include / <curve> / <effect> —— 遇到就跳过，不影响主路径；
 *   · 不做 velocity 交叉淡入 —— 按 lovel/hivel 选一个 zone，重叠时取 keycenter 最近的那个。
 *
 * 线程纪律：装载在 HTTP 线程里发生，播放线程正在跑。所以装载只碰**非 live** 的那个槽，
 * 装完先掐掉全部发声（采样指针可能指向旧槽），最后一步才切 g_sfz_live。旧槽要等到
 * **下一次装载**才释放 —— 那之前所有指向它的声音都已经死了。
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

#define SFZ_MAX_ZONES   512
#define SFZ_MAX_BYTES   (512u * 1024u * 1024u)
#define SFZ_PATH_MAX    320

typedef struct {
    float*  pcm;          /* 交错多声道，已转成 float */
    int32_t frames;
    int32_t ch;
    int32_t rate;

    int32_t lokey, hikey, lovel, hivel, keycenter;
    float   tune;         /* 音分 */
    float   gain;         /* 线性，来自 volume(dB) */
    float   pan;          /* -1..1 */
    int32_t loop_mode;    /* 0 关 / 1 sustain / 2 continuous */
    int32_t loop_start, loop_end;
    int32_t offset;       /* 起播偏移（帧） */

    float   atk, dec, sus, rel;
    float   veltrack;     /* 0..1：力度对音量的影响 */
    char    name[80];
} ka_zone;

typedef struct {
    int32_t  nzone;
    int32_t  nfail;
    int64_t  bytes;
    ka_zone  zones[SFZ_MAX_ZONES];
    char     path[SFZ_PATH_MAX];
} ka_inst;

static ka_inst         g_sfz[2];
static volatile int32_t g_sfz_err = 0;    /* 最近一次装载失败在哪一步，诊断用 */
static char g_sfz_dbg[512];               /* 最后一步用的路径（降级成 ASCII，诊断用） */

/* 十六进制转储前 10 个 UTF-16 码元 + 两个 ASCII 前缀（IN = 传进来的 sfz 路径，OUT = 拼出来的采样路径）。 */
static void sfz_dbg_dump(const char* tag, const uint16_t* src) {
    static const char* hx = "0123456789abcdef";
    int i, o = 0;
    g_sfz_dbg[o++] = tag[0];
    g_sfz_dbg[o++] = tag[1];
    g_sfz_dbg[o++] = ' ';
    for (i = 0; i < 10; ++i) {
        uint16_t v = src[i];
        g_sfz_dbg[o++] = hx[(v >> 12) & 15];
        g_sfz_dbg[o++] = hx[(v >> 8) & 15];
        g_sfz_dbg[o++] = hx[(v >> 4) & 15];
        g_sfz_dbg[o++] = hx[v & 15];
        g_sfz_dbg[o++] = ' ';
    }
    g_sfz_dbg[o] = 0;
}
static volatile int32_t g_sfz_live = -1;   /* -1 = 没有装载乐器 */
static volatile int32_t g_sfz_gen  = 0;    /* 每次切换 +1，声部用它判悬空 */

/* ── 小工具（不依赖任何 CRT 函数） ───────────────────────────────────────────────────────────── */

static int sfz_ilower(int c) { return (c >= 'A' && c <= 'Z') ? c + 32 : c; }

static int sfz_ieq(const char* a, const char* b) {
    while (*a && *b) {
        if (sfz_ilower((unsigned char)*a) != sfz_ilower((unsigned char)*b)) return 0;
        ++a; ++b;
    }
    return *a == 0 && *b == 0;
}

/** 2^x。三项泰勒 + 位移动的 2^i —— 误差 < 0.1%，够给音分和 dB 用。 */
static float sfz_exp2(float x) {
    int   i;
    float f, y;
    if (x > 60.0f) x = 60.0f;
    if (x < -60.0f) x = -60.0f;
    i = (int)x;
    if ((float)i > x) --i;
    f = x - (float)i;
    y = 1.0f + f * (0.6931472f + f * (0.2400759f + f * 0.0574265f));
    while (i > 0) { y *= 2.0f; --i; }
    while (i < 0) { y *= 0.5f; ++i; }
    return y;
}

/** 10^(x/20)，即 dB → 线性。 */
static float sfz_db_to_lin(float db) { return sfz_exp2(db * 0.1660964f); }

static float sfz_atof(const char* s) {
    float sign = 1.0f, v = 0.0f, frac = 0.1f;
    if (!s) return 0.0f;
    while (*s == ' ' || *s == '\t') ++s;
    if (*s == '-') { sign = -1.0f; ++s; } else if (*s == '+') { ++s; }
    while (*s >= '0' && *s <= '9') { v = v * 10.0f + (float)(*s - '0'); ++s; }
    if (*s == '.') {
        ++s;
        while (*s >= '0' && *s <= '9') { v += (float)(*s - '0') * frac; frac *= 0.1f; ++s; }
    }
    return sign * v;
}

static int sfz_atoi(const char* s) { return (int)sfz_atof(s); }

/** UTF-8 → UTF-16。SFZ 文本是 UTF-8，而 CreateFileW 要宽字符。 */
static int sfz_u8_to_u16(const char* s, uint16_t* out, int cap) {
    int n = 0;
    const unsigned char* p = (const unsigned char*)s;
    while (*p && n < cap - 1) {
        uint32_t cp;
        if (*p < 0x80) { cp = *p++; }
        else if ((*p & 0xE0) == 0xC0 && p[1]) { cp = ((uint32_t)(*p & 0x1F) << 6) | (p[1] & 0x3F); p += 2; }
        else if ((*p & 0xF0) == 0xE0 && p[1] && p[2]) {
            cp = ((uint32_t)(*p & 0x0F) << 12) | ((uint32_t)(p[1] & 0x3F) << 6) | (p[2] & 0x3F); p += 3;
        } else if ((*p & 0xF8) == 0xF0 && p[1] && p[2] && p[3]) {
            cp = ((uint32_t)(*p & 0x07) << 18) | ((uint32_t)(p[1] & 0x3F) << 12)
               | ((uint32_t)(p[2] & 0x3F) << 6) | (p[3] & 0x3F); p += 4;
        } else { cp = '?'; ++p; }
        if (cp >= 0x10000) {
            cp -= 0x10000;
            if (n < cap - 2) { out[n++] = (uint16_t)(0xD800 + (cp >> 10)); out[n++] = (uint16_t)(0xDC00 + (cp & 0x3FF)); }
            else break;
        } else out[n++] = (uint16_t)cp;
    }
    out[n] = 0;
    return n;
}

/* ── 文件 IO ───────────────────────────────────────────────────────────────────────────────── */

/** 整个文件读进一块 VirtualAlloc 出来的内存。返回 0 表示失败。 */
static void* sfz_read_file(const uint16_t* path, int64_t* out_len) {
    void* h;
    int64_t size = 0;
    void* buf;
    uint32_t got = 0;
    h = CreateFileW(path, KA_GENERIC_READ, KA_FILE_SHARE_READ, 0, KA_OPEN_EXISTING, 0, 0);
    if (h == KA_INVALID_HANDLE) return 0;
    if (!GetFileSizeEx(h, &size) || size <= 0 || size > (int64_t)SFZ_MAX_BYTES) { CloseHandle(h); return 0; }
    buf = VirtualAlloc(0, (uint64_t)size, KA_MEM_COMMIT | KA_MEM_RESERVE, KA_PAGE_READWRITE);
    if (!buf) { CloseHandle(h); return 0; }
    if (!ReadFile(h, buf, (uint32_t)size, &got, 0) || (int64_t)got != size) {
        VirtualFree(buf, 0, KA_MEM_RELEASE);
        CloseHandle(h);
        return 0;
    }
    CloseHandle(h);
    *out_len = size;
    return buf;
}

/* ── WAV 解码：PCM16 / PCM24 / PCM32 / float32 ─────────────────────────────────────────────── */

static uint32_t sfz_u32(const uint8_t* p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }
static uint16_t sfz_u16(const uint8_t* p) { return (uint16_t)((uint32_t)p[0] | ((uint32_t)p[1] << 8)); }

static int sfz_mem_eq(const uint8_t* p, const char* tag) {
    int i;
    for (i = 0; i < 4; ++i) if (p[i] != (uint8_t)tag[i]) return 0;
    return 1;
}

/** 解一个 wav 到 zone->pcm（float 交错）。成功返回 1。 */
static int sfz_load_wav(const uint16_t* path, ka_zone* z) {
    int64_t len = 0;
    uint8_t* raw = (uint8_t*)sfz_read_file(path, &len);
    uint32_t pos = 12;
    uint16_t tag = 0, ch = 0, bits = 0;
    uint32_t rate = 0;
    const uint8_t* data = 0;
    uint32_t data_len = 0;
    int64_t i, nsamp;
    float* pcm;

    if (!raw) { g_sfz_err = 1; return 0; }
    if (len < 44 || !sfz_mem_eq(raw, "RIFF") || !sfz_mem_eq(raw + 8, "WAVE")) {
        g_sfz_err = 2;
        VirtualFree(raw, 0, KA_MEM_RELEASE);
        return 0;
    }
    while (pos + 8 <= (uint32_t)len) {
        uint32_t clen = sfz_u32(raw + pos + 4);
        const uint8_t* body = raw + pos + 8;
        if (pos + 8 + clen > (uint32_t)len) {
            /* 有些库的长度字段写错（-1 或含填充）。data 块按文件尾截断，其余放弃。 */
            if (sfz_mem_eq(raw + pos, "data")) { data = body; data_len = (uint32_t)len - pos - 8; break; }
            break;
        }
        if (sfz_mem_eq(raw + pos, "fmt ")) {
            if (clen >= 16) {
                tag = sfz_u16(body);
                ch = sfz_u16(body + 2);
                rate = sfz_u32(body + 4);
                bits = sfz_u16(body + 14);
            }
        } else if (sfz_mem_eq(raw + pos, "data")) {
            data = body;
            data_len = clen;
        }
        pos += 8 + clen + (clen & 1);
    }
    if (!data || !ch || !rate || !bits || (tag != 1 && tag != 3)) {
        g_sfz_err = 3 + (data ? 0 : 10) + (ch ? 0 : 20) + (rate ? 0 : 40) + (bits ? 0 : 80);
        VirtualFree(raw, 0, KA_MEM_RELEASE);
        return 0;
    }
    if (ch > 2) ch = 2;                      /* 多于立体声的只取前两路 */
    nsamp = (int64_t)data_len / ((bits / 8) * (int64_t)ch);
    if (nsamp <= 0 || nsamp > (int64_t)(SFZ_MAX_BYTES / 4)) {
        VirtualFree(raw, 0, KA_MEM_RELEASE);
        return 0;
    }
    pcm = (float*)VirtualAlloc(0, (uint64_t)nsamp * sizeof(float),
                               KA_MEM_COMMIT | KA_MEM_RESERVE, KA_PAGE_READWRITE);
    if (!pcm) { g_sfz_err = 4; VirtualFree(raw, 0, KA_MEM_RELEASE); return 0; }

    if (tag == 3 && bits == 32) {
        const float* src = (const float*)(data);
        for (i = 0; i < nsamp; ++i) pcm[i] = src[i];
    } else if (bits == 16) {
        const uint8_t* s = data;
        for (i = 0; i < nsamp; ++i, s += 2) pcm[i] = (float)(int16_t)sfz_u16(s) * (1.0f / 32768.0f);
    } else if (bits == 24) {
        const uint8_t* s = data;
        for (i = 0; i < nsamp; ++i, s += 3) {
            int32_t v = (int32_t)(((uint32_t)s[0] << 8) | ((uint32_t)s[1] << 16) | ((uint32_t)s[2] << 24));
            pcm[i] = (float)(v >> 8) * (1.0f / 8388608.0f);
        }
    } else if (bits == 32) {
        const uint8_t* s = data;
        for (i = 0; i < nsamp; ++i, s += 4) pcm[i] = (float)((int32_t)sfz_u32(s)) * (1.0f / 2147483648.0f);
    } else {
        g_sfz_err = 5;                       /* 位深不支持 */
        VirtualFree(pcm, 0, KA_MEM_RELEASE);
        VirtualFree(raw, 0, KA_MEM_RELEASE);
        return 0;
    }

    VirtualFree(raw, 0, KA_MEM_RELEASE);
    z->pcm = pcm;
    z->ch = (int32_t)ch;
    z->rate = (int32_t)rate;
    z->frames = (int32_t)(nsamp / ch);
    return 1;
}

/* ── SFZ 解析 ──────────────────────────────────────────────────────────────────────────────── */

typedef struct {
    int   lokey, hikey, lovel, hivel, keycenter;
    float tune, volume, pan, atk, dec, sus, rel, veltrack;
    int   loop_mode, loop_start, loop_end, offset;
    char  sample[SFZ_PATH_MAX];
} sfz_reg;

static void sfz_defaults(sfz_reg* r) {
    r->lokey = 0; r->hikey = 127; r->lovel = 0; r->hivel = 127;
    r->keycenter = -1;
    r->tune = 0.0f; r->volume = 0.0f; r->pan = 0.0f;
    r->atk = 0.002f; r->dec = 0.8f; r->sus = 0.0f; r->rel = 0.30f;
    r->veltrack = 1.0f;
    r->loop_mode = 0; r->loop_start = 0; r->loop_end = 0; r->offset = 0;
    r->sample[0] = 0;
}

static void sfz_copy(char* dst, const char* src, int cap) {
    int i = 0;
    while (src[i] && i < cap - 1) { dst[i] = src[i]; ++i; }
    dst[i] = 0;
}

static const char* sfz_basename(const char* p) {
    const char* b = p;
    while (*p) { if (*p == '/' || *p == '\\') b = p + 1; ++p; }
    return b;
}

static void sfz_opcode(sfz_reg* r, const char* k, const char* v) {
    if      (sfz_ieq(k, "sample"))     sfz_copy(r->sample, v, SFZ_PATH_MAX);
    else if (sfz_ieq(k, "lokey"))      r->lokey = sfz_atoi(v);
    else if (sfz_ieq(k, "hikey"))      r->hikey = sfz_atoi(v);
    else if (sfz_ieq(k, "lovel"))      r->lovel = sfz_atoi(v);
    else if (sfz_ieq(k, "hivel"))      r->hivel = sfz_atoi(v);
    else if (sfz_ieq(k, "pitch_keycenter") || sfz_ieq(k, "key")) r->keycenter = sfz_atoi(v);
    else if (sfz_ieq(k, "tune"))       r->tune = sfz_atof(v);
    else if (sfz_ieq(k, "volume"))     r->volume = sfz_atof(v);
    else if (sfz_ieq(k, "pan"))        r->pan = sfz_atof(v);
    else if (sfz_ieq(k, "ampeg_attack"))  r->atk = sfz_atof(v);
    else if (sfz_ieq(k, "ampeg_decay"))   r->dec = sfz_atof(v);
    else if (sfz_ieq(k, "ampeg_sustain")) r->sus = sfz_atof(v) * 0.01f;   /* SFZ 是百分比 */
    else if (sfz_ieq(k, "ampeg_release")) r->rel = sfz_atof(v);
    else if (sfz_ieq(k, "amp_veltrack"))  r->veltrack = sfz_atof(v) * 0.01f;
    else if (sfz_ieq(k, "loop_mode")) {
        if (sfz_ieq(v, "one_shot")) r->loop_mode = 0;
        else if (sfz_ieq(v, "loop_continuous")) r->loop_mode = 2;
        else if (sfz_ieq(v, "no_loop")) r->loop_mode = 0;
        else r->loop_mode = 1;
    }
    else if (sfz_ieq(k, "loop_start")) r->loop_start = sfz_atoi(v);
    else if (sfz_ieq(k, "loop_end"))   r->loop_end = sfz_atoi(v);
    else if (sfz_ieq(k, "offset"))     r->offset = sfz_atoi(v);
    /* 其余（filter / eg / lfo / seq / group / off_by …）第一版一律忽略。 */
}

/** 把累积出来的 region 落成一个 zone。返回 1 表示真的加进去了。 */
static int sfz_commit(ka_inst* inst, const sfz_reg* r, const uint16_t* sfz_path) {
    ka_zone* z;
    uint16_t full[SFZ_PATH_MAX * 2];
    float lin;
    if (!r->sample[0]) return 0;
    if (inst->nzone >= SFZ_MAX_ZONES) return 0;
    if (inst->bytes > (int64_t)SFZ_MAX_BYTES) return 0;

    z = &inst->zones[inst->nzone];
    z->pcm = 0;
    z->lokey = r->lokey; z->hikey = r->hikey;
    z->lovel = r->lovel; z->hivel = r->hivel;
    z->keycenter = (r->keycenter >= 0) ? r->keycenter : ((r->lokey > 0) ? r->lokey : 60);
    z->tune = r->tune;
    z->pan = r->pan < -1.0f ? -1.0f : (r->pan > 1.0f ? 1.0f : r->pan);
    z->loop_mode = r->loop_mode;
    z->loop_start = r->loop_start;
    z->loop_end = r->loop_end;
    z->offset = r->offset;
    z->atk = r->atk < 0.0f ? 0.0f : r->atk;
    z->dec = r->dec < 0.001f ? 0.001f : r->dec;
    z->sus = r->sus < 0.0f ? 0.0f : (r->sus > 1.0f ? 1.0f : r->sus);
    z->rel = r->rel < 0.001f ? 0.001f : r->rel;
    z->veltrack = r->veltrack < 0.0f ? 0.0f : (r->veltrack > 1.0f ? 1.0f : r->veltrack);
    lin = sfz_db_to_lin(r->volume);
    z->gain = (lin > 4.0f) ? 4.0f : lin;
    sfz_copy(z->name, sfz_basename(r->sample), 80);

    /* sfz 所在目录 + region 里的 sample。拼在这里而不调用辅助函数：/O2 下那次调用实测没有把
     * 结果写回 full（读出来全是栈垃圾），内联没有这个余地。 */
    {
        int o = 0, k, last = -1;
        int absol = (r->sample[0] && r->sample[1] == ':')
                 || (r->sample[0] == '\\' && r->sample[1] == '\\');
        if (!absol) {
            for (k = 0; sfz_path[k] && o < SFZ_PATH_MAX * 2 - 2; ++k) {
                full[o++] = sfz_path[k];
                if (sfz_path[k] == '\\' || sfz_path[k] == '/') last = o;
            }
            o = (last >= 0) ? last : 0;
        }
        for (k = 0; r->sample[k] && o < SFZ_PATH_MAX * 2 - 2; ++k) {
            char ch = r->sample[k];
            full[o++] = (ch == '/') ? (uint16_t)'\\' : (uint16_t)(unsigned char)ch;
        }
        full[o] = 0;
    }
    g_sfz_err = 0;
    if (!sfz_load_wav(full, z)) {
        sfz_dbg_dump("OU", full);       /* 只在失败时留证据，成功路径零开销 */
        inst->nfail++;
        return 0;
    }
    if (z->loop_end <= z->loop_start || z->loop_end > z->frames) z->loop_end = z->frames;
    if (z->offset >= z->frames) z->offset = 0;
    inst->bytes += (int64_t)z->frames * z->ch * 4;
    inst->nzone++;
    return 1;
}

static void sfz_free_slot(ka_inst* inst) {
    int i;
    for (i = 0; i < inst->nzone && i < SFZ_MAX_ZONES; ++i) {
        if (inst->zones[i].pcm) VirtualFree(inst->zones[i].pcm, 0, KA_MEM_RELEASE);
        inst->zones[i].pcm = 0;
    }
    inst->nzone = 0;
    inst->nfail = 0;
    inst->bytes = 0;
}

/**
 * 装载一个 .sfz。返回 zone 数；<0 是错误码（-1 读不到 / -2 没有 region / -3 全失败）。
 * 只在**非 live** 的槽里干活，装完切 live —— 播放线程永远不会看到半成品。
 */
static int sfz_load(const uint16_t* path) {
    char* text;
    int64_t len = 0;
    int i, li = 0;
    int slot;
    ka_inst* inst;
    sfz_reg grp, cur;
    int in_region = 0;
    char line[600];

    sfz_dbg_dump("IN", path);
    text = (char*)sfz_read_file(path, &len);
    if (!text) return -1;

    slot = (g_sfz_live == 0) ? 1 : 0;
    inst = &g_sfz[slot];
    sfz_free_slot(inst);                 /* 这一槽上一次装的东西到此为止 */

    sfz_defaults(&grp);
    sfz_copy(cur.sample, "", SFZ_PATH_MAX);
    cur = grp;

    for (i = 0; i <= (int)len; ++i) {
        char c = (i < (int)len) ? text[i] : '\n';
        if (c == '\r') continue;
        if (c != '\n') { if (li < 599) line[li++] = c; continue; }
        line[li] = 0;
        li = 0;

        {
            char* p = line;
            /* 注释先砍掉：// 到行尾 */
            {
                char* q = p;
                while (*q) { if (q[0] == '/' && q[1] == '/') { *q = 0; break; } ++q; }
            }
            while (*p) {
                while (*p == ' ' || *p == '\t') ++p;
                if (!*p) break;
                if (*p == '<') {
                    char* e = p + 1;
                    int closed = 0;
                    while (*e && *e != '>') ++e;
                    if (*e == '>') { *e = 0; closed = 1; }   /* 截断成 "region"，但记住后面还有东西 */
                    if (sfz_ieq(p + 1, "region")) {
                        if (in_region) sfz_commit(inst, &cur, path);
                        cur = grp;
                        in_region = 1;
                    } else if (sfz_ieq(p + 1, "group")) {
                        if (in_region) { sfz_commit(inst, &cur, path); in_region = 0; }
                        grp = cur;              /* group 从当前值起步（含 global 累积） */
                    } else if (sfz_ieq(p + 1, "global")) {
                        if (in_region) { sfz_commit(inst, &cur, path); in_region = 0; }
                        /* global 直接写进 grp —— 后面的 region 从它抄 */
                    } else {
                        /* control / master / curve / effect / midi … 与采样无关 */
                        if (in_region) { sfz_commit(inst, &cur, path); in_region = 0; }
                    }
                    /* 同一行 header 后面的 opcode 要接着读：`<region> sample=x.wav` 是最常见写法。 */
                    p = closed ? e + 1 : e;
                    continue;
                }
                {
                    char* k = p;
                    char  sep;
                    char* v;
                    while (*p && *p != '=' && *p != ' ' && *p != '\t') ++p;
                    sep = *p;
                    if (*p) *p++ = 0;
                    if (sep != '=') continue;
                    while (*p == ' ' || *p == '\t') ++p;
                    v = p;
                    if (*p == '"') {                      /* 带引号的路径可以含空格 */
                        ++v; ++p;
                        while (*p && *p != '"') ++p;
                        if (*p) *p++ = 0;
                    } else {
                        while (*p && *p != ' ' && *p != '\t') ++p;
                        if (*p) *p++ = 0;
                    }
                    sfz_opcode(in_region ? &cur : &grp, k, v);
                }
            }
        }
    }
    if (in_region) sfz_commit(inst, &cur, path);      /* 最后一段没有紧跟 header */

    VirtualFree(text, 0, KA_MEM_RELEASE);

    if (inst->nzone <= 0) {
        int nf = inst->nfail;
        sfz_free_slot(inst);
        return nf > 0 ? -3 : -2;
    }
    sfz_copy(inst->path, "", SFZ_PATH_MAX);
    g_sfz_gen = g_sfz_gen + 1;
    g_sfz_live = slot;
    return inst->nzone;
}

static void sfz_unload(void) {
    int slot = (g_sfz_live == 0) ? 1 : 0;
    g_sfz_live = -1;
    g_sfz_gen = g_sfz_gen + 1;
    sfz_free_slot(&g_sfz[slot]);
}

/* ── 播放 ──────────────────────────────────────────────────────────────────────────────────── */

/** 按 key/vel 挑 zone：优先 keycenter 最近的，其次先来的。没有就返回 0。 */
static ka_zone* sfz_pick(int note, int vel) {
    ka_inst* inst;
    int slot = g_sfz_live;
    int i, best = -1, bestd = 1 << 30;
    if (slot < 0) return 0;
    inst = &g_sfz[slot];
    for (i = 0; i < inst->nzone; ++i) {
        ka_zone* z = &inst->zones[i];
        int d;
        if (note < z->lokey || note > z->hikey) continue;
        if (vel < z->lovel || vel > z->hivel) continue;
        d = note - z->keycenter;
        if (d < 0) d = -d;
        if (d < bestd) { bestd = d; best = i; }
    }
    return (best < 0) ? 0 : &inst->zones[best];
}

/** 一个输出帧的采样值。位置按 step 前进，loop_mode 生效，越界返 0。 */
static float sfz_read(ka_zone* z, double* sp, double step) {
    double p = *sp;
    int    i0, i1;
    float  frac, a, b, s;
    int    last = z->frames - 1;

    if (!z->pcm || last < 0) return 0.0f;
    if (p < 0.0) p = 0.0;

    if (z->loop_mode && z->loop_end > z->loop_start + 2 && p >= (double)z->loop_end) {
        double span = (double)(z->loop_end - z->loop_start);
        double t = p - (double)z->loop_start;
        double k = (double)(int)(t / span);          /* 整除用 SSE，不碰 CRT */
        p = (double)z->loop_start + (t - span * k);
    }
    if (p > (double)last) { *sp = p; return 0.0f; }

    i0 = (int)p;
    i1 = i0 + 1;
    frac = (float)(p - (double)i0);
    if (i1 > last) { i1 = last; frac = 0.0f; }

    if (z->ch == 1) {
        a = z->pcm[i0];
        b = z->pcm[i1];
    } else {
        a = 0.5f * (z->pcm[i0 * z->ch] + z->pcm[i0 * z->ch + 1]);
        b = 0.5f * (z->pcm[i1 * z->ch] + z->pcm[i1 * z->ch + 1]);
    }
    s = a + (b - a) * frac;
    *sp = p + step;
    return s;
}
