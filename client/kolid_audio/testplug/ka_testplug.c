/* ── KaTestSynth：一个最小 VST3 插件，用来当宿主的尺子 ──────────────────────────────────────
 *
 * 为什么要这个东西：本机那批插件（Ample Sound / Kontakt / HALion）都是采样乐器，
 * 装上之后一片静音 —— 但静音既可能是"宿主送错了事件/缓冲"，也可能是"它自己没有音色库或授权"。
 * 分不清这两件事，就没法判断 ka_vst3.h 到底对不对。
 *
 * 所以这里造一个**自己的插件**：只有一根正弦、只听 noteOn/noteOff、不读盘、不依赖任何库。
 *   · 它响 → 宿主的通道（激活、块、事件、声道指针、采样率）是通的；别人不响是别人的事。
 *   · 它不响 → 宿主错在能定位的那几处，改完立刻能验证。
 *
 * 刻意做成"独立实现"：这里**不 include ka_vst3.h**，IID、结构体、vtable 全都另写一份。
 * 两边共用一份声明的话，同错同对，就测不出问题了。
 *
 * 单实例：只服务"一次开一个插件"的测试场景，所以对象是静态的，createInstance 返回同一套。
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

#include <stdint.h>

int _fltused = 0;

/* /NODEFAULTLIB 下没有 CRT，而 /O2 会把"整段清零"换成 memset —— 不自己给一份就 LNK2019。
 * #pragma function 禁止编译器把这两个实现又优化回对自身的调用。 */
#pragma function(memcpy, memset)

void* __cdecl memset(void* dst, int c, uint64_t n) {
    unsigned char* d = (unsigned char*)dst;
    while (n--) *d++ = (unsigned char)c;
    return dst;
}

void* __cdecl memcpy(void* dst, const void* src, uint64_t n) {
    unsigned char* d = (unsigned char*)dst;
    const unsigned char* s = (const unsigned char*)src;
    while (n--) *d++ = *s++;
    return dst;
}

typedef int32_t tp_result;
typedef char tp_tuid[16];
typedef uint16_t tp_tchar;

#define TP_OK 0
#define TP_ERR 1
#define TP_NOIF (-1)
#define TP_AUDIO 0
#define TP_EVENT 1
#define TP_IN 0
#define TP_OUT 1

/* ★ 与 ka_vst3.h 独立算出的一份 IID（同样来自 SDK 的 INLINE_UID 展开规则） */
static const char TP_IID_FUNKNOWN[16] =
    { 0,0,0,0, 0,0,0,0, (char)0xC0,0,0,0, 0,0,0,0x46 };
static const char TP_IID_ICOMPONENT[16] =
    { 0x31,(char)0xFF,0x31,(char)0xE8, (char)0xD5,(char)0xF2,0x01,0x43,
      (char)0x92,(char)0x8E,(char)0xBB,(char)0xEE, 0x25,0x69,0x78,0x02 };
static const char TP_IID_IAUDIOPROCESSOR[16] =
    { (char)0x99,0x3F,0x04,0x42, (char)0xDA,(char)0xB7,0x3C,0x45,
      (char)0xA5,0x69,(char)0xE7,(char)0x9D, (char)0x9A,(char)0xAE,(char)0xC3,0x3D };

/* 类 ID：VST3 允许直接用 16 个可读字符当 TUID */
static const char TP_CLASS_ID[16] = "KaTestSynth0000";

typedef struct tp_factory_info {
    char vendor[64];
    char url[256];
    char email[128];
    int32_t flags;
} tp_factory_info;

typedef struct tp_class_info {
    char cid[16];
    int32_t cardinality;
    char category[32];
    char name[64];
} tp_class_info;

typedef struct tp_string128 { tp_tchar s[128]; } tp_string128;

typedef struct tp_bus_info {
    int32_t mediaType;
    int32_t direction;
    int32_t channelCount;
    tp_string128 name;
    int32_t busType;
    uint32_t flags;
} tp_bus_info;

typedef struct tp_routing { int32_t mediaType, busIndex, channel; } tp_routing;

typedef struct tp_setup {
    int32_t processMode, symbolicSampleSize, maxSamplesPerBlock;
    double sampleRate;
} tp_setup;

typedef struct tp_bus_buffers {
    int32_t numChannels;
    uint64_t silenceFlags;
    union { float** f32; double** f64; } u;
} tp_bus_buffers;

typedef struct tp_chord { uint8_t key, root; int16_t mask; } tp_chord;
typedef struct tp_framerate { uint32_t fps, flags; } tp_framerate;

typedef struct tp_context {
    uint32_t state;
    double sampleRate;
    int64_t projectTimeSamples, systemTime, continousTimeSamples;
    double projectTimeMusic, barPositionMusic, cycleStartMusic, cycleEndMusic, tempo;
    int32_t timeSigNum, timeSigDen;
    tp_chord chord;
    int32_t smpteOffset;
    tp_framerate frameRate;
    int32_t samplesToNextClock;
} tp_context;

typedef struct tp_noteon {
    int16_t channel, pitch;
    float tuning, velocity;
    int32_t length, noteId;
} tp_noteon;

typedef struct tp_noteoff {
    int16_t channel, pitch;
    float velocity;
    int32_t noteId;
    float tuning;
} tp_noteoff;

typedef struct tp_event {
    int32_t busIndex, sampleOffset;
    double ppq;
    uint16_t flags, type;
    /* ★ union 里必须有一个 8 字节对齐的成员（SDK 里是 DataEvent::bytes / ChordEvent::text
     *   这类指针）。只放 int16/float/int32 的话 union 对齐会掉到 4，union 从偏移 20 开始，
     *   整个 Event 变 44 字节 —— 宿主写 24、插件读 20，pitch 就永远读到 0。
     *   下面的 sizeof 检查就是拦这个的。 */
    union {
        tp_noteon on;
        tp_noteoff off;
        void* align8;
        uint8_t raw[24];
    } u;
} tp_event;

typedef char tp_event_size_check[(sizeof(tp_event) == 48) ? 1 : -1];

typedef struct tp_procdata {
    int32_t processMode, symbolicSampleSize, numSamples, numInputs, numOutputs;
    tp_bus_buffers* inputs;
    tp_bus_buffers* outputs;
    void* inParamChanges;
    void* outParamChanges;
    void* inEvents;
    void* outEvents;
    tp_context* ctx;
} tp_procdata;

/* IEventList 的 vtable（我们要**调**它，所以按 SDK 顺序自己排一份） */
typedef struct tp_evlist {
    const void** vtbl;
} tp_evlist;
typedef struct tp_evlist_vtbl {
    tp_result (*qi)(void*, const char*, void**);
    uint32_t (*addRef)(void*);
    uint32_t (*release)(void*);
    int32_t (*count)(void*);
    tp_result (*get)(void*, int32_t, tp_event*);
    tp_result (*add)(void*, tp_event*);
} tp_evlist_vtbl;

/* ── 对象 ─────────────────────────────────────────────────────────────────────────────────── */

typedef struct tp_voice {
    int32_t on;
    int32_t pitch;
    float vel;
    double phase;      /* 0..1 */
    double inc;
    float env;
} tp_voice;

#define TP_VOICES 8

typedef struct tp_obj {
    const void** vtbl;
    int32_t refs;
    /* 组件状态 */
    double rate;
    int32_t active;
    int32_t processing;
    /* 声音状态 */
    tp_voice v[TP_VOICES];
    int32_t noteCount;      /* 收到过几个 noteOn（给宿主诊断用） */
    int32_t blockCount;
} tp_obj;

typedef struct tp_proc {
    const void** vtbl;
    int32_t refs;
    tp_obj* owner;
} tp_proc;

static tp_obj g_obj;
static tp_proc g_proc;

/* 上一块收到的缓冲参数（排障用） */
static int32_t g_last_numout = -1;
static int32_t g_last_numch = -1;
static int32_t g_last_samples = -1;
static int32_t g_last_ptr = 0;
static int32_t g_last_max = 0;       /* 这一块写出去的最大绝对值（千分比） */
static int64_t g_last_addr = 0;      /* 它写的那个地址（低 32 位够对比了） */
static int32_t g_last_ev[12];        /* 第 0 条事件的原始 12 个机器字（48 字节） */
static int32_t g_last_evcount = -1;

/* ── 数学：没有 CRT，正弦用 Bhaskara 近似 ───────────────────────────────────────────────────── */

static double tp_pi(void) { return 3.14159265358979323846; }

static double tp_sin01(double phase) {
    /* phase 0..1 → sin(2πphase) */
    double x = phase - (double)(int)phase;      /* 折回 0..1 */
    double t;
    int32_t sign = 1;
    if (x > 0.5) { x -= 0.5; sign = -1; }
    t = x * 2.0 * tp_pi();                      /* 0..π */
    /* Bhaskara I：sin(t) ≈ 16t(π-t)/(5π²-4t(π-t)) */
    {
        double num = 16.0 * t * (tp_pi() - t);
        double den = 5.0 * tp_pi() * tp_pi() - 4.0 * t * (tp_pi() - t);
        return sign * num / den;
    }
}

static double tp_exp2(double x) {
    /* 2^x：整数部分移位 + 小数部分泰勒（够用，只为算音高） */
    int32_t i = (int32_t)(x < 0 ? x - 0.999999 : x);
    double fr = x - (double)i;
    double r = 1.0 + fr * (0.6931472 + fr * (0.2402265 + fr * (0.0555041 + fr * 0.0096181)));
    int32_t s = i > 0 ? i : -i;
    double p = 1.0;
    while (s-- > 0) p *= 2.0;
    return (i >= 0) ? r * p : r / p;
}

static void tp_zero(void* p, int32_t n) {
    unsigned char* d = (unsigned char*)p;
    int32_t i;
    for (i = 0; i < n; ++i) d[i] = 0;
}

static int32_t tp_mem_eq(const char* a, const char* b, int32_t n) {
    int32_t i;
    for (i = 0; i < n; ++i) if (a[i] != b[i]) return 0;
    return 1;
}

/* ── 组件（IComponent / IPluginBase / FUnknown） ──────────────────────────────────────────── */

static tp_result tp_comp_qi(void* self, const char* iid, void** obj);
static uint32_t tp_comp_addref(void* self);
static uint32_t tp_comp_release(void* self);
static tp_result tp_comp_initialize(void* self, void* ctx);
static tp_result tp_comp_terminate(void* self);
static tp_result tp_comp_ctrlid(void* self, char* cid);
static tp_result tp_comp_setiomode(void* self, int32_t mode);
static int32_t tp_comp_buscount(void* self, int32_t type, int32_t dir);
static tp_result tp_comp_businfo(void* self, int32_t type, int32_t dir, int32_t idx, tp_bus_info* bi);
static tp_result tp_comp_routing(void* self, tp_routing* in, tp_routing* out);
static tp_result tp_comp_activate_bus(void* self, int32_t type, int32_t dir, int32_t idx, uint8_t st);
static tp_result tp_comp_setactive(void* self, uint8_t st);
static tp_result tp_comp_setstate(void* self, void* stream);
static tp_result tp_comp_getstate(void* self, void* stream);

static const void* g_comp_vtbl[14] = {
    (const void*)tp_comp_qi, (const void*)tp_comp_addref, (const void*)tp_comp_release,
    (const void*)tp_comp_initialize, (const void*)tp_comp_terminate,
    (const void*)tp_comp_ctrlid, (const void*)tp_comp_setiomode,
    (const void*)tp_comp_buscount, (const void*)tp_comp_businfo, (const void*)tp_comp_routing,
    (const void*)tp_comp_activate_bus, (const void*)tp_comp_setactive,
    (const void*)tp_comp_setstate, (const void*)tp_comp_getstate
};

/* ── 处理器（IAudioProcessor） ────────────────────────────────────────────────────────────── */

static tp_result tp_proc_qi(void* self, const char* iid, void** obj);
static uint32_t tp_proc_addref(void* self);
static uint32_t tp_proc_release(void* self);
static tp_result tp_proc_setarr(void* self, uint64_t* ins, int32_t ni, uint64_t* outs, int32_t no);
static tp_result tp_proc_getarr(void* self, int32_t dir, int32_t idx, uint64_t* arr);
static tp_result tp_proc_cansize(void* self, int32_t size);
static uint32_t tp_proc_latency(void* self);
static tp_result tp_proc_setup(void* self, tp_setup* s);
static tp_result tp_proc_setprocessing(void* self, uint8_t st);
static tp_result tp_proc_process(void* self, tp_procdata* d);
static uint32_t tp_proc_tail(void* self);

static const void* g_proc_vtbl[11] = {
    (const void*)tp_proc_qi, (const void*)tp_proc_addref, (const void*)tp_proc_release,
    (const void*)tp_proc_setarr, (const void*)tp_proc_getarr, (const void*)tp_proc_cansize,
    (const void*)tp_proc_latency, (const void*)tp_proc_setup, (const void*)tp_proc_setprocessing,
    (const void*)tp_proc_process, (const void*)tp_proc_tail
};

/* ── 组件实现 ─────────────────────────────────────────────────────────────────────────────── */

static tp_result tp_comp_qi(void* self, const char* iid, void** obj) {
    tp_obj* o = (tp_obj*)self;
    if (!obj) return TP_NOIF;
    *obj = 0;
    if (tp_mem_eq(iid, TP_IID_ICOMPONENT, 16) || tp_mem_eq(iid, TP_IID_FUNKNOWN, 16)) {
        o->refs++;
        *obj = self;
        return TP_OK;
    }
    if (tp_mem_eq(iid, TP_IID_IAUDIOPROCESSOR, 16)) {
        g_proc.refs++;
        o->refs++;
        *obj = &g_proc.vtbl;
        return TP_OK;
    }
    return TP_NOIF;
}

static uint32_t tp_comp_addref(void* self) { return (uint32_t)(++((tp_obj*)self)->refs); }
static uint32_t tp_comp_release(void* self) { return (uint32_t)(--((tp_obj*)self)->refs); }

static tp_result tp_comp_initialize(void* self, void* ctx) {
    (void)ctx;
    ((tp_obj*)self)->rate = 48000.0;
    return TP_OK;
}

static tp_result tp_comp_terminate(void* self) { (void)self; return TP_OK; }
static tp_result tp_comp_ctrlid(void* self, char* cid) { (void)self; (void)cid; return TP_ERR; }
static tp_result tp_comp_setiomode(void* self, int32_t mode) { (void)self; (void)mode; return TP_OK; }

static int32_t tp_comp_buscount(void* self, int32_t type, int32_t dir) {
    (void)self;
    if (type == TP_AUDIO) return dir == TP_OUT ? 1 : 0;   /* 纯乐器：没有音频输入 */
    if (type == TP_EVENT) return dir == TP_IN ? 1 : 0;
    return 0;
}

static void tp_set_name(tp_string128* dst, const char* src) {
    int32_t i = 0;
    while (src[i] && i < 127) { dst->s[i] = (tp_tchar)(unsigned char)src[i]; ++i; }
    dst->s[i] = 0;
}

static tp_result tp_comp_businfo(void* self, int32_t type, int32_t dir, int32_t idx, tp_bus_info* bi) {
    (void)self; (void)idx;
    if (!bi) return TP_ERR;
    tp_zero(bi, (int32_t)sizeof(*bi));
    bi->mediaType = type;
    bi->direction = dir;
    if (type == TP_AUDIO && dir == TP_OUT) {
        bi->channelCount = 2;
        bi->busType = 0;
        bi->flags = 1;                   /* kDefaultActive */
        tp_set_name(&bi->name, "Output");
        return TP_OK;
    }
    if (type == TP_EVENT && dir == TP_IN) {
        bi->channelCount = 1;
        bi->busType = 0;
        bi->flags = 1;
        tp_set_name(&bi->name, "MIDI In");
        return TP_OK;
    }
    return TP_ERR;
}

static tp_result tp_comp_routing(void* self, tp_routing* in, tp_routing* out) {
    (void)self; (void)in; (void)out;
    return TP_ERR;
}

static tp_result tp_comp_activate_bus(void* self, int32_t type, int32_t dir, int32_t idx, uint8_t st) {
    (void)self; (void)type; (void)dir; (void)idx; (void)st;
    return TP_OK;
}

static tp_result tp_comp_setactive(void* self, uint8_t st) {
    ((tp_obj*)self)->active = st ? 1 : 0;
    return TP_OK;
}

static tp_result tp_comp_setstate(void* self, void* stream) { (void)self; (void)stream; return TP_ERR; }
static tp_result tp_comp_getstate(void* self, void* stream) { (void)self; (void)stream; return TP_ERR; }

/* ── 处理器实现 ───────────────────────────────────────────────────────────────────────────── */

static tp_obj* tp_owner(void* self) { return ((tp_proc*)self)->owner; }

static tp_result tp_proc_qi(void* self, const char* iid, void** obj) {
    tp_proc* p = (tp_proc*)self;
    if (!obj) return TP_NOIF;
    *obj = 0;
    if (tp_mem_eq(iid, TP_IID_IAUDIOPROCESSOR, 16) || tp_mem_eq(iid, TP_IID_FUNKNOWN, 16)) {
        p->refs++;
        *obj = self;
        return TP_OK;
    }
    if (tp_mem_eq(iid, TP_IID_ICOMPONENT, 16)) {
        p->owner->refs++;
        *obj = p->owner;
        return TP_OK;
    }
    return TP_NOIF;
}

static uint32_t tp_proc_addref(void* self) { return (uint32_t)(++((tp_proc*)self)->refs); }
static uint32_t tp_proc_release(void* self) { return (uint32_t)(--((tp_proc*)self)->refs); }

static tp_result tp_proc_setarr(void* self, uint64_t* ins, int32_t ni, uint64_t* outs, int32_t no) {
    (void)self; (void)ins; (void)ni; (void)outs; (void)no;
    return TP_OK;                        /* 只支持立体声，别的请求也当"就这么办" */
}

static tp_result tp_proc_getarr(void* self, int32_t dir, int32_t idx, uint64_t* arr) {
    (void)self; (void)dir; (void)idx;
    if (arr) *arr = 3;                   /* kSpeakerL | kSpeakerR */
    return TP_OK;
}

static tp_result tp_proc_cansize(void* self, int32_t size) {
    (void)self;
    return size == 0 ? TP_OK : TP_ERR;   /* 只做 32 位浮点 */
}

static uint32_t tp_proc_latency(void* self) { (void)self; return 0; }
static uint32_t tp_proc_tail(void* self) { (void)self; return 0; }

static tp_result tp_proc_setup(void* self, tp_setup* s) {
    tp_obj* o = tp_owner(self);
    if (!s) return TP_ERR;
    if (s->sampleRate > 1000.0) o->rate = s->sampleRate;
    return TP_OK;
}

static tp_result tp_proc_setprocessing(void* self, uint8_t st) {
    tp_owner(self)->processing = st ? 1 : 0;
    return TP_OK;
}

static void tp_note_on(tp_obj* o, int32_t pitch, float vel) {
    int32_t i;
    for (i = 0; i < TP_VOICES; ++i) {
        if (!o->v[i].on) {
            o->v[i].on = 1;
            o->v[i].pitch = pitch;
            o->v[i].vel = vel;
            o->v[i].phase = 0.0;
            o->v[i].env = 1.0f;
            /* 440Hz = A4 = 音高 69 */
            o->v[i].inc = (440.0 * tp_exp2(((double)pitch - 69.0) / 12.0)) / o->rate;
            o->noteCount++;
            return;
        }
    }
}

static void tp_note_off(tp_obj* o, int32_t pitch) {
    int32_t i;
    for (i = 0; i < TP_VOICES; ++i) {
        if (o->v[i].on && o->v[i].pitch == pitch) o->v[i].on = 0;   /* 进释放段 */
    }
}

static void tp_drain_events(tp_obj* o, void* inEvents) {
    const tp_evlist_vtbl* vt;
    tp_evlist* l = (tp_evlist*)inEvents;
    int32_t n, i;
    tp_event e;
    if (!l) return;
    /* l->vtbl 就是函数表本身；再解一层就会把表里第一个函数指针当成表头（调用即崩）。 */
    vt = (const tp_evlist_vtbl*)l->vtbl;
    n = vt->count(l);
    g_last_evcount = n;
    for (i = 0; i < n; ++i) {
        tp_zero(&e, (int32_t)sizeof(e));
        if (vt->get(l, i, &e) != TP_OK) continue;
        if (i == 0) {
            int32_t k;
            const int32_t* w = (const int32_t*)&e;
            for (k = 0; k < 12 && k < (int32_t)(sizeof(e) / 4); ++k) g_last_ev[k] = w[k];
        }
        if (e.type == 0) tp_note_on(o, e.u.on.pitch, e.u.on.velocity);
        else if (e.type == 1) tp_note_off(o, e.u.off.pitch);
    }
}

static tp_result tp_proc_process(void* self, tp_procdata* d) {
    tp_obj* o = tp_owner(self);
    int32_t i, f, ch;
    if (!d || d->numSamples <= 0) return TP_ERR;
    o->blockCount++;

    tp_drain_events(o, d->inEvents);

    /* 把这一块的账记下来给宿主排障看（静音时第一时间要知道"它到底收到几个声道"）。 */
    g_last_numout = d->numOutputs;
    g_last_numch = (d->outputs && d->numOutputs > 0) ? d->outputs[0].numChannels : -1;
    g_last_samples = d->numSamples;
    g_last_ptr = (d->outputs && d->numOutputs > 0 && d->outputs[0].u.f32) ? 1 : 0;

    if (!d->outputs || d->numOutputs < 1) return TP_OK;
    ch = d->outputs[0].numChannels;
    if (ch > 2) ch = 2;

    for (f = 0; f < d->numSamples; ++f) {
        double mix = 0.0;
        for (i = 0; i < TP_VOICES; ++i) {
            tp_voice* v = o->v + i;
            double s;
            if (!v->on && v->env <= 0.0001f) continue;
            s = tp_sin01(v->phase) * (double)v->env * (double)v->vel;
            v->phase += v->inc;
            if (v->phase >= 1.0) v->phase -= 1.0;
            if (!v->on) {
                v->env *= 0.9994f;        /* 约 0.35s 的释放 */
                if (v->env < 0.0005f) v->env = 0.0f;
            } else {
                v->env += (1.0f - v->env) * 0.02f;   /* 极短的起音 */
            }
            mix += s * 0.22;
        }
        for (i = 0; i < ch; ++i) {
            float* p = d->outputs[0].u.f32[i];
            if (p) p[f] = (float)mix;
        }
        {
            int32_t a = (int32_t)(mix < 0 ? -mix * 1000.0 : mix * 1000.0);
            if (a < 0) a = -a;
            if (a > g_last_max) g_last_max = a;
        }
    }
    g_last_addr = (int64_t)(unsigned long long)d->outputs[0].u.f32[0];
    return TP_OK;
}

/* ── 工厂 ─────────────────────────────────────────────────────────────────────────────────── */

static tp_result fac_qi(void* self, const char* iid, void** obj) {
    (void)self;
    if (!obj) return TP_NOIF;
    *obj = 0;
    if (tp_mem_eq(iid, TP_IID_FUNKNOWN, 16)) { *obj = self; return TP_OK; }
    return TP_NOIF;
}
static uint32_t fac_addref(void* self) { (void)self; return 2; }
static uint32_t fac_release(void* self) { (void)self; return 1; }

static tp_result fac_info(void* self, tp_factory_info* info) {
    int32_t i = 0;
    static const char* V = "Kolid";
    static const char* U = "https://example.invalid";
    static const char* E = "none";
    (void)self;
    if (!info) return TP_ERR;
    tp_zero(info, (int32_t)sizeof(*info));
    for (i = 0; V[i]; ++i) info->vendor[i] = V[i];
    for (i = 0; U[i]; ++i) info->url[i] = U[i];
    for (i = 0; E[i]; ++i) info->email[i] = E[i];
    info->flags = 0;
    return TP_OK;
}

static int32_t fac_count(void* self) { (void)self; return 1; }

static tp_result fac_classinfo(void* self, int32_t idx, tp_class_info* ci) {
    int32_t i;
    static const char* CAT = "Audio Module Class";
    static const char* NM = "KaTestSynth";
    (void)self;
    if (!ci || idx != 0) return TP_ERR;
    tp_zero(ci, (int32_t)sizeof(*ci));
    for (i = 0; i < 16; ++i) ci->cid[i] = TP_CLASS_ID[i];
    ci->cardinality = 0x7FFFFFFF;
    for (i = 0; CAT[i]; ++i) ci->category[i] = CAT[i];
    for (i = 0; NM[i]; ++i) ci->name[i] = NM[i];
    return TP_OK;
}

static tp_result fac_create(void* self, const char* cid, const char* iid, void** obj) {
    (void)self;
    if (!cid || !iid || !obj) return TP_ERR;
    *obj = 0;
    if (!tp_mem_eq(cid, TP_CLASS_ID, 16)) return TP_NOIF;
    /* iid 认 IComponent / FUnknown / IAudioProcessor —— 三种都给，随便宿主怎么递 */
    return tp_comp_qi(&g_obj, iid, obj);
}

static const void* g_fac_vtbl[7] = {
    (const void*)fac_qi, (const void*)fac_addref, (const void*)fac_release,
    (const void*)fac_info, (const void*)fac_count, (const void*)fac_classinfo,
    (const void*)fac_create
};

/* 工厂也要是一个"对象"（第一格是 vtable 指针），不能直接把表当对象递出去 —— 宿主的
 * KA_VT 取的是 obj 的第一个机器字，递表本身会让它把第一个函数指针当成表。 */
typedef struct tp_fac { const void** vtbl; int32_t refs; } tp_fac;
static tp_fac g_fac;

__declspec(dllexport) void* GetPluginFactory(void) {
    g_obj.vtbl = g_comp_vtbl;
    g_obj.refs = 1;
    g_obj.rate = 48000.0;
    g_proc.vtbl = g_proc_vtbl;
    g_proc.refs = 1;
    g_proc.owner = &g_obj;
    g_fac.vtbl = g_fac_vtbl;
    g_fac.refs = 1;
    return (void*)&g_fac;
}

__declspec(dllexport) int ka_testplug_notes(void) { return g_obj.noteCount; }
__declspec(dllexport) int ka_testplug_blocks(void) { return g_obj.blockCount; }

/** 上一块收到的：out[0]=numOutputs out[1]=outputs[0].numChannels out[2]=numSamples
 *  out[3]=缓冲指针非空 out[4]=正在响的声部数。 */
__declspec(dllexport) int ka_testplug_last(int* out, int n) {
    int32_t i, live = 0;
    if (!out || n < 12) return 0;
    for (i = 0; i < TP_VOICES; ++i) if (g_obj.v[i].on || g_obj.v[i].env > 0.0f) live++;
    out[0] = g_last_numout;
    out[1] = g_last_numch;
    out[2] = g_last_samples;
    out[3] = g_last_ptr;
    out[4] = live;
    out[5] = g_last_max;
    out[6] = (int32_t)(g_last_addr & 0xFFFFFFFF);
    /* 声部 0 的内部量（都放大成整数，不引 CRT 打印） */
    out[7] = g_obj.v[0].pitch;
    out[8] = (int32_t)(g_obj.v[0].vel * 1000.0f);
    out[9] = (int32_t)(g_obj.v[0].inc * 1000000.0);
    out[10] = (int32_t)(g_obj.v[0].phase * 1000000.0);
    out[11] = (int32_t)(g_obj.rate);
    return 12;
}

/** 第 0 条事件的原始 48 字节（12 个机器字）+ 事件数。
 *  union 从第 24 字节才开始，取少了会误判成"空事件"。 */
__declspec(dllexport) int ka_testplug_event(int* out, int n) {
    int32_t i;
    if (!out || n < 13) return 0;
    out[0] = g_last_evcount;
    for (i = 0; i < 12; ++i) out[i + 1] = g_last_ev[i];
    return 13;
}

int __stdcall DllMain(void* mod, uint32_t reason, void* rsv) {
    (void)mod; (void)rsv; (void)reason;
    return 1;
}
