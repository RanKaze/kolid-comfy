/* ── KolidAudio · VST3 宿主（第一层：认得 ABI） ───────────────────────────────────────────────
 *
 * 这台机器上有真插件（C:\Program Files\Common Files\VST3，24 个扁平 .vst3 + Kontakt 7），
 * 但**没有 VST3 SDK**。所以这里照老规矩手写声明，不引入 SDK、不改构建脚本。
 *
 * 手写容易错的两处，都已经用二进制证据钉死，别再凭记忆改：
 *
 *  1. **IID 的 16 个字节**。现行 SDK 写的是四个 uint32
 *     （`DECLARE_CLASS_IID (IComponent, 0xE831FF31, 0xF2D54301, 0x928EBBEE, 0x25697802)`），
 *     而 INLINE_UID 在 COM_COMPATIBLE 下不是四个小端 —— 第 2 个字的一半是反的、第 3/4 个字
 *     整体大端。照字面"小端展开"会得到一串错的字节（我第一遍就错了）。
 *     校验方法：把算出来的 16 字节拿去插件二进制里搜。ABA.vst3（Ample Sound，JUCE 打包）
 *     与 Kontakt 7.vst3 各命中 2 次 —— 命中即说明字节排布与插件比较的那份完全一致。
 *
 *  2. **vtable 顺序**。照 temporary/vst3ref/*.h（真 SDK 头文件，只作参考，不参与构建）逐条抄，
 *     不按印象排。派生接口是在基类 vtable 后面追加，所以下面每个 vtbl 结构体都从
 *     queryInterface/addRef/release 三连开始，一格都不能错位 —— 错一格的后果是跳到别的函数上。
 *
 * 生命周期：**扫描完不 FreeLibrary**。JUCE 插件会起线程，卸载一个还有活线程的模块就是崩溃；
 * 宿主本来也要在插件在用的整段时间里持着它。模块表见 ka_vst3_mods。
 * ──────────────────────────────────────────────────────────────────────────────────────────── */
#ifndef KA_VST3_H
#define KA_VST3_H

/* ── 基本类型与结果码 ─────────────────────────────────────────────────────────────────────── */

typedef int32_t ka_tresult;
#define KA_OK 0
#define KA_ERR 1                 /* kResultFalse */
typedef uint8_t ka_tbool;
#define KA_TRUE_ 1
#define KA_FALSE_ 0

#define KA_VST3_MAX_CLASS 64
#define KA_VST3_MAX_MOD   16
#define KA_VST3_PATH_MAX  320
#define KA_VST3_DBG_MAX   512

/* 媒体类型 / 总线方向 / 总线类型 */
#define KA_MEDIA_AUDIO  0
#define KA_MEDIA_EVENT  1
#define KA_DIR_INPUT    0
#define KA_DIR_OUTPUT   1
#define KA_BUS_MAIN     0
#define KA_BUS_AUX      1

/* 处理模式与样本精度 */
#define KA_MODE_REALTIME 0
#define KA_MODE_PREFETCH 1
#define KA_MODE_OFFLINE  2
#define KA_SAMPLE32      0
#define KA_SAMPLE64      1

/* 参数变更队列里的"某一点" */
typedef uint16_t ka_tchar;
typedef ka_tchar ka_string128[128];

/* ── IID（字节布局已由二进制校验，见文件头） ────────────────────────────────────────────────
 * 注释里给的是 SDK 头文件里的四个 uint32，便于回头核对；数组是按 INLINE_UID 展开的真字节。 */

static const char KA_IID_FUNKNOWN[16] =
    { 0,0,0,0, 0,0,0,0, (char)0xC0,0,0,0, 0,0,0,0x46 };                 /* 0,0,0xC0000000,0x46 */
static const char KA_IID_IPLUGINBASE[16] =
    { (char)0xDB,(char)0x8D,(char)0x88,0x22, 0x6E,0x15,(char)0xAE,0x45,
      (char)0x83,0x58,(char)0xB3,0x48, 0x08,0x19,0x06,0x25 };
/* E831FF31-F2D5-4301-928E-BBEE25697802：GUID 文本的前三段在小端机上按小端落字节，
 * 第一版把 F2D5/4301 拆成了 43F2/01D5 —— 本机能开的那批插件是靠 FUnknown 兜底才没露馅，
 * HALion 的工厂直接回 E_NOINTERFACE，兜出来的对象报 0 条输出总线。 */
static const char KA_IID_ICOMPONENT[16] =
    { 0x31,(char)0xFF,0x31,(char)0xE8, (char)0xD5,(char)0xF2,0x01,0x43,
      (char)0x92,(char)0x8E,(char)0xBB,(char)0xEE, 0x25,0x69,0x78,0x02 };
static const char KA_IID_IAUDIOPROCESSOR[16] =
    { (char)0x99,0x3F,0x04,0x42, (char)0xDA,(char)0xB7,0x3C,0x45,
      (char)0xA5,0x69,(char)0xE7,(char)0x9D, (char)0x9A,(char)0xAE,(char)0xC3,0x3D };
static const char KA_IID_IEDITCONTROLLER[16] =
    { (char)0xE3,(char)0xBB,(char)0xD7,(char)0xDC, 0x42,0x77,(char)0x8D,0x44,
      (char)0xA8,0x74,(char)0xAA,(char)0xCC, (char)0x97,(char)0x9C,0x75,(char)0x9E };
static const char KA_IID_IHOSTAPPLICATION[16] =
    { (char)0xCC,(char)0x95,(char)0xE5,0x58, 0x2D,(char)0xDB,0x69,0x49,
      (char)0x8B,0x6A,(char)0xAF,(char)0x8C, 0x36,(char)0xA6,0x64,(char)0xE5 };
/* IComponentHandler：DECLARE 是 (0x93A0BEA3, 0x0BD045DB, 0x8E890B0C, 0xC1E46AC6)。
 * 以前按 GUID 文本 45DB-4BD0 拆段，字节 4..7 是错的 —— 插件按自己的那份比较时就 QI 不到。 */
static const char KA_IID_ICOMPONENTHANDLER[16] =
    { (char)0xA3,(char)0xBE,(char)0xA0,(char)0x93, (char)0xD0,0x0B,(char)0xDB,0x45,
      (char)0x8E,(char)0x89,0x0B,0x0C, (char)0xC1,(char)0xE4,(char)0x6A,(char)0xC6 };
static const char KA_IID_IPLUGINFACTORY[16] =
    { 0x1C,(char)0x81,0x4D,0x7A, 0x11,0x52,0x1F,0x4A,
      (char)0xAE,(char)0xD9,(char)0xD2,(char)0xEE, 0x0B,0x43,(char)0xBF,(char)0x9F };
/* IPluginFactory3 4555A828-A37B-439C-B30A-2DD9EE3BD99D：在 createInstance 之前把
 * IHostApplication 交给工厂（Cubase 就是这么做的）。HALion 的控制器在 initialize 里
 * 解引用"宿主上下文"这个静态格，没设过就是空指针。 */
static const char KA_IID_IPLUGINFACTORY3[16] =
    { 0x28,(char)0xA8,0x55,0x45, 0x7B,(char)0xA3,(char)0x9C,0x43,
      (char)0xB3,0x0A,0x2D,(char)0xD9, (char)0xEE,0x3B,(char)0xD9,(char)0x9D };
/* IConnectionPoint 70A4156F-6E6E-4026-9891-48BFAA60D8D1 */
static const char KA_IID_ICONNECTIONPOINT[16] =
    { 0x6F,0x15,(char)0xA4,0x70, 0x6E,0x6E,0x26,0x40,
      (char)0x98,(char)0x91,0x48,(char)0xBF, (char)0xAA,0x60,(char)0xD8,(char)0xD1 };
/* IUnitInfo 3D4BD6B5-913A-4FD2-A886-E768A5EB92C1（程序列表挂在这个接口上）。 */
static const char KA_IID_IUNITINFO[16] =
    { (char)0xB5,(char)0xD6,0x4B,0x3D, 0x3A,(char)0x91,(char)0xD2,0x4F,
      (char)0xA8,(char)0x86,(char)0xE7,0x68, (char)0xA5,(char)0xEB,(char)0x92,(char)0xC1 };
/* IUnitHandler 4B5147F8-4654-486B-8DAB-30BA163A3C56；IUnitHandler2 F89F8CDF-699E-4BA5-96AA-C9A481452B01 */
static const char KA_IID_IUNITHANDLER[16] =
    { (char)0xF8,0x47,0x51,0x4B, 0x54,0x46,0x6B,0x48,
      (char)0x8D,(char)0xAB,0x30,(char)0xBA, 0x16,0x3A,0x3C,0x56 };
static const char KA_IID_IUNITHANDLER2[16] =
    { (char)0xDF,(char)0x8C,(char)0x9F,(char)0xF8, (char)0x9E,0x69,(char)0xA5,0x4B,
      (char)0x96,(char)0xAA,(char)0xC9,(char)0xA4, (char)0x81,0x45,0x2B,0x01 };
/* IMessage 936F033B-C6C0-47DB-BB08-82F813C1E613 */
static const char KA_IID_IMESSAGE[16] =
    { 0x3B,0x03,0x6F,(char)0x93, (char)0xC0,(char)0xC6,(char)0xDB,0x47,
      (char)0xBB,0x08,(char)0x82,(char)0xF8, 0x13,(char)0xC1,(char)0xE6,0x13 };
/* IAttributeList 1E5F0AEB-CC7F-4533-A254-401138AD5EE4 */
static const char KA_IID_IATTRIBUTELIST[16] =
    { (char)0xEB,0x0A,0x5F,0x1E, 0x7F,(char)0xCC,0x33,0x45,
      (char)0xA2,0x54,0x40,0x11, 0x38,(char)0xAD,0x5E,(char)0xE4 };
/* IParameterChanges：DECLARE (0xA4779663, 0x0BB64A56, 0xB44384A8, 0x466FEB9D)。
 * 字节 4..5 曾按 GUID 文本写成 07 0B，应为 B6 0B。 */
static const char KA_IID_IPARAMETERCHANGES[16] =
    { 0x63,(char)0x96,0x77,(char)0xA4, (char)0xB6,0x0B,0x56,0x4A,
      (char)0xB4,0x43,(char)0x84,(char)0xA8, 0x46,0x6F,(char)0xEB,(char)0x9D };
static const char KA_IID_IPARAMVALUEQUEUE[16] =
    { 0x18,0x3A,0x26,0x01, 0x07,(char)0xED,0x6F,0x4F,
      (char)0x98,(char)0xC9,(char)0xD3,0x56, 0x46,(char)0x86,(char)0xF9,(char)0xBA };
/* IBStream C3B5020A-8957-4E90-A4FC-1D13B7F1F4EF：.vstpreset 的状态块就是交给它读的。
 * 我们自己实现这一头（插件在 setState 里只调 read/seek/tell）。 */
static const char KA_IID_IBSTREAM[16] =
    { 0x0A,0x02,(char)0xB5,(char)0xC3, 0x57,(char)0x89,(char)0x90,0x4E,
      (char)0xA4,(char)0xFC,0x1D,0x13, (char)0xB7,(char)0xF1,(char)0xF4,(char)0xEF };
/* IPlugView 5BC32507-D060-49EA-A615-1B522B755B29；IPlugFrame 367FAF01-AFA9-4693-8D4D-A2A0ED0882A3
 * （照 temporary/vst3ref/gui_iplugview.h 的 DECLARE_CLASS_IID 展开）。 */
static const char KA_IID_IPLUGVIEW[16] =
    { 0x07,0x25,(char)0xC3,0x5B, (char)0xEA,0x49,0x60,(char)0xD0,
      (char)0xA6,0x15,0x1B,0x52, 0x2B,0x75,0x5B,0x29 };
static const char KA_IID_IPLUGFRAME[16] =
    { 0x01,(char)0xAF,0x7F,0x36, (char)0x93,0x46,(char)0xA9,(char)0xAF,
      (char)0x8D,0x4D,(char)0xA2,(char)0xA0, (char)0xED,0x08,(char)0x82,(char)0xA3 };

static int ka_iid_is(const char* a, const char* b) {
    int i;
    for (i = 0; i < 16; ++i) if (a[i] != b[i]) return 0;
    return 1;
}

/* ── 结构体（字段顺序照 SDK，宽度/对齐让编译器自己排，与 C++ 那边一致） ────────────────────── */

typedef struct ka_factory_info {
    char vendor[64];                       /* kNameSize  */
    char url[256];                         /* kURLSize   */
    char email[128];                       /* kEmailSize */
    int32_t flags;
} ka_factory_info;

typedef struct ka_class_info {
    char cid[16];
    int32_t cardinality;

    char category[32];
    char name[64];
} ka_class_info;

typedef struct ka_bus_info {
    int32_t mediaType;
    int32_t direction;
    int32_t channelCount;
    ka_string128 name;
    int32_t busType;
    uint32_t flags;
} ka_bus_info;

typedef struct ka_routing_info {
    int32_t mediaType;
    int32_t busIndex;
    int32_t channel;
} ka_routing_info;

typedef uint64_t ka_speaker_arrangement;

typedef struct ka_process_setup {
    int32_t processMode;
    int32_t symbolicSampleSize;
    int32_t maxSamplesPerBlock;
    double sampleRate;
} ka_process_setup;

typedef struct ka_audio_bus_buffers {
    int32_t numChannels;
    uint64_t silenceFlags;
    union {
        float** channelBuffers32;
        double** channelBuffers64;
    } u;
} ka_audio_bus_buffers;

typedef struct ka_chord {
    uint8_t keyNote;
    uint8_t rootNote;
    int16_t chordMask;
} ka_chord;

typedef struct ka_frame_rate {
    uint32_t framesPerSecond;
    uint32_t flags;
} ka_frame_rate;

typedef struct ka_process_context {
    uint32_t state;
    double sampleRate;
    int64_t projectTimeSamples;
    int64_t systemTime;
    int64_t continousTimeSamples;
    double projectTimeMusic;
    double barPositionMusic;
    double cycleStartMusic;
    double cycleEndMusic;
    double tempo;
    int32_t timeSigNumerator;
    int32_t timeSigDenominator;
    ka_chord chord;
    int32_t smpteOffsetSubframes;
    ka_frame_rate frameRate;
    int32_t samplesToNextClock;
} ka_process_context;

#define KA_CTX_PLAYING        (1 << 1)
#define KA_CTX_TEMPO_VALID    (1 << 10)
#define KA_CTX_TIMESIG_VALID  (1 << 13)
#define KA_CTX_PROJECTTIME_VALID (1 << 9)

typedef struct ka_note_on {
    int16_t channel;
    int16_t pitch;
    float tuning;      /* 1.0 = 1 cent */
    float velocity;    /* 0..1 */
    int32_t length;
    int32_t noteId;
} ka_note_on;

typedef struct ka_note_off {
    int16_t channel;
    int16_t pitch;
    float velocity;
    int32_t noteId;
    float tuning;      /* 注意：noteOff 的 tuning 在最后，与 noteOn 的位置不同 */
} ka_note_off;

typedef struct ka_data_event {
    uint32_t size;
    uint32_t type;
    const uint8_t* bytes;
} ka_data_event;

/* Event：头 20 字节（末两格是 uint16），union 要对齐到 8 所以从 24 开始。
 *
 * **宽度必须和 SDK 一模一样（48 字节）**。插件调 getEvent(index, Event&) 时传进来的是它自己的
 * 那 48 字节，我们往里拷多少字节由 sizeof(ka_event) 决定 —— 拷多了就是直接冲掉插件的栈，
 * 表现是 process 里莫名崩溃。union 里最宽的是 NoteExpressionTextEvent（int32,int32,uint32,指针
 * → 24 字节），不是"一串 TChar 数组"：ChordEvent/ScaleEvent 的 text 是指针，不是内联数组。 */
typedef struct ka_event {
    int32_t busIndex;
    int32_t sampleOffset;
    double ppqPosition;
    uint16_t flags;
    uint16_t type;
    union {
        ka_note_on noteOn;
        ka_note_off noteOff;
        ka_data_event data;
        uint8_t raw[24];
    } u;
} ka_event;

/* 编译期把宽度钉住：以后谁往 union 里加成员，这一行会先红，而不是等到跑插件时崩。 */
typedef char ka_event_size_check[(sizeof(ka_event) == 48) ? 1 : -1];

#define KA_EV_NOTEON  0
#define KA_EV_NOTEOFF 1
#define KA_EV_DATA    2

/* ProcessData：五个 int32 之后要补 4 字节才轮到指针（x64 对齐 8），编译器自己会补；
 * 这里照 SDK 的字段顺序写，别手动插 padding。 */
typedef struct ka_process_data {
    int32_t processMode;
    int32_t symbolicSampleSize;
    int32_t numSamples;
    int32_t numInputs;
    int32_t numOutputs;
    ka_audio_bus_buffers* inputs;
    ka_audio_bus_buffers* outputs;
    void* inputParameterChanges;
    void* outputParameterChanges;
    void* inputEvents;
    void* outputEvents;
    ka_process_context* processContext;
} ka_process_data;

/* ── vtable（顺序照 SDK 头文件，一格不错位） ──────────────────────────────────────────────── */

typedef struct ka_factory_vtbl {
    ka_tresult (*queryInterface)(void* self, const char* iid, void** obj);
    uint32_t   (*addRef)(void* self);
    uint32_t   (*release)(void* self);
    ka_tresult (*getFactoryInfo)(void* self, ka_factory_info* info);
    int32_t    (*countClasses)(void* self);
    ka_tresult (*getClassInfo)(void* self, int32_t index, ka_class_info* info);
    ka_tresult (*createInstance)(void* self, const char* cid, const char* iid, void** obj);
} ka_factory_vtbl;

typedef struct ka_component_vtbl {
    ka_tresult (*queryInterface)(void* self, const char* iid, void** obj);
    uint32_t   (*addRef)(void* self);
    uint32_t   (*release)(void* self);
    ka_tresult (*initialize)(void* self, void* context);
    ka_tresult (*terminate)(void* self);
    ka_tresult (*getControllerClassId)(void* self, char* cid);
    ka_tresult (*setIoMode)(void* self, int32_t mode);
    int32_t    (*getBusCount)(void* self, int32_t type, int32_t dir);
    ka_tresult (*getBusInfo)(void* self, int32_t type, int32_t dir, int32_t index, ka_bus_info* bus);
    ka_tresult (*getRoutingInfo)(void* self, ka_routing_info* in, ka_routing_info* out);
    ka_tresult (*activateBus)(void* self, int32_t type, int32_t dir, int32_t index, ka_tbool state);
    ka_tresult (*setActive)(void* self, ka_tbool state);
    ka_tresult (*setState)(void* self, void* stream);
    ka_tresult (*getState)(void* self, void* stream);
} ka_component_vtbl;

typedef struct ka_processor_vtbl {
    ka_tresult (*queryInterface)(void* self, const char* iid, void** obj);
    uint32_t   (*addRef)(void* self);
    uint32_t   (*release)(void* self);
    ka_tresult (*setBusArrangements)(void* self, ka_speaker_arrangement* ins, int32_t numIns,
                                     ka_speaker_arrangement* outs, int32_t numOuts);
    ka_tresult (*getBusArrangement)(void* self, int32_t dir, int32_t index,
                                    ka_speaker_arrangement* arr);
    ka_tresult (*canProcessSampleSize)(void* self, int32_t size);
    uint32_t   (*getLatencySamples)(void* self);
    ka_tresult (*setupProcessing)(void* self, ka_process_setup* setup);
    ka_tresult (*setProcessing)(void* self, ka_tbool state);
    ka_tresult (*process)(void* self, ka_process_data* data);
    uint32_t   (*getTailSamples)(void* self);
} ka_processor_vtbl;

/* SDK 的 ParameterInfo：id → 三个 String128 → stepCount → double 默认值 → unitId → flags。 */
typedef struct ka_param_info {
    uint32_t id;
    ka_string128 title;
    ka_string128 short_title;
    ka_string128 units;
    int32_t step_count;
    double default_normalized;
    int32_t unit_id;
    int32_t flags;
} ka_param_info;

#define KA_PARAM_IS_PGM_CHANGE  (1 << 15)
#define KA_PARAM_IS_LIST        (1 << 3)
#define KA_PARAM_CAN_AUTOMATE   (1 << 0)

typedef struct ka_unit_info {
    int32_t id;
    int32_t parent_id;
    ka_string128 name;
    int32_t program_list_id;
} ka_unit_info;

typedef struct ka_proglist_info {
    int32_t id;
    ka_string128 name;
    int32_t program_count;
} ka_proglist_info;

typedef struct ka_controller_vtbl {
    ka_tresult (*queryInterface)(void* self, const char* iid, void** obj);
    uint32_t   (*addRef)(void* self);
    uint32_t   (*release)(void* self);
    ka_tresult (*initialize)(void* self, void* context);
    ka_tresult (*terminate)(void* self);
    ka_tresult (*setComponentState)(void* self, void* stream);
    ka_tresult (*setState)(void* self, void* stream);
    ka_tresult (*getState)(void* self, void* stream);
    int32_t    (*getParameterCount)(void* self);
    ka_tresult (*getParameterInfo)(void* self, int32_t index, ka_param_info* info);
    ka_tresult (*getParamStringByValue)(void* self, uint32_t id, double value, ka_string128 str);
    ka_tresult (*getParamValueByString)(void* self, uint32_t id, ka_tchar* str, double* value);
    double     (*normalizedParamToPlain)(void* self, uint32_t id, double value);
    double     (*plainParamToNormalized)(void* self, uint32_t id, double value);
    double     (*getParamNormalized)(void* self, uint32_t id);
    ka_tresult (*setParamNormalized)(void* self, uint32_t id, double value);
    ka_tresult (*setComponentHandler)(void* self, void* handler);
    void*      (*createView)(void* self, const char* name);
} ka_controller_vtbl;

typedef struct ka_unitinfo_vtbl {
    ka_tresult (*queryInterface)(void* self, const char* iid, void** obj);
    uint32_t   (*addRef)(void* self);
    uint32_t   (*release)(void* self);
    int32_t    (*getUnitCount)(void* self);
    ka_tresult (*getUnitInfo)(void* self, int32_t index, ka_unit_info* info);
    int32_t    (*getProgramListCount)(void* self);
    ka_tresult (*getProgramListInfo)(void* self, int32_t index, ka_proglist_info* info);
    ka_tresult (*getProgramName)(void* self, int32_t list_id, int32_t index, ka_string128 name);
    ka_tresult (*getProgramInfo)(void* self, int32_t list_id, int32_t index, const char* attr, ka_string128 val);
    ka_tresult (*hasProgramPitchNames)(void* self, int32_t list_id, int32_t index);
    ka_tresult (*getProgramPitchName)(void* self, int32_t list_id, int32_t index, int16_t pitch, ka_string128 name);
    int32_t    (*getSelectedUnit)(void* self);
    ka_tresult (*selectUnit)(void* self, int32_t unit_id);
    ka_tresult (*getUnitByBus)(void* self, int32_t type, int32_t dir, int32_t bus, int32_t ch, int32_t* unit_id);
    ka_tresult (*setUnitProgramData)(void* self, int32_t list_or_unit, int32_t index, void* data);
} ka_unitinfo_vtbl;

/* 插件自己实现的 IConnectionPoint（SDK 的 ComponentBase 有）：宿主代理把它和对侧接起来。 */
typedef struct ka_connpoint_vtbl {
    ka_tresult (*queryInterface)(void* self, const char* iid, void** obj);
    uint32_t   (*addRef)(void* self);
    uint32_t   (*release)(void* self);
    ka_tresult (*connect)(void* self, void* other);
    ka_tresult (*disconnect)(void* self, void* other);
    ka_tresult (*notify)(void* self, void* message);
} ka_connpoint_vtbl;

/* 宿主侧代理（照 SDK ConnectionProxy）：src = 本侧插件的 CP，dst = 对侧代理。 */
typedef struct ka_conn_proxy {
    const void** vtbl;
    int32_t refs;
    void* src;
    void* dst;
} ka_conn_proxy;

/* 宿主侧 IComponentHandler + IUnitHandler + IUnitHandler2（三个接口是前缀关系，共用一张表）。 */
typedef struct ka_chandler_vtbl {
    ka_tresult (*queryInterface)(void* self, const char* iid, void** obj);
    uint32_t   (*addRef)(void* self);
    uint32_t   (*release)(void* self);
    ka_tresult (*beginEdit)(void* self, uint32_t id);
    ka_tresult (*performEdit)(void* self, uint32_t id, double value);
    ka_tresult (*endEdit)(void* self, uint32_t id);
    ka_tresult (*restartComponent)(void* self, int32_t flags);
    ka_tresult (*notifyUnitSelection)(void* self, int32_t unit_id);
    ka_tresult (*notifyProgramListChange)(void* self, int32_t list_id, int32_t index);
    ka_tresult (*notifyUnitByBusChange)(void* self);
} ka_chandler_vtbl;

typedef struct ka_chandler {
    const void** vtbl;
    int32_t refs;
    int32_t restarts;      /* 插件要求宿主重启过几次（排障用） */
    int32_t restart_flags; /* 最后一次的旗标：kParamValuesChanged 就说明程序换过了 */
} ka_chandler;

/* 宿主侧参数变更队列（ProcessData::inputParameterChanges）。 */
typedef struct ka_pvq {
    const void** vtbl;
    int32_t refs;
    uint32_t id;
    int32_t count;
    int32_t off[2];
    double val[2];
} ka_pvq;

#define KA_V3_MAX_PCHG 32

typedef struct ka_pchanges {
    const void** vtbl;
    int32_t refs;
    int32_t count;
    ka_pvq q[KA_V3_MAX_PCHG];
} ka_pchanges;

/* 宿主侧对象（我们自己实现的那一头）：vtable 指针放第一格，跟 COM 一致。 */
typedef struct ka_host_app {
    const void** vtbl;
    int32_t refs;
} ka_host_app;

typedef struct ka_event_list {
    const void** vtbl;
    int32_t refs;
    int32_t count;
    ka_event* items;
} ka_event_list;

/* ── vtable 取值：obj 的第 0 个机器字是 vtable 指针 ─────────────────────────────────────────── */

#define KA_VT(obj, T)  (*(const T**)(obj))

/* ── 模块表：扫过的插件保持加载（见文件头） ───────────────────────────────────────────────── */

typedef struct ka_vst3_mod {
    void* handle;                        /* HMODULE */
    uint16_t path[KA_VST3_PATH_MAX];
    void* factory;                       /* IPluginFactory* */
} ka_vst3_mod;

static ka_vst3_mod g_v3_mods[KA_VST3_MAX_MOD];
static int32_t g_v3_nmod = 0;

static ka_factory_info g_v3_fi;
static ka_class_info g_v3_cls[KA_VST3_MAX_CLASS];
static int32_t g_v3_ncls = 0;
static char g_v3_dbg[KA_VST3_DBG_MAX];
static int32_t g_v3_err = 0;
static int32_t g_v3_ev_counted = 0;  /* 插件问过几次"有几条事件" */
static int32_t g_v3_ev_pulled = 0;   /* 插件实际取走几条事件 */

/* 十六进制转储，只写调用方的缓冲：/O2 下"先写本地数组再拷出去"的辅助函数会被优化坏
 * （ka_sfz.h 的 sfz_join 就是这么出的问题），所以这里一律直接写 out。 */
static void ka_v3_hex(char* out, const char* bytes, int n) {
    static const char* HEX = "0123456789ABCDEF";
    int i;
    for (i = 0; i < n; ++i) {
        unsigned char b = (unsigned char)bytes[i];
        out[i * 2] = HEX[b >> 4];
        out[i * 2 + 1] = HEX[b & 15];
    }
    out[n * 2] = 0;
}

static void ka_v3_str(char* out, const char* src, int cap) {
    int i = 0;
    if (cap <= 0) return;
    while (src[i] && i < cap - 1) { out[i] = src[i]; ++i; }
    out[i] = 0;
}

/* UTF-16（插件的 String128）→ UTF-8，给排障文本用。 */
static void ka_v3_utf8(const uint16_t* src, char* out, int cap) {
    int i = 0, o = 0;
    if (cap <= 0) return;
    while (src && src[i] && o < cap - 1) {
        uint32_t cp = src[i++];
        if (cp >= 0xD800 && cp <= 0xDBFF && src[i] >= 0xDC00 && src[i] <= 0xDFFF) {
            cp = 0x10000 + ((cp - 0xD800) << 10) + (src[i++] - 0xDC00);
        }
        if (cp < 0x80) out[o++] = (char)cp;
        else if (cp < 0x800 && o < cap - 2) {
            out[o++] = (char)(0xC0 | (cp >> 6));
            out[o++] = (char)(0x80 | (cp & 0x3F));
        } else if (cp < 0x10000 && o < cap - 3) {
            out[o++] = (char)(0xE0 | (cp >> 12));
            out[o++] = (char)(0x80 | ((cp >> 6) & 0x3F));
            out[o++] = (char)(0x80 | (cp & 0x3F));
        } else if (o < cap - 4) {
            out[o++] = (char)(0xF0 | (cp >> 18));
            out[o++] = (char)(0x80 | ((cp >> 12) & 0x3F));
            out[o++] = (char)(0x80 | ((cp >> 6) & 0x3F));
            out[o++] = (char)(0x80 | (cp & 0x3F));
        } else break;
    }
    out[o] = 0;
}

/* UTF-8 → UTF-16，只给 LoadLibraryW 用（.vst3 路径可能在中文目录下）。 */
static void ka_v3_wide(const char* s, uint16_t* out, int cap) {
    int i = 0, o = 0;
    while (s[i] && o < cap - 1) {
        unsigned char c = (unsigned char)s[i];
        uint32_t cp;
        if (c < 0x80) { cp = c; i += 1; }
        else if ((c & 0xE0) == 0xC0 && s[i + 1]) {
            cp = ((uint32_t)(c & 0x1F) << 6) | ((unsigned char)s[i + 1] & 0x3F); i += 2;
        } else if ((c & 0xF0) == 0xE0 && s[i + 1] && s[i + 2]) {
            cp = ((uint32_t)(c & 0x0F) << 12) | (((unsigned char)s[i + 1] & 0x3F) << 6)
               | ((unsigned char)s[i + 2] & 0x3F); i += 3;
        } else if ((c & 0xF8) == 0xF0 && s[i + 1] && s[i + 2] && s[i + 3]) {
            cp = ((uint32_t)(c & 0x07) << 18) | (((unsigned char)s[i + 1] & 0x3F) << 12)
               | (((unsigned char)s[i + 2] & 0x3F) << 6) | ((unsigned char)s[i + 3] & 0x3F); i += 4;
        } else { cp = '?'; i += 1; }
        if (cp < 0x10000) {
            out[o++] = (uint16_t)cp;
        } else {
            cp -= 0x10000;
            out[o++] = (uint16_t)(0xD800 + (cp >> 10));
            if (o < cap - 1) out[o++] = (uint16_t)(0xDC00 + (cp & 0x3FF));
        }
    }
    out[o] = 0;
}

/* ── 加载一个 .vst3 ─────────────────────────────────────────────────────────────────────────
 *
 * 两种形态都要认：扁平文件（本机 24 个 Ample Sound 插件都是这种，文件本身就是 DLL）和
 * 目录型 bundle（`X.vst3\Contents\x86_64-win\X.vst3`）。先按原样试，失败再拼 bundle 路径 ——
 * 这样不用引入 GetFileAttributesW，也就少一个导入。
 * ──────────────────────────────────────────────────────────────────────────────────────────── */
static void* ka_v3_load(const uint16_t* path) {
    static const uint16_t mid[] = {
        '\\','C','o','n','t','e','n','t','s','\\','x','8','6','_','6','4','-','w','i','n','\\',0
    };
    uint16_t alt[KA_VST3_PATH_MAX * 2];
    void* h;
    int i, o = 0, beg = 0;

    h = LoadLibraryW(path);
    if (h) return h;

    i = 0;
    while (path[i] && o < KA_VST3_PATH_MAX - 1) {
        alt[o++] = path[i];
        if (path[i] == '\\' || path[i] == '/') beg = o;
        ++i;
    }
    if (beg <= 0 || beg >= o) return 0;         /* 没有文件名 → 不是 bundle 形态 */
    for (i = 0; mid[i] && o < KA_VST3_PATH_MAX * 2 - 8; ++i) alt[o++] = mid[i];
    for (i = beg; path[i] && o < KA_VST3_PATH_MAX * 2 - 8; ++i) alt[o++] = path[i];
    /* 内层文件名**通常就跟 bundle 同名**（HALion 7.vst3\Content...\HALion 7.vst3），
     * 所以这里不能无条件补后缀 —— 补了就是 `HALion 7.vst3.vst3`，加载失败且错误码只说 -2。 */
    if (!(o >= 5 && (alt[o - 5] == '.')
          && (alt[o - 4] | 0x20) == 'v' && (alt[o - 3] | 0x20) == 's'
          && (alt[o - 2] | 0x20) == 't' && alt[o - 1] == '3')) {
        alt[o++] = '.'; alt[o++] = 'v'; alt[o++] = 's'; alt[o++] = 't'; alt[o++] = '3';
    }
    alt[o] = 0;
    h = LoadLibraryW(alt);
    if (!h && g_v3_err == 0) {
        /* 卡在 bundle 这一支时把拼出来的路径留下来 —— 猜错了路径光看错误码看不出来。 */
        int k;
        for (k = 0; alt[k] && k < KA_VST3_DBG_MAX - 1; ++k) g_v3_dbg[k] = (char)alt[k];
        g_v3_dbg[k] = 0;
    }
    return h;
}

/* ── 扫描：列出一个 .vst3 的 factory 与类清单 ─────────────────────────────────────────────────
 *
 * **一次一个文件**，结果覆盖在 g_v3_cls 里（上层要列整个目录就在外面循环）。
 * 扫完就 FreeLibrary：元数据查询不会留下活线程，而把 25 个三四十兆的插件全常驻是浪费。
 * 真正要出声时走 ka_vst3_open，那一次才把模块留住。
 * ──────────────────────────────────────────────────────────────────────────────────────────── */
static int32_t ka_v3_scan(const uint16_t* path) {
    const ka_factory_vtbl* vt;
    void* (*getfac)(void);
    void* h, *fac;
    int32_t n, i;

    g_v3_ncls = 0;
    g_v3_err = 0;
    g_v3_dbg[0] = 0;
    if (!path) { g_v3_err = -1; return -1; }

    h = ka_v3_load(path);
    if (!h) { g_v3_err = -2; return -2; }

    getfac = (void* (*)(void))GetProcAddress(h, "GetPluginFactory");
    if (!getfac) { g_v3_err = -3; FreeLibrary(h); return -3; }

    fac = getfac();
    if (!fac) { g_v3_err = -4; FreeLibrary(h); return -4; }

    vt = KA_VT(fac, ka_factory_vtbl);
    vt->getFactoryInfo(fac, &g_v3_fi);
    g_v3_fi.vendor[63] = 0;
    g_v3_fi.url[255] = 0;
    g_v3_fi.email[127] = 0;

    n = vt->countClasses(fac);
    for (i = 0; i < n && g_v3_ncls < KA_VST3_MAX_CLASS; ++i) {
        ka_class_info* ci = g_v3_cls + g_v3_ncls;
        if (vt->getClassInfo(fac, i, ci) == KA_OK) {
            ci->category[31] = 0;
            ci->name[63] = 0;
            ++g_v3_ncls;
        }
    }
    g_v3_err = (n < 0) ? -5 : 0;                /* -5：countClasses 给了负数 */
    FreeLibrary(h);
    return g_v3_ncls;
}

/* ══ 第二层：实例化 + 出声 ══════════════════════════════════════════════════════════════════
 *
 * 宿主侧要自己实现两个对象，插件才会干活：
 *   · IHostApplication —— initialize() 的 context，插件拿它问名字、造 IMessage；
 *   · IEventList       —— 我们把 MIDI 事件塞给它，插件在 process() 里读。
 *
 * 调用链（照 SDK 头文件里各步的前后依赖，顺序不能改）：
 *   createInstance → initialize(host) → [QI IAudioProcessor] → setBusArrangements(立体声)
 *   → getBusInfo（拿真实声道数）→ setupProcessing → setActive(true) → setProcessing(true)
 *   → 每块 process()  … 收尾 → setProcessing(false) → setActive(false) → terminate → release
 *
 * 和 sample 那套不同：插件**自己算声音**，我们不喂样本；我们只给缓冲、给时钟、给事件。
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

#define KA_NO_INTERFACE (-1)
#define KA_V3_MAX_BLOCK 1024
#define KA_V3_MAX_EVENTS 256
#define KA_V3_MAX_CH 8
#define KA_V3_OPEN_NO_CTRL 1   /* 打开时不建控制器：插件的控制器 initialize 会 AV 时（HALion），
                                * 组件本身还能用，只是选不了程序（要选程序走 setState）。 */
#define KA_V3_OPEN_CTRL_NOHOST 2 /* 排障用：控制器 initialize 传 NULL 宿主。 */
#define KA_V3_OPEN_HANDLER_FIRST 4 /* 排障用：先 setComponentHandler 再 initialize。 */

/* 进度戳：卡在插件里时宿主等不到回执，唯一还能读到的是共享内存。worker 把"走到第几步"
 * 写进 iv[15]（每条命令开头会被清掉），宿主用 ka_v3_trace 取 —— 挂在里面时这才说得清
 * 是哪一步，而不是只报一个"没答应"。 */
#ifdef KA_SHM_H
static ka_shm* g_v3_shm = 0;
/* ka_v3_tls_probe 记下的本模块 TLS 槽与块大小，VEH 里要用（崩的那一刻现场已经没了）。 */
static uint32_t g_v3_tls_idx = 0xFFFFFFFFu;
static uint32_t g_v3_tls_sz = 0;
/* 控制器建到哪一步失败了（CMD_CTRL 把它一并回给宿主，比进度戳长寿）。 */
static int32_t g_v3_ctrl_step = 0;
static void ka_v3_trace(int32_t v) { if (g_v3_shm) g_v3_shm->iv[KA_SHM_IV - 1] = v; }
static void ka_v3_trace2(int32_t v) { if (g_v3_shm) g_v3_shm->iv[KA_SHM_IV - 2] = v; }
/* 建编辑器走到哪一步。iv[9] 不在崩溃现场那七格里，超时之后还能读（out[1] of ka_vst3_fault）。 */
static void ka_v3_stage(int32_t v) { if (g_v3_shm) g_v3_shm->iv[9] = v; }
/* 插件模块基址的低/高 32 位 —— AV 之后拿故障地址减它就知道炸在插件的第几个字节。 */
static void ka_v3_trace_mod(void* h) {
    uint64_t v = (uint64_t)h;
    if (!g_v3_shm) return;
    g_v3_shm->iv[10] = (int32_t)(uint32_t)(v & 0xFFFFFFFFu);
    g_v3_shm->iv[11] = (int32_t)(uint32_t)(v >> 32);
}
/* 插件向宿主讨对象（QI / createInstance）时，把 IID 直接追加进共享内存的 text。
 * text 是宿主唯一能在 worker 已经崩掉之后还读得到的东西 —— 插件在 initialize 里
 * 拿不到宿主对象就解引用空指针时，这一串就是最后一句话。 */
static void ka_v3_hostnote(char tag, const char* iid) {
    static const char* HEX = "0123456789ABCDEF";
    int o = 0, i;
    if (!g_v3_shm || !iid) return;
    while (g_v3_shm->text[o] && o < KA_SHM_TEXT - 40) ++o;
    if (o) g_v3_shm->text[o++] = ' ';
    g_v3_shm->text[o++] = tag;
    g_v3_shm->text[o++] = ':';
    for (i = 0; i < 16 && o < KA_SHM_TEXT - 2; ++i) {
        unsigned char b = (unsigned char)iid[i];
        g_v3_shm->text[o++] = HEX[b >> 4];
        g_v3_shm->text[o++] = HEX[b & 15];
    }
    g_v3_shm->text[o] = 0;
}
/* 短记号（"f:set" 这类），跟 hostnote 共用一条文本流。 */
static void ka_v3_mark(const char* s) {
    int o = 0;
    if (!g_v3_shm || !s) return;
    while (g_v3_shm->text[o] && o < KA_SHM_TEXT - 24) ++o;
    if (o) g_v3_shm->text[o++] = ' ';
    while (*s && o < KA_SHM_TEXT - 2) g_v3_shm->text[o++] = *s++;
    g_v3_shm->text[o] = 0;
}
/* "tag=XXXXXXXX"：数值记号（TLS 守卫这类只看 32 位）。 */
static void ka_v3_markhex(const char* tag, uint32_t v) {
    static const char* HEX = "0123456789ABCDEF";
    int o = 0, i;
    if (!g_v3_shm || !tag) return;
    while (g_v3_shm->text[o] && o < KA_SHM_TEXT - 24) ++o;
    if (o) g_v3_shm->text[o++] = ' ';
    while (*tag && o < KA_SHM_TEXT - 12) g_v3_shm->text[o++] = *tag++;
    g_v3_shm->text[o++] = '=';
    for (i = 7; i >= 0; --i) g_v3_shm->text[o++] = HEX[(v >> (i * 4)) & 15];
    g_v3_shm->text[o] = 0;
}
#else
static void ka_v3_trace(int32_t v) { (void)v; }
static void ka_v3_trace2(int32_t v) { (void)v; }
static void ka_v3_stage(int32_t v) { (void)v; }
static void ka_v3_trace_mod(void* h) { (void)h; }
static void ka_v3_hostnote(char tag, const char* iid) { (void)tag; (void)iid; }
static void ka_v3_mark(const char* s) { (void)s; }
static void ka_v3_markhex(const char* tag, uint32_t v) { (void)tag; (void)v; }
#endif

/* 读插件的 TLS 目录并看**本线程**那份块：MSVC 的函数内静态量（magic static）用
 * "模板块末尾的 epoch 字" 判初始化，epoch 由 CRT 在每次线程附着时写成 -1。
 * 我们的 worker 没有 CRT；如果这一格还是 0，插件的静态单例会被误判成"已初始化"，
 * 于是返回一个全零对象 —— HALion 的 controller 和 Kontakt 的 createInstance 都炸在
 * 这种空对象上，现象是 access=0 的 AV。 */
#ifdef KA_VST3_TLS_PROBE
/* 直接用 gs:[0x58]（TEB->ThreadLocalStoragePointer）取本线程的模板块 —— 与插件
 * 编译器生成的取法逐字节一致。TlsGetValue 看到的槽和静态 TLS 用的不是同一份，
 * 拿它判断"有没有块"会得出假结论（已在 CRT 进程里用自建 __declspec(thread) DLL 证伪）。 */
static void ka_v3_tls_probe(void* h) {
    unsigned char* m = (unsigned char*)h;
    unsigned char* nt;
    unsigned char* tls;
    uint32_t tls_rva, idx, sz, zf, i;
    uint64_t start, end, idxp, cb;
    void** arr;
    void* blk;
    char tag[8];
    if (!h) return;
    nt = m + *(int32_t*)(m + 0x3C);
    if (*(uint16_t*)(nt + 0x18) != 0x20B) { ka_v3_mark("t:not64"); return; }
    tls_rva = *(uint32_t*)(nt + 0x18 + 0x70 + 9 * 8);
    if (!tls_rva) { ka_v3_mark("t:none"); return; }
    tls = m + tls_rva;
    start = *(uint64_t*)(tls + 0x00);
    end = *(uint64_t*)(tls + 0x08);
    idxp = *(uint64_t*)(tls + 0x10);
    cb = *(uint64_t*)(tls + 0x18);
    zf = *(uint32_t*)(tls + 0x20);
    sz = (uint32_t)(end - start) + zf;
    idx = idxp ? *(uint32_t*)idxp : 0xFFFFFFFFu;
    g_v3_tls_idx = idx;
    g_v3_tls_sz = sz;
    ka_v3_markhex("t:idx", idx);
    ka_v3_markhex("t:sz", sz);
    ka_v3_markhex("t:zf", zf);
    ka_v3_markhex("t:cb", cb ? 1u : 0u);
    arr = (void**)__readgsqword(0x58);
    blk = (arr && idx != 0xFFFFFFFFu) ? arr[idx] : 0;
    ka_v3_markhex("t:blk", blk ? 1u : 0u);
    if (!blk) return;
    /* MSVC 的 magic static 把关卡字放在模板块**末尾**：块尾的 -1 是"本线程还没人初始化"
     * 的记号。所以要看最后 8 个 dword，而不是块首。 */
    for (i = 0; i < 8; ++i) {
        uint32_t off = (sz >= 32) ? (sz - 32 + i * 4) : (i * 4);
        tag[0] = 't'; tag[1] = ':'; tag[2] = 'e'; tag[3] = (char)('0' + i); tag[4] = 0;
        ka_v3_markhex(tag, *(uint32_t*)((unsigned char*)blk + off));
    }
}
#else
static void ka_v3_tls_probe(void* h) { (void)h; }
#endif

static ka_tresult ka_host_qi(void* self, const char* iid, void** obj) {
    (void)self;
    if (g_v3_shm) g_v3_shm->iv[8] = 1;   /* 崩了以后回看：最后一个是宿主哪一格 */
    if (!obj) return KA_NO_INTERFACE;
    *obj = 0;
    /* FUnknown 与 IHostApplication 都返回自己；别的（IMessage 之类）我们不做。
     * 成功与失败都留痕：崩溃前最后问的是哪一件，这是隔着死进程唯一能看到的东西。 */
    if (iid && (ka_iid_is(iid, KA_IID_IHOSTAPPLICATION) || ka_iid_is(iid, KA_IID_FUNKNOWN))) {
        *obj = self;
        ka_v3_hostnote('Q', iid);
        return KA_OK;
    }
    ka_v3_hostnote('q', iid);
    return KA_NO_INTERFACE;
}

static uint32_t ka_host_addref(void* self) {
    ka_host_app* a = (ka_host_app*)self;
    if (g_v3_shm) g_v3_shm->iv[8] = 2;
    return (uint32_t)(++a->refs);
}

static uint32_t ka_host_release(void* self) {
    ka_host_app* a = (ka_host_app*)self;
    if (g_v3_shm) g_v3_shm->iv[8] = 3;
    return (uint32_t)(--a->refs);
}

static ka_tresult ka_host_getname(void* self, ka_tchar* name) {
    static const char* NM = "Kolid Workbench";
    int i;
    (void)self;
    if (g_v3_shm) g_v3_shm->iv[8] = 4;
    if (!name) return KA_ERR;
    for (i = 0; NM[i] && i < 127; ++i) name[i] = (ka_tchar)(unsigned char)NM[i];
    name[i] = 0;
    return KA_OK;
}

/* 插件向宿主 createInstance 要过的东西（IID 十六进制，逗号分隔）。必须在 ka_host_create
 * 之前声明 —— 它就在这里写。 */
static char g_v3_hostreq[256];
static int32_t g_v3_hostreq_n = 0;

static ka_tresult ka_host_create(void* self, const char* cid, const char* iid, void** obj) {
    (void)self; (void)cid;
    if (g_v3_shm) g_v3_shm->iv[8] = 5;
    if (obj) *obj = 0;
    /* 插件向宿主讨东西（IMessage 之类）会走到这里。我们不造，但把 IID 记下来 ——
     * 卡在"控制器建了却不动"时，这一行能直接说出它缺哪一件宿主对象。 */
    if (iid && g_v3_hostreq_n < 5) {
        int i, o = 0;
        static const char* HEX = "0123456789ABCDEF";
        if (g_v3_hostreq_n) g_v3_hostreq[g_v3_hostreq_n * 33 - 1] = ',';
        o = g_v3_hostreq_n * 33;
        for (i = 0; i < 16 && o < 250; ++i) {
            unsigned char b = (unsigned char)iid[i];
            g_v3_hostreq[o++] = HEX[b >> 4];
            g_v3_hostreq[o++] = HEX[b & 15];
        }
        g_v3_hostreq[o] = 0;
        g_v3_hostreq_n++;
    }
    ka_v3_hostnote('c', iid);
    return KA_NO_INTERFACE;
}

static const void* g_host_app_vtbl[5] = {
    (const void*)ka_host_qi, (const void*)ka_host_addref, (const void*)ka_host_release,
    (const void*)ka_host_getname, (const void*)ka_host_create
};
static ka_host_app g_host_app = { g_host_app_vtbl, 1 };

/* createInstance 之前把宿主交给工厂（IPluginFactory3::setHostContext）。Steinberg 的
 * 宿主都这么做；不设的话，HALion 的控制器 initialize 会去解引用那个还没填的静态格
 * （module+0x395e74d，访问地址 0）。工厂不声明 IPluginFactory3（老插件）就跳过。 */
static void ka_v3_factory_sethost(void* fac) {
    const void** vt;
    void* p = 0;
    ka_tresult rc;
    if (!fac) return;
    vt = *(const void***)fac;
    if (!vt || !vt[0]) return;
    rc = ((ka_tresult (*)(void*, const char*, void**))vt[0])(fac, KA_IID_IPLUGINFACTORY3, &p);
    ka_v3_markhex("f:rc", (uint32_t)rc);
    ka_v3_markhex("f:p", p ? 1u : 0u);
    {   void* q = 0;
        ka_tresult r0 = ((ka_tresult (*)(void*, const char*, void**))vt[0])(fac, KA_IID_FUNKNOWN, &q);
        ka_v3_markhex("f:fu", (uint32_t)r0);
        if (r0 == KA_OK && q) ((uint32_t (*)(void*))(*(const void***)q)[2])(q);
    }
    if (rc != KA_OK || !p) { ka_v3_mark("f:no3"); return; }
    ka_v3_mark("f:3");
    /* 前 7 格与 IPluginFactory 相同，setHostContext 是第 9 格。 */
    ((ka_tresult (*)(void*, void*))(*(const void***)p)[9])(p, &g_host_app);
    ka_v3_mark("f:set");
}

/* ── IEventList（我们塞事件给插件的那一头） ────────────────────────────────────────────────── */

static int32_t ka_evl_count(void* self) {
    g_v3_ev_counted++;
    return ((ka_event_list*)self)->count;
}

static ka_tresult ka_evl_get(void* self, int32_t index, ka_event* e) {
    ka_event_list* l = (ka_event_list*)self;
    int i;
    g_v3_ev_pulled++;
    if (!e || index < 0 || index >= l->count) return KA_ERR;
    /* 只拷 sizeof(ka_event)（== SDK 的 48）。多一点都是往插件的栈上写越界。 */
    { const unsigned char* s = (const unsigned char*)(l->items + index);
      unsigned char* d = (unsigned char*)e;
      for (i = 0; i < (int)sizeof(ka_event); ++i) d[i] = s[i]; }
    return KA_OK;
}

static ka_tresult ka_evl_add(void* self, ka_event* e) {
    (void)self; (void)e;
    return KA_ERR;   /* 宿主不接收插件"加事件"的请求 */
}

static const void* g_evl_vtbl[6] = {
    (const void*)ka_host_qi, (const void*)ka_host_addref, (const void*)ka_host_release,
    (const void*)ka_evl_count, (const void*)ka_evl_get, (const void*)ka_evl_add
};

/* ── 一个已打开的插件 ────────────────────────────────────────────────────────────────────── */

typedef struct ka_v3 {
    void* handle;
    void* factory;
    void* comp;
    void* proc;
    char cid[16];                /* 组件的类 ID：initialize 之后还要用它去造 controller */
    ka_tresult alive;
    ka_process_setup setup;

    int32_t n_in_bus;            /* 音频输入总线数（乐器通常是 0） */
    int32_t n_out_bus;
    int32_t n_in_ch;
    int32_t n_out_ch;
    int32_t n_ev_in;             /* 事件输入总线数（乐器 1，效果器 0） */

    ka_audio_bus_buffers* ins;   /* 按总线数分配 */
    ka_audio_bus_buffers* outs;
    float** in_ch_ptr;
    float** out_ch_ptr;
    float* in_mem;               /* n_in_ch * KA_V3_MAX_BLOCK */
    float* out_mem;
    void* in_mem_raw;
    void* out_mem_raw;
    void* bus_raw;

    ka_event_list evq;           /* 待发给插件的这一块事件 */
    ka_event ev_items[KA_V3_MAX_EVENTS];
    int64_t frames_done;
    int32_t peak;                /* 上一块峰值，千分比 */

    void* ctrl;                  /* IEditController（程序列表/参数都挂在它上面；元数据口） */
    void* unitinfo;              /* IUnitInfo（控制器 QI 出来的，程序列表在这上面） */
    void* cp_comp;               /* 组件侧的 IConnectionPoint（插件实现） */
    void* cp_ctrl;               /* 控制器侧的 IConnectionPoint（插件实现） */
    int32_t ctrl_ok;             /* 0 = 没建/失败；1 = 建好了并且已经和对侧连上 */
    int32_t ctrl_rc;             /* 建 controller 时最后一步的原始 tresult */
    int32_t n_params;            /* getParameterCount 的缓存（-1 未取） */
} ka_v3;

static ka_v3 g_v3;
static ka_chandler g_chandler;
static ka_conn_proxy g_cp_comp_proxy;
static ka_conn_proxy g_cp_ctrl_proxy;
static ka_pchanges g_pchanges;
static void* g_v3_arena = 0;     /* VirtualAlloc 的一块，装缓冲与指针表 */
static int32_t g_v3_arena_cap = 0;
static int32_t g_v3_stage = 0;   /* 打开走到第几步（排障用：负返回码只说"哪一类失败"，
                                  * 这里说"哪一步退出"，且带回该步的原始 tresult） */
static int32_t g_v3_last_rc = 0;

static void ka_v3_free_arena(void) {
    if (g_v3_arena) { VirtualFree(g_v3_arena, 0, KA_MEM_RELEASE); g_v3_arena = 0; }
    g_v3_arena_cap = 0;
}

/* 一次性把缓冲、指针表、总线数组都从同一次分配里切出来：没有 malloc，也就不存在泄漏点。 */
static int32_t ka_v3_alloc(int32_t n_in_bus, int32_t n_out_bus,
                           int32_t n_in_ch, int32_t n_out_ch) {
    int64_t need;
    unsigned char* p;

    ka_v3_free_arena();
    need = (int64_t)(n_in_bus + n_out_bus) * (int64_t)sizeof(ka_audio_bus_buffers)
         + (int64_t)(n_in_ch + n_out_ch) * (int64_t)sizeof(float*) * 2
         + (int64_t)(n_in_ch + n_out_ch) * (int64_t)KA_V3_MAX_BLOCK * (int64_t)sizeof(float)
         + 256;
    if (need <= 0) return -1;
    g_v3_arena = VirtualAlloc(0, (uint64_t)need, KA_MEM_COMMIT | KA_MEM_RESERVE, KA_PAGE_READWRITE);
    if (!g_v3_arena) return -1;
    g_v3_arena_cap = (int32_t)need;

    p = (unsigned char*)g_v3_arena;
    g_v3.ins = (n_in_bus > 0) ? (ka_audio_bus_buffers*)p : 0;
    p += (int64_t)n_in_bus * (int64_t)sizeof(ka_audio_bus_buffers);
    g_v3.outs = (n_out_bus > 0) ? (ka_audio_bus_buffers*)p : 0;
    p += (int64_t)n_out_bus * (int64_t)sizeof(ka_audio_bus_buffers);

    g_v3.in_ch_ptr = (float**)p;
    p += (int64_t)n_in_ch * (int64_t)sizeof(float*);
    g_v3.out_ch_ptr = (float**)p;
    p += (int64_t)n_out_ch * (int64_t)sizeof(float*);

    g_v3.in_mem = (n_in_ch > 0) ? (float*)p : 0;
    p += (int64_t)n_in_ch * (int64_t)KA_V3_MAX_BLOCK * (int64_t)sizeof(float);
    g_v3.out_mem = (float*)p;
    p += (int64_t)n_out_ch * (int64_t)KA_V3_MAX_BLOCK * (int64_t)sizeof(float);

    {   int i;
        for (i = 0; i < n_in_ch; ++i) g_v3.in_ch_ptr[i] = g_v3.in_mem + (int64_t)i * KA_V3_MAX_BLOCK;
        for (i = 0; i < n_out_ch; ++i) g_v3.out_ch_ptr[i] = g_v3.out_mem + (int64_t)i * KA_V3_MAX_BLOCK;
        for (i = 0; i < n_in_bus; ++i) {
            /* 乐器没有音频输入，这些总线只按"声明过"的形式存在，声道数 0。 */
            g_v3.ins[i].numChannels = 0;
            g_v3.ins[i].silenceFlags = ~(uint64_t)0;
            g_v3.ins[i].u.channelBuffers32 = g_v3.in_ch_ptr;
        }
        for (i = 0; i < n_out_bus; ++i) {
            g_v3.outs[i].numChannels = (i == 0) ? n_out_ch : 0;
            g_v3.outs[i].silenceFlags = 0;
            g_v3.outs[i].u.channelBuffers32 = g_v3.out_ch_ptr;
        }
    }
    g_v3.bus_raw = g_v3_arena;
    return 0;
}

/* ══ 第三层：控制器 / 连接点 / 参数变更 ═════════════════════════════════════════════════════
 *
 * 多声部乐器（HALion Sonic 这种）"哪个程序在哪个槽"只出现在控制器那头：
 *   · 程序选择是 IEditController 里 flags & kIsProgramChange 的参数，参数属于某个 unit，
 *     unit 又指向一份程序列表（IUnitInfo::getProgramListInfo/getProgramName）；
 *   · 控制器与组件是两个对象，参数从控制器走到处理器要靠 IConnectionPoint 接起来
 *     （SDK 的宿主也这么做，见 ConnectionProxy），外加每块 process 的 inputParameterChanges。
 * 缺了这一段，插件能开、能收音符，但槽是空的 —— 表现就是"打开成功、峰值 0"。
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/* ── IComponentHandler（+ IUnitHandler / IUnitHandler2，三个接口是前缀关系） ─────────────── */

static ka_tresult ka_ch_qi(void* self, const char* iid, void** obj) {
    if (!obj || !iid) { if (obj) *obj = 0; return KA_NO_INTERFACE; }
    *obj = 0;
    if (ka_iid_is(iid, KA_IID_FUNKNOWN) || ka_iid_is(iid, KA_IID_ICOMPONENTHANDLER)
        || ka_iid_is(iid, KA_IID_IUNITHANDLER) || ka_iid_is(iid, KA_IID_IUNITHANDLER2)) {
        *obj = self;
        ((ka_chandler*)self)->refs++;
        return KA_OK;
    }
    return KA_NO_INTERFACE;
}
static uint32_t ka_ch_addref(void* self) { return (uint32_t)(++((ka_chandler*)self)->refs); }
static uint32_t ka_ch_release(void* self) { return (uint32_t)(--((ka_chandler*)self)->refs); }
static ka_tresult ka_ch_begin(void* self, uint32_t id) { (void)self; (void)id; return KA_OK; }
static ka_tresult ka_ch_perform(void* self, uint32_t id, double v) { (void)self; (void)id; (void)v; return KA_OK; }
static ka_tresult ka_ch_end(void* self, uint32_t id) { (void)self; (void)id; return KA_OK; }
static ka_tresult ka_ch_restart(void* self, int32_t flags) {
    ka_chandler* h = (ka_chandler*)self;
    h->restarts++;
    h->restart_flags = flags;
    return KA_OK;
}
static ka_tresult ka_ch_unitsel(void* self, int32_t id) { (void)self; (void)id; return KA_OK; }
static ka_tresult ka_ch_proglist(void* self, int32_t list, int32_t idx) {
    (void)self; (void)list; (void)idx; return KA_OK;
}
static ka_tresult ka_ch_unitbus(void* self) { (void)self; return KA_OK; }

static const void* g_chandler_vtbl[10] = {
    (const void*)ka_ch_qi, (const void*)ka_ch_addref, (const void*)ka_ch_release,
    (const void*)ka_ch_begin, (const void*)ka_ch_perform, (const void*)ka_ch_end,
    (const void*)ka_ch_restart, (const void*)ka_ch_unitsel, (const void*)ka_ch_proglist,
    (const void*)ka_ch_unitbus
};

/* ── 宿主侧连接点代理（src = 本侧插件的 CP，dst = 对侧的插件 CP） ─────────────────────────── */

static ka_tresult ka_cp_qi(void* self, const char* iid, void** obj) {
    if (!obj || !iid) { if (obj) *obj = 0; return KA_NO_INTERFACE; }
    *obj = 0;
    if (ka_iid_is(iid, KA_IID_FUNKNOWN) || ka_iid_is(iid, KA_IID_ICONNECTIONPOINT)) {
        *obj = self;
        ((ka_conn_proxy*)self)->refs++;
        return KA_OK;
    }
    return KA_NO_INTERFACE;
}
static uint32_t ka_cp_addref(void* self) { return (uint32_t)(++((ka_conn_proxy*)self)->refs); }
static uint32_t ka_cp_release(void* self) { return (uint32_t)(--((ka_conn_proxy*)self)->refs); }
static ka_tresult ka_cp_connect(void* self, void* other) {
    ka_conn_proxy* p = (ka_conn_proxy*)self;
    const ka_connpoint_vtbl* sv;
    if (!other) return KA_ERR;
    if (p->dst) return KA_ERR;
    p->dst = other;
    if (!p->src) return KA_OK;
    sv = KA_VT(p->src, ka_connpoint_vtbl);
    if (sv->connect(p->src, self) != KA_OK) { p->dst = 0; return KA_ERR; }
    return KA_OK;
}
static ka_tresult ka_cp_disconnect(void* self, void* other) {
    ka_conn_proxy* p = (ka_conn_proxy*)self;
    if (!other || other != p->dst) return KA_ERR;
    if (p->src) {
        const ka_connpoint_vtbl* sv = KA_VT(p->src, ka_connpoint_vtbl);
        sv->disconnect(p->src, self);
    }
    p->dst = 0;
    return KA_OK;
}
static ka_tresult ka_cp_notify(void* self, void* msg) {
    ka_conn_proxy* p = (ka_conn_proxy*)self;
    const ka_connpoint_vtbl* dv;
    if (!p->dst || !msg) return KA_ERR;
    dv = KA_VT(p->dst, ka_connpoint_vtbl);
    return dv->notify(p->dst, msg);
}

static const void* g_cpproxy_vtbl[6] = {
    (const void*)ka_cp_qi, (const void*)ka_cp_addref, (const void*)ka_cp_release,
    (const void*)ka_cp_connect, (const void*)ka_cp_disconnect, (const void*)ka_cp_notify
};

/* ── 参数变更队列（ProcessData::inputParameterChanges） ───────────────────────────────────── */

static uint32_t ka_pvq_id(void* self) { return ((ka_pvq*)self)->id; }
static int32_t ka_pvq_n(void* self) { return ((ka_pvq*)self)->count; }
static ka_tresult ka_pvq_get(void* self, int32_t i, int32_t* off, double* val) {
    ka_pvq* q = (ka_pvq*)self;
    if (!off || !val || i < 0 || i >= q->count) return KA_ERR;
    *off = q->off[i];
    *val = q->val[i];
    return KA_OK;
}
static ka_tresult ka_pvq_add(void* self, int32_t off, double val, int32_t* idx) {
    ka_pvq* q = (ka_pvq*)self;
    if (q->count >= 2) return KA_ERR;
    q->off[q->count] = off;
    q->val[q->count] = val;
    if (idx) *idx = q->count;
    q->count++;
    return KA_OK;
}
/* 队列对象只认 FUnknown：它们不是连接点，别把 IConnectionPoint 也认下来。 */
static ka_tresult ka_base_qi(void* self, const char* iid, void** obj) {
    if (!obj) return KA_NO_INTERFACE;
    *obj = 0;
    if (iid && ka_iid_is(iid, KA_IID_FUNKNOWN)) { *obj = self; return KA_OK; }
    return KA_NO_INTERFACE;
}
static uint32_t ka_base_addref(void* self) {
    return (uint32_t)(++((ka_conn_proxy*)self)->refs);
}
static uint32_t ka_base_release(void* self) {
    return (uint32_t)(--((ka_conn_proxy*)self)->refs);
}

static const void* g_pvq_vtbl[7] = {
    (const void*)ka_base_qi, (const void*)ka_base_addref, (const void*)ka_base_release,
    (const void*)ka_pvq_id, (const void*)ka_pvq_n, (const void*)ka_pvq_get, (const void*)ka_pvq_add
};

static int32_t ka_pchanges_count(void* self) { return ((ka_pchanges*)self)->count; }
static void* ka_pchanges_get(void* self, int32_t i) {
    ka_pchanges* c = (ka_pchanges*)self;
    if (i < 0 || i >= c->count) return 0;
    return (void*)&c->q[i];
}
static void* ka_pchanges_add(void* self, const uint32_t* id, int32_t* idx) {
    ka_pchanges* c = (ka_pchanges*)self;
    int32_t i;
    if (!id) return 0;
    for (i = 0; i < c->count; ++i) if (c->q[i].id == *id) { if (idx) *idx = i; return (void*)&c->q[i]; }
    if (c->count >= KA_V3_MAX_PCHG) return 0;
    i = c->count++;
    c->q[i].vtbl = g_pvq_vtbl;
    c->q[i].refs = 1;
    c->q[i].id = *id;
    c->q[i].count = 0;
    if (idx) *idx = i;
    return (void*)&c->q[i];
}
static const void* g_pchanges_vtbl[6] = {
    (const void*)ka_base_qi, (const void*)ka_base_addref, (const void*)ka_base_release,
    (const void*)ka_pchanges_count, (const void*)ka_pchanges_get, (const void*)ka_pchanges_add
};

/* 所有插件的 vtable 前三格都是 FUnknown，签名一致 —— QI 不必知道对象是组件还是控制器。 */
static ka_tresult ka_v3_qicp(void* obj, const char* iid, void** out) {
    /* 第一格是 vtable 指针，queryInterface 是 vtable 的第 0 项；直接拿 vtable 当地址调用
     * 会跳进只读数据段，AV 地址落在插件模块里，看着像插件崩了。 */
    const void** vt = *(const void***)obj;
    return ((ka_tresult (*)(void*, const char*, void**))vt[0])(obj, iid, out);
}

/* ── 打开/关闭控制器（连带把组件↔控制器接起来） ───────────────────────────────────────────── */

static void ka_v3_ctrl_free(void) {
    const ka_connpoint_vtbl* cpv;
    g_pchanges.count = 0;
    ka_v3_trace(321);
    if (g_cp_comp_proxy.dst) {
        if (g_v3.cp_comp) { cpv = KA_VT(g_v3.cp_comp, ka_connpoint_vtbl); cpv->disconnect(g_v3.cp_comp, &g_cp_comp_proxy); }
        g_cp_comp_proxy.dst = 0;
    }
    ka_v3_trace(322);
    if (g_cp_ctrl_proxy.dst) {
        if (g_v3.cp_ctrl) { cpv = KA_VT(g_v3.cp_ctrl, ka_connpoint_vtbl); cpv->disconnect(g_v3.cp_ctrl, &g_cp_ctrl_proxy); }
        g_cp_ctrl_proxy.dst = 0;
    }
    ka_v3_trace(323);
    if (g_v3.cp_comp) { cpv = KA_VT(g_v3.cp_comp, ka_connpoint_vtbl); cpv->release(g_v3.cp_comp); g_v3.cp_comp = 0; }
    if (g_v3.cp_ctrl) { cpv = KA_VT(g_v3.cp_ctrl, ka_connpoint_vtbl); cpv->release(g_v3.cp_ctrl); g_v3.cp_ctrl = 0; }
    ka_v3_trace(324);
    if (g_v3.unitinfo) {
        const ka_unitinfo_vtbl* uv = KA_VT(g_v3.unitinfo, ka_unitinfo_vtbl);
        uv->release(g_v3.unitinfo);
        g_v3.unitinfo = 0;
    }
    ka_v3_trace(325);
    if (g_v3.ctrl) {
        const ka_controller_vtbl* cvt = KA_VT(g_v3.ctrl, ka_controller_vtbl);
        cvt->terminate(g_v3.ctrl);
        ka_v3_trace(326);
        cvt->release(g_v3.ctrl);
        g_v3.ctrl = 0;
    }
    ka_v3_trace(327);
    g_v3.ctrl_ok = 0;
    g_v3.n_params = -1;
}

static int32_t g_v3_open_flags = 0;

/** 建控制器并把两侧连接点接上。成功 0；失败 -1 没组件 / -2 取不到控制器 CID /
 *  -3 没有控制器类 / -4 建不出 / -5 initialize 不行。**失败不拖垮已打开的组件**。 */
static int32_t ka_v3_ctrl_open(void) {
    const ka_factory_vtbl* fvt;
    const ka_controller_vtbl* cvt;
    char cid[16];
    void* obj = 0;
    ka_tresult rc;
    int i;

    g_v3.ctrl = 0; g_v3.unitinfo = 0; g_v3.cp_comp = 0; g_v3.cp_ctrl = 0;
    g_v3.ctrl_ok = 0; g_v3.ctrl_rc = 0; g_v3.n_params = -1;
    g_v3_ctrl_step = 100;
    if (!g_v3.comp || !g_v3.factory) return -1;

    ka_v3_trace(101);
    { const ka_component_vtbl* comp = KA_VT(g_v3.comp, ka_component_vtbl);
      int nz = 0;
      for (i = 0; i < 16; ++i) cid[i] = 0;
      rc = comp->getControllerClassId(g_v3.comp, cid);
      if (rc != KA_OK) {
          /* 单组件插件：控制器就是组件自己（Kontakt 7 对 getControllerClassId 回
           * E_NOTIMPL，IEditController 直接挂在组件上）。 */
          void* same = 0;
          comp->queryInterface(g_v3.comp, KA_IID_IEDITCONTROLLER, &same);
          if (same) { obj = same; g_v3_ctrl_step = 103; goto have_ctrl; }
          g_v3.ctrl_rc = rc; g_v3_ctrl_step = 101; return -2;
      }
      for (i = 0; i < 16; ++i) if (cid[i]) nz = 1;
      if (!nz) { g_v3.ctrl_rc = -3; g_v3_ctrl_step = 102; return -3; } }

    ka_v3_trace(102);
    fvt = KA_VT(g_v3.factory, ka_factory_vtbl);
    rc = fvt->createInstance(g_v3.factory, cid, KA_IID_IEDITCONTROLLER, &obj);
    g_v3.ctrl_rc = rc;
    if (rc != KA_OK || !obj) {
        ka_v3_trace(110);
        rc = fvt->createInstance(g_v3.factory, cid, KA_IID_FUNKNOWN, &obj);
        if (rc != KA_OK || !obj) { g_v3.ctrl_rc = rc; g_v3_ctrl_step = 104; return -4; }
        ka_v3_trace(112);
    } else {
        ka_v3_trace(111);
    }
have_ctrl:
    cvt = KA_VT(obj, ka_controller_vtbl);

    g_chandler.vtbl = g_chandler_vtbl;
    g_chandler.refs = 1;
    g_chandler.restarts = 0;
    g_chandler.restart_flags = 0;
    if (g_v3_open_flags & KA_V3_OPEN_HANDLER_FIRST) cvt->setComponentHandler(obj, &g_chandler);

    /* SDK 的 ComponentBase::initialize 对"已初始化"回 kResultFalse(1)，照收。 */
    ka_v3_trace(120);
    rc = cvt->initialize(obj, (g_v3_open_flags & KA_V3_OPEN_CTRL_NOHOST) ? 0 : &g_host_app);
    g_v3.ctrl_rc = rc;
    if (rc != KA_OK && rc != KA_ERR) { cvt->release(obj); g_v3_ctrl_step = 105; return -5; }
    g_v3_ctrl_step = 106;
    ka_v3_trace(104);

    if (!(g_v3_open_flags & KA_V3_OPEN_HANDLER_FIRST)) cvt->setComponentHandler(obj, &g_chandler);
    ka_v3_trace(105);

    /* 程序列表（IUnitInfo）是 optional，取不到不影响出声，只是选不了程序。 */
    ka_v3_trace(121);
    cvt->queryInterface(obj, KA_IID_IUNITINFO, &g_v3.unitinfo);
    ka_v3_trace(122);
    if (g_v3.unitinfo == 0) { /* 有的插件把 IUnitInfo 挂在组件上 */
        const ka_component_vtbl* comp = KA_VT(g_v3.comp, ka_component_vtbl);
        ka_v3_trace(123);
        comp->queryInterface(g_v3.comp, KA_IID_IUNITINFO, &g_v3.unitinfo);
        ka_v3_trace(124);
    }
    ka_v3_trace(106);

    /* 连接：两枚代理各自与本侧插件的 CP 相连（connect 里会调 src->connect），
     * 再把 dst 指到对侧插件的 CP —— 消息就按 组件→代理→控制器 的方向走。 */
    g_cp_comp_proxy.vtbl = g_cpproxy_vtbl; g_cp_comp_proxy.refs = 1; g_cp_comp_proxy.src = 0; g_cp_comp_proxy.dst = 0;
    g_cp_ctrl_proxy.vtbl = g_cpproxy_vtbl; g_cp_ctrl_proxy.refs = 1; g_cp_ctrl_proxy.src = 0; g_cp_ctrl_proxy.dst = 0;
    ka_v3_trace(125);
    if (ka_v3_qicp(g_v3.comp, KA_IID_ICONNECTIONPOINT, &g_v3.cp_comp) != KA_OK) g_v3.cp_comp = 0;
    ka_v3_trace(126);
    if (ka_v3_qicp(obj, KA_IID_ICONNECTIONPOINT, &g_v3.cp_ctrl) != KA_OK) g_v3.cp_ctrl = 0;
    ka_v3_trace(107);
    if (g_v3.cp_comp && g_v3.cp_ctrl) {
        g_cp_comp_proxy.src = g_v3.cp_comp;
        g_cp_ctrl_proxy.src = g_v3.cp_ctrl;
        ka_cp_connect(&g_cp_comp_proxy, g_v3.cp_ctrl);
        ka_cp_connect(&g_cp_ctrl_proxy, g_v3.cp_comp);
    }
    ka_v3_trace(108);

    g_pchanges.vtbl = g_pchanges_vtbl;
    g_pchanges.refs = 1;
    g_pchanges.count = 0;

    g_v3.ctrl = obj;
    g_v3.ctrl_ok = 1;
    g_v3_ctrl_step = 109;
    ka_v3_trace(109);
    return 0;
}

/* ── 参数 / 单元 / 程序列表 ──────────────────────────────────────────────────────────────── */

static int32_t ka_v3_param_count(void) {
    const ka_controller_vtbl* cvt;
    if (!g_v3.ctrl) return -1;
    cvt = KA_VT(g_v3.ctrl, ka_controller_vtbl);
    if (g_v3.n_params < 0) g_v3.n_params = cvt->getParameterCount(g_v3.ctrl);
    return g_v3.n_params;
}

static int32_t ka_v3_param_info(int32_t index, ka_param_info* out) {
    const ka_controller_vtbl* cvt;
    if (!g_v3.ctrl || !out) return -1;
    cvt = KA_VT(g_v3.ctrl, ka_controller_vtbl);
    memset(out, 0, sizeof(*out));
    return (int32_t)cvt->getParameterInfo(g_v3.ctrl, index, out);
}

static double ka_v3_param_get(uint32_t id) {
    const ka_controller_vtbl* cvt;
    if (!g_v3.ctrl) return -1.0;
    cvt = KA_VT(g_v3.ctrl, ka_controller_vtbl);
    return cvt->getParamNormalized(g_v3.ctrl, id);
}

/** 设一个参数（0..1），并**同时**把它排进下一块 process 的参数变更 —— 控制器改了不等于
 *  处理器知道，VST3 里这是两件事。返回控制器的原始 tresult。 */
static int32_t ka_v3_param_set(uint32_t id, double value) {
    const ka_controller_vtbl* cvt;
    ka_pvq* q;
    int32_t i;
    if (!g_v3.ctrl) return -1;
    if (value < 0.0) value = 0.0;
    if (value > 1.0) value = 1.0;
    cvt = KA_VT(g_v3.ctrl, ka_controller_vtbl);
    {
        ka_tresult rc = cvt->setParamNormalized(g_v3.ctrl, id, value);
        for (i = 0; i < g_pchanges.count; ++i) if (g_pchanges.q[i].id == id) break;
        if (i >= g_pchanges.count) {
            if (g_pchanges.count >= KA_V3_MAX_PCHG) return (int32_t)rc;
            i = g_pchanges.count++;
            g_pchanges.q[i].vtbl = g_pvq_vtbl;
            g_pchanges.q[i].refs = 1;
            g_pchanges.q[i].id = id;
            g_pchanges.q[i].count = 0;
        }
        q = &g_pchanges.q[i];
        if (q->count < 2) {
            q->off[q->count] = 0;
            q->val[q->count] = value;
            q->count++;
        }
        return (int32_t)rc;
    }
}

static int32_t ka_v3_unit_count(void) {
    const ka_unitinfo_vtbl* uv;
    if (!g_v3.unitinfo) return -1;
    uv = KA_VT(g_v3.unitinfo, ka_unitinfo_vtbl);
    return uv->getUnitCount(g_v3.unitinfo);
}

static int32_t ka_v3_unit_info(int32_t index, ka_unit_info* out) {
    const ka_unitinfo_vtbl* uv;
    if (!g_v3.unitinfo || !out) return -1;
    uv = KA_VT(g_v3.unitinfo, ka_unitinfo_vtbl);
    memset(out, 0, sizeof(*out));
    return (int32_t)uv->getUnitInfo(g_v3.unitinfo, index, out);
}

static int32_t ka_v3_proglist_count(void) {
    const ka_unitinfo_vtbl* uv;
    if (!g_v3.unitinfo) return -1;
    uv = KA_VT(g_v3.unitinfo, ka_unitinfo_vtbl);
    return uv->getProgramListCount(g_v3.unitinfo);
}

static int32_t ka_v3_proglist_info(int32_t index, ka_proglist_info* out) {
    const ka_unitinfo_vtbl* uv;
    if (!g_v3.unitinfo || !out) return -1;
    uv = KA_VT(g_v3.unitinfo, ka_unitinfo_vtbl);
    memset(out, 0, sizeof(*out));
    return (int32_t)uv->getProgramListInfo(g_v3.unitinfo, index, out);
}

static int32_t ka_v3_program_name(int32_t list_id, int32_t index, char* utf8, int cap) {
    const ka_unitinfo_vtbl* uv;
    ka_string128 name;
    int32_t rc;
    if (!g_v3.unitinfo || !utf8 || cap <= 0) return -1;
    uv = KA_VT(g_v3.unitinfo, ka_unitinfo_vtbl);
    memset(name, 0, sizeof(name));
    rc = (int32_t)uv->getProgramName(g_v3.unitinfo, list_id, index, name);
    ka_v3_utf8(name, utf8, cap);
    return rc;
}

/* ── 编辑器（IPlugView / IPlugFrame）────────────────────────────────────────────────────────
 * 插件的界面只认一个父 HWND。这里只做"造 view / 挂上去 / 按尺寸通知它"；窗口与消息泵在
 * ka_worker.c 的 UI 线程里 —— 音频与界面必须分线程，否则拖旋钮时 ring 喂不上。
 * 尺寸单位是物理像素（kPlatformTypeHWND 的约定）。 */

typedef struct ka_view_rect { int32_t left, top, right, bottom; } ka_view_rect;

typedef struct ka_plugview_vtbl {
    ka_tresult (*queryInterface)(void* self, const char* iid, void** obj);
    uint32_t   (*addRef)(void* self);
    uint32_t   (*release)(void* self);
    ka_tresult (*isPlatformTypeSupported)(void* self, const char* type);
    ka_tresult (*attached)(void* self, void* parent, const char* type);
    ka_tresult (*removed)(void* self);
    ka_tresult (*onWheel)(void* self, float distance);
    ka_tresult (*onKeyDown)(void* self, uint16_t key, int16_t keyCode, int16_t modifiers);
    ka_tresult (*onKeyUp)(void* self, uint16_t key, int16_t keyCode, int16_t modifiers);
    ka_tresult (*getSize)(void* self, ka_view_rect* size);
    ka_tresult (*onSize)(void* self, ka_view_rect* size);
    ka_tresult (*onFocus)(void* self, ka_tbool state);
    ka_tresult (*setFrame)(void* self, void* frame);
    ka_tresult (*canResize)(void* self);
    ka_tresult (*checkSizeConstraint)(void* self, ka_view_rect* rect);
} ka_plugview_vtbl;

typedef struct ka_plugframe_vtbl {
    ka_tresult (*queryInterface)(void* self, const char* iid, void** obj);
    uint32_t   (*addRef)(void* self);
    uint32_t   (*release)(void* self);
    ka_tresult (*resizeView)(void* self, void* view, ka_view_rect* size);
} ka_plugframe_vtbl;

typedef struct ka_plugframe { const void** vtbl; int32_t refs; } ka_plugframe;

/* 窗口层（ka_worker.c 的 UI 线程）：改父窗尺寸，随后的 WM_SIZE 里回调 onSize。 */
static void wk_editor_resize(int32_t w, int32_t h);
static void ka_v3_view_on_size(int32_t w, int32_t h);

static void* g_v3_view = 0;               /* IPlugView*（createView 给的，只在 UI 线程碰） */
static void* g_v3_view_parent = 0;        /* attached() 期间的那个 HWND */
static ka_view_rect g_v3_view_size;
static int32_t g_v3_view_stage = 0;       /* 负数 = 在哪一步失败（排障用） */
static ka_plugframe g_plugframe;

static ka_tresult ka_frame_qi(void* self, const char* iid, void** obj) {
    if (!obj || !iid) { if (obj) *obj = 0; return KA_ERR; }
    if (ka_iid_is(iid, KA_IID_FUNKNOWN) || ka_iid_is(iid, KA_IID_IPLUGFRAME)) {
        *obj = self;
        return KA_OK;
    }
    *obj = 0;
    return KA_ERR;
}
static uint32_t ka_frame_addref(void* self) { return (uint32_t)(++((ka_plugframe*)self)->refs); }
static uint32_t ka_frame_release(void* self) {
    int32_t n = --((ka_plugframe*)self)->refs;
    if (n < 0) ((ka_plugframe*)self)->refs = 0;
    return (uint32_t)((n < 0) ? 0 : n);
}
/** 插件要改窗口大小：先改窗（WM_SIZE 里回调 onSize），同一调用栈里完成，符合 SDK 的顺序。 */
static ka_tresult ka_frame_resize(void* self, void* view, ka_view_rect* size) {
    (void)self;
    if (!size) return KA_ERR;
    if (view && view == g_v3_view) {
        g_v3_view_size = *size;
        wk_editor_resize(size->right - size->left, size->bottom - size->top);
    }
    return KA_OK;
}
static const void* g_plugframe_vtbl[4] = {
    (const void*)ka_frame_qi, (const void*)ka_frame_addref,
    (const void*)ka_frame_release, (const void*)ka_frame_resize
};

/** 造 view（controller 必须已经在）。0 = 成了；-1 没控制器 / -2 createView 失败 /
 *  -3 不认 HWND / -4 getSize 失败。只在 UI 线程上调。 */
static int32_t ka_v3_view_create(void) {
    const ka_controller_vtbl* cvt;
    const ka_plugview_vtbl* vv;
    void* v;

    if (g_v3_view) return 0;
    ka_v3_stage(0);
    if (!g_v3.ctrl) { ka_v3_stage(-1); return -1; }
    cvt = KA_VT(g_v3.ctrl, ka_controller_vtbl);
    if (!cvt->createView) { ka_v3_stage(-2); return -2; }
    ka_v3_stage(-10);
    v = cvt->createView(g_v3.ctrl, "editor");
    ka_v3_stage(-11);
    if (!v) { ka_v3_stage(-2); return -2; }
    g_v3_view = v;
    vv = KA_VT(v, ka_plugview_vtbl);
    if (vv->isPlatformTypeSupported(v, "HWND") != KA_OK) {
        ka_v3_stage(-3);
        vv->release(v);
        g_v3_view = 0;
        return -3;
    }
    ka_v3_stage(-12);
    g_plugframe.vtbl = g_plugframe_vtbl;
    g_plugframe.refs = 1;
    memset(&g_v3_view_size, 0, sizeof(g_v3_view_size));
    if (vv->getSize(v, &g_v3_view_size) != KA_OK
        || g_v3_view_size.right <= g_v3_view_size.left
        || g_v3_view_size.bottom <= g_v3_view_size.top) {
        g_v3_view_size.left = 0; g_v3_view_size.top = 0;
        g_v3_view_size.right = 720; g_v3_view_size.bottom = 520;
    }
    ka_v3_stage(-13);
    vv->setFrame(v, &g_plugframe);
    ka_v3_stage(1);
    return 0;
}

/** view 想要的客户区尺寸。 */
static void ka_v3_view_wanted(int32_t* w, int32_t* h) {
    if (w) *w = g_v3_view_size.right - g_v3_view_size.left;
    if (h) *h = g_v3_view_size.bottom - g_v3_view_size.top;
}

/** 挂到宿主窗口上。0 = 成了。 */
static int32_t ka_v3_view_attach(void* parent) {
    const ka_plugview_vtbl* vv;
    if (!g_v3_view || !parent) return -1;
    vv = KA_VT(g_v3_view, ka_plugview_vtbl);
    g_v3_view_parent = parent;
    ka_v3_stage(2);
    if (vv->attached(g_v3_view, parent, "HWND") != KA_OK) {
        g_v3_view_parent = 0;
        ka_v3_stage(-20);
        return -2;
    }
    ka_v3_stage(3);
    {   int32_t w, h;
        ka_v3_view_wanted(&w, &h);
        ka_v3_view_on_size(w, h);
    }
    ka_v3_stage(4);
    return 0;
}

static void ka_v3_view_on_size(int32_t w, int32_t h) {
    const ka_plugview_vtbl* vv;
    ka_view_rect r;
    if (!g_v3_view || !g_v3_view_parent || w <= 0 || h <= 0) return;
    vv = KA_VT(g_v3_view, ka_plugview_vtbl);
    r.left = 0; r.top = 0; r.right = w; r.bottom = h;
    g_v3_view_size = r;
    vv->onSize(g_v3_view, &r);
}

static void ka_v3_view_focus(int32_t on) {
    const ka_plugview_vtbl* vv;
    if (!g_v3_view || !g_v3_view_parent) return;
    vv = KA_VT(g_v3_view, ka_plugview_vtbl);
    vv->onFocus(g_v3_view, on ? KA_TRUE_ : KA_FALSE_);
}

/** 从父窗上摘下来（父窗销毁之前必须走这一步）。 */
static void ka_v3_view_detach(void) {
    const ka_plugview_vtbl* vv;
    if (!g_v3_view) return;
    vv = KA_VT(g_v3_view, ka_plugview_vtbl);
    if (g_v3_view_parent) vv->removed(g_v3_view);
    g_v3_view_parent = 0;
}

static void ka_v3_view_destroy(void) {
    const ka_plugview_vtbl* vv;
    if (!g_v3_view) return;
    ka_v3_view_detach();
    vv = KA_VT(g_v3_view, ka_plugview_vtbl);
    vv->release(g_v3_view);
    g_v3_view = 0;
    g_v3_view_stage = 0;
}

/* ── 打开 / 关闭 ──────────────────────────────────────────────────────────────────────────── */

static void ka_v3_close(void) {
    const ka_component_vtbl* cvt;
    const ka_processor_vtbl* pvt;

    ka_v3_view_destroy();        /* view 挂在 controller 上，必须先于 ctrl_free */
    ka_v3_ctrl_free();
    ka_v3_trace(301);
    if (g_v3.proc && g_v3.comp) {
        pvt = KA_VT(g_v3.proc, ka_processor_vtbl);
        /* 顺序不能倒：先停处理、再停用、最后 terminate。倒着来会让插件在拆线程的同时
         * 还在被调 process。 */
        pvt->setProcessing(g_v3.proc, KA_FALSE_);
        ka_v3_trace(302);
        pvt->release(g_v3.proc);
        g_v3.proc = 0;
    }
    ka_v3_trace(303);
    if (g_v3.comp) {
        cvt = KA_VT(g_v3.comp, ka_component_vtbl);
        cvt->setActive(g_v3.comp, KA_FALSE_);
        ka_v3_trace(304);
        cvt->terminate(g_v3.comp);
        ka_v3_trace(305);
        cvt->release(g_v3.comp);
        g_v3.comp = 0;
    }
    ka_v3_trace(306);
    if (g_v3.factory) {
        const ka_factory_vtbl* fvt = KA_VT(g_v3.factory, ka_factory_vtbl);
        fvt->release(g_v3.factory);
        g_v3.factory = 0;
    }
    ka_v3_trace(307);
    ka_v3_free_arena();
    ka_v3_trace(308);
    /* **不 FreeLibrary**：HALion 7 的 DllMain(PROCESS_DETACH) 会一直卡住（实测 >120s，
     * 进程还活着但不吭声）—— 它自己起的线程要拿 loader 锁，而 FreeLibrary 正握着那把锁，
     * 经典死锁。Cubase 同样从不在插件实例关闭时卸载模块（模块活到进程结束）：
     * 实例本身已经在上面 terminate/release 掉了，留下来的只是一份代码映射。
     * 下一次打开走 LoadLibraryW 拿回同一个句柄（引用计数 +1），实例是新的。 */
    g_v3.handle = 0;
    ka_v3_trace(309);
    g_v3.alive = 0;
}

/** 打开第 cls_index 个类（该索引来自 ka_vst3_scan 的清单）。返回 0 成功；
 *  -1 加载失败 / -2 没有入口 / -3 建不出组件 / -4 initialize 失败 /
 *  -5 没有 IAudioProcessor / -6 不支持 32 位浮点 / -7 建不了缓冲 / -8 setupProcessing 失败。 */
static int32_t ka_v3_open(const uint16_t* path, int32_t cls_index, int32_t flags) {
    const ka_factory_vtbl* fvt;
    const ka_component_vtbl* cvt;
    const ka_processor_vtbl* pvt;
    ka_bus_info bi;
    ka_speaker_arrangement stereo = 3;      /* kSpeakerL | kSpeakerR */
    void* (*getfac)(void);
    void* h, *fac = 0;
    int32_t i, n_in, n_out, n_in_ch = 0, n_out_ch = 2, rc;

    if (g_v3.comp) ka_v3_close();
    memset(&g_v3, 0, sizeof(g_v3));
    g_v3_open_flags = flags;
    ka_v3_trace(207);

    h = ka_v3_load(path);
    if (!h) return -1;
    g_v3.handle = h;
    ka_v3_trace_mod(h);
    ka_v3_tls_probe(h);
    ka_v3_trace(208);

    /* Native Instruments 的 VST3 除了标准导出还带 InitDll/ExitDll：它是插件自己那层
     * "宿主环境"的一次性入口（Cubase 会先调它再取工厂）。不调的话，插件内部的单例表
     * 里那些指向宿主的格子一直是空的 —— Kontakt 在 createInstance 里解引用的就是这种空。 */
    {   void* init = GetProcAddress(h, "InitDll");
        if (init) {
            ((int32_t (*)(int32_t, int32_t, void*))init)(0, 0, 0);
            ka_v3_mark("i:ok");
        } else ka_v3_mark("i:none");
    }

    getfac = (void* (*)(void))GetProcAddress(h, "GetPluginFactory");
    if (!getfac) return -2;
    fac = getfac();
    if (!fac) return -2;
    g_v3.factory = fac;
    fvt = KA_VT(fac, ka_factory_vtbl);
    ka_v3_trace(209);

    /* 类清单要以扫描那一次为准；这里再取一次是因为调用方可能没扫过。 */
    g_v3_stage = 10;
    {   ka_class_info ci;
        int32_t n = fvt->countClasses(fac);
        ka_v3_trace(210);
        g_v3_last_rc = n;
        g_v3_stage = 11;
        if (cls_index < 0 || cls_index >= n) return -3;
        g_v3_last_rc = fvt->getClassInfo(fac, cls_index, &ci);
        if (g_v3_last_rc != KA_OK) return -3;
        for (i = 0; i < 16; ++i) g_v3.cid[i] = ci.cid[i];
    }
    ka_v3_trace(211);

    ka_v3_trace(205);
    ka_v3_factory_sethost(fac);
    ka_v3_trace(206);

    g_v3_stage = 12;
    ka_v3_trace(200);
    g_v3_last_rc = fvt->createInstance(fac, g_v3.cid, KA_IID_ICOMPONENT, &g_v3.comp);
    if (g_v3_last_rc == KA_OK && g_v3.comp) ka_v3_trace2(1); else ka_v3_trace2(2);
    if (g_v3_last_rc != KA_OK || !g_v3.comp) {
        /* 有插件（JUCE 打包的那批）对 iid 是"自己比"的，按 IComponent 递进去会吃 E_NOINTERFACE，
         * 但按 FUnknown 递就给了同一个组件对象。VST3 组件的 vtable 固定是
         * FUnknown → IPluginBase → IComponent，所以拿回来的指针可以直接当 IComponent 用，
         * 不必再 QI 一次。多这一条兜底不改变语义，只是把"谁比 iid"的分歧吸收掉。 */
        g_v3_stage = 13;
        g_v3_last_rc = fvt->createInstance(fac, g_v3.cid, KA_IID_FUNKNOWN, &g_v3.comp);
        if (g_v3_last_rc != KA_OK || !g_v3.comp) {
            g_v3.comp = 0;
            g_v3_stage = 19;
            return -3;
        }
    }
    cvt = KA_VT(g_v3.comp, ka_component_vtbl);
    ka_v3_trace(201);
    g_v3_stage = 14;
    g_v3_last_rc = cvt->initialize(g_v3.comp, &g_host_app);
    if (g_v3_last_rc != KA_OK) return -4;
    ka_v3_trace(202);

    /* 控制器必须在**激活之前**建好并和对侧接上 —— 这是 SDK 宿主那边的顺序。
     * 放到 setProcessing(true) 之后再 QI IConnectionPoint，ABA 在 QI 里就 AV
     * （插件已经开始跑实时线程/初始化了内部图）；HALion Sonic 则在 controller
     * 的 initialize 里 AV。两处都是"晚了一步"。失败也不拖垮组件：能响但不选音色
     * 好过什么都打不开，原因留在 g_v3.ctrl_rc。 */
    if (!(flags & KA_V3_OPEN_NO_CTRL)) ka_v3_ctrl_open();

    g_v3_stage = 15;
    g_v3_last_rc = cvt->queryInterface(g_v3.comp, KA_IID_IAUDIOPROCESSOR, &g_v3.proc);
    if (g_v3_last_rc != KA_OK || !g_v3.proc) {
        g_v3.proc = 0;
        return -5;
    }
    pvt = KA_VT(g_v3.proc, ka_processor_vtbl);

    g_v3_stage = 16;
    g_v3_last_rc = pvt->canProcessSampleSize(g_v3.proc, KA_SAMPLE32);
    if (g_v3_last_rc != KA_OK) return -6;

    g_v3_stage = 17;
    n_in = cvt->getBusCount(g_v3.comp, KA_MEDIA_AUDIO, KA_DIR_INPUT);
    n_out = cvt->getBusCount(g_v3.comp, KA_MEDIA_AUDIO, KA_DIR_OUTPUT);
    g_v3_last_rc = n_out;
    if (n_in < 0) n_in = 0;
    if (n_out < 0) n_out = 0;
    if (n_out < 1) return -5;                /* 没有输出总线就不是能出声的插件 */

    /* 要立体声。插件不认（返回 kResultFalse）也无所谓，后面按它自己报的声道数走。 */
    pvt->setBusArrangements(g_v3.proc, 0, 0, &stereo, 1);

    memset(&bi, 0, sizeof(bi));
    if (cvt->getBusInfo(g_v3.comp, KA_MEDIA_AUDIO, KA_DIR_OUTPUT, 0, &bi) == KA_OK
        && bi.channelCount > 0 && bi.channelCount <= KA_V3_MAX_CH) {
        n_out_ch = bi.channelCount;
    }
    if (n_in > 0) {
        memset(&bi, 0, sizeof(bi));
        if (cvt->getBusInfo(g_v3.comp, KA_MEDIA_AUDIO, KA_DIR_INPUT, 0, &bi) == KA_OK
            && bi.channelCount > 0 && bi.channelCount <= KA_V3_MAX_CH) {
            n_in_ch = bi.channelCount;
        }
    }

    /* 激活总线。规矩是"宿主把主总线打开"：
     *  · 音频输出总线**全部**激活 —— 乐器就靠这一条出声，等插件自己声明 kDefaultActive
     *    会得到一片静音（Ample 那批就没声明，第一版就是这么哑掉的）；
     *  · 事件输入总线全部激活，否则 MIDI 进不来；
     *  · 音频输入总线只看它自己声明的 default-active，别替插件多开。 */
    {   int32_t dir, k;
        for (dir = KA_DIR_INPUT; dir <= KA_DIR_OUTPUT; ++dir) {
            int32_t nb = cvt->getBusCount(g_v3.comp, KA_MEDIA_EVENT, dir);
            for (k = 0; k < nb; ++k) {
                if (dir == KA_DIR_INPUT) cvt->activateBus(g_v3.comp, KA_MEDIA_EVENT, dir, k, KA_TRUE_);
            }
        }
        for (k = 0; k < n_out; ++k) cvt->activateBus(g_v3.comp, KA_MEDIA_AUDIO, KA_DIR_OUTPUT, k, KA_TRUE_);
        for (k = 0; k < n_in; ++k) {
            memset(&bi, 0, sizeof(bi));
            if (cvt->getBusInfo(g_v3.comp, KA_MEDIA_AUDIO, KA_DIR_INPUT, k, &bi) != KA_OK) continue;
            if (bi.flags & 1u) cvt->activateBus(g_v3.comp, KA_MEDIA_AUDIO, KA_DIR_INPUT, k, KA_TRUE_);
        }
    }

    g_v3.n_in_bus = n_in;
    g_v3.n_out_bus = n_out;
    g_v3.n_in_ch = n_in_ch;
    g_v3.n_out_ch = n_out_ch;
    g_v3.n_ev_in = cvt->getBusCount(g_v3.comp, KA_MEDIA_EVENT, KA_DIR_INPUT);

    if (ka_v3_alloc(n_in, n_out, n_in_ch, n_out_ch) != 0) return -7;

    g_v3.setup.processMode = KA_MODE_REALTIME;
    g_v3.setup.symbolicSampleSize = KA_SAMPLE32;
    g_v3.setup.maxSamplesPerBlock = KA_V3_MAX_BLOCK;
    g_v3.setup.sampleRate = (double)(g_rate > 0 ? g_rate : 48000);

    rc = pvt->setupProcessing(g_v3.proc, &g_v3.setup);
    if (rc != KA_OK) return -8;

    ka_v3_trace(203);
    cvt->setActive(g_v3.comp, KA_TRUE_);
    pvt->setProcessing(g_v3.proc, KA_TRUE_);
    ka_v3_trace(204);

    g_v3.evq.vtbl = g_evl_vtbl;
    g_v3.evq.refs = 1;
    g_v3.evq.count = 0;
    g_v3.evq.items = g_v3.ev_items;
    g_v3.frames_done = 0;
    g_v3.alive = 1;
    return 0;
}

/* ══ 状态：.vstpreset ═══════════════════════════════════════════════════════════════════════
 *
 * 插件自己**没有**"给我加载这个 .nki / 这个音色"的接口：程序列表是空的（Kontakt 的 16 个
 * MIDI 通道程序槽全是占位、HALion 一条程序列表都没有），选程序这条路走不通。Cubase 保存
 * 音色用的也是这一条 —— 把组件的整块状态（含采样引用）写进 IComponent::getState。
 * 所以"换乐器"在这里 = 把用户从 Cubase/Kontakt 导出的 .vstpreset 交给 setState。
 *
 * 文件布局（SDK 的 PresetFile）：
 *   0   "VST3"      4  版本 int32      8  组件类 ID（16 字节）
 *   24  块表：{ char id[4]; int64 offset; int64 size; } …，最后一条 id 全 0（只占 4 字节）
 *   之后是块数据：'Comp' = 组件状态，'Cont' = 控制器状态。offset 是文件绝对偏移。
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

#define KA_ST_SEEK_SET 0
#define KA_ST_SEEK_CUR 1
#define KA_ST_SEEK_END 2

typedef struct ka_stream {
    const void** vtbl;
    int32_t refs;
    unsigned char* data;
    int64_t size;      /* 有效长度（写流 = 已写到的位置） */
    int64_t cap;
    int64_t pos;
} ka_stream;

static ka_tresult ka_st_qi(void* self, const char* iid, void** obj) {
    if (!obj || !iid) { if (obj) *obj = 0; return KA_NO_INTERFACE; }
    if (ka_iid_is(iid, KA_IID_FUNKNOWN) || ka_iid_is(iid, KA_IID_IBSTREAM)) {
        *obj = self;
        return KA_OK;
    }
    *obj = 0;
    return KA_NO_INTERFACE;
}
static uint32_t ka_st_addref(void* self) { return (uint32_t)(++((ka_stream*)self)->refs); }
static uint32_t ka_st_release(void* self) { return (uint32_t)(--((ka_stream*)self)->refs); }

static ka_tresult ka_st_read(void* self, void* buf, int32_t n, int32_t* got) {
    ka_stream* s = (ka_stream*)self;
    int64_t left = s->size - s->pos;
    if (n < 0) n = 0;
    if (left < 0) left = 0;
    if ((int64_t)n > left) n = (int32_t)left;
    if (buf && n > 0) memcpy(buf, s->data + s->pos, (uint64_t)n);
    s->pos += n;
    if (got) *got = n;
    return KA_OK;
}
static ka_tresult ka_st_write(void* self, void* buf, int32_t n, int32_t* put) {
    ka_stream* s = (ka_stream*)self;
    int64_t room = s->cap - s->pos;
    if (n < 0) n = 0;
    if (room < 0) room = 0;
    if ((int64_t)n > room) n = (int32_t)room;
    if (buf && n > 0) memcpy(s->data + s->pos, buf, (uint64_t)n);
    s->pos += n;
    if (s->pos > s->size) s->size = s->pos;
    if (put) *put = n;
    return KA_OK;
}
static ka_tresult ka_st_seek(void* self, int64_t pos, int32_t mode, int64_t* result) {
    ka_stream* s = (ka_stream*)self;
    int64_t p = pos;
    if (mode == KA_ST_SEEK_CUR) p = s->pos + pos;
    else if (mode == KA_ST_SEEK_END) p = s->size + pos;
    if (p < 0) p = 0;
    s->pos = p;
    if (result) *result = p;
    return KA_OK;
}
static ka_tresult ka_st_tell(void* self, int64_t* pos) {
    if (pos) *pos = ((ka_stream*)self)->pos;
    return KA_OK;
}

static const void* g_st_vtbl[7] = {
    (const void*)ka_st_qi, (const void*)ka_st_addref, (const void*)ka_st_release,
    (const void*)ka_st_read, (const void*)ka_st_write, (const void*)ka_st_seek,
    (const void*)ka_st_tell
};

static int32_t ka_rd32(const unsigned char* p) {
    return (int32_t)((uint32_t)p[0] | ((uint32_t)p[1] << 8)
                   | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24));
}
static int64_t ka_rd64(const unsigned char* p) {
    return (int64_t)((uint64_t)(uint32_t)ka_rd32(p)
                   | ((uint64_t)(uint32_t)ka_rd32(p + 4) << 32));
}
static void ka_wr32(unsigned char* p, int32_t v) {
    p[0] = (unsigned char)(v & 255); p[1] = (unsigned char)((v >> 8) & 255);
    p[2] = (unsigned char)((v >> 16) & 255); p[3] = (unsigned char)((v >> 24) & 255);
}
static void ka_wr64(unsigned char* p, int64_t v) {
    ka_wr32(p, (int32_t)(v & 0xFFFFFFFF)); ka_wr32(p + 4, (int32_t)(v >> 32));
}
static int32_t ka_id4(const unsigned char* p, const char* id) {
    return p[0] == (unsigned char)id[0] && p[1] == (unsigned char)id[1]
        && p[2] == (unsigned char)id[2] && p[3] == (unsigned char)id[3];
}

/* 这一趟 setState 每一步的结果（宿主排障要看"卡在组件还是控制器"）。 */
static int32_t g_v3_state_rc[4] = { 0, 0, 0, 0 };

/** 把 .vstpreset 里的状态交给已打开的插件。返回 0 或负错误码。 */
static int32_t ka_v3_state_set(const unsigned char* buf, int64_t size) {
    const ka_component_vtbl* cvt;
    const ka_controller_vtbl* ctrlv;
    const unsigned char* comp_chunk = 0;
    const unsigned char* cont_chunk = 0;
    int64_t comp_size = 0, cont_size = 0;
    int64_t off = 24;
    int32_t n_entries = 0;

    g_v3_state_rc[0] = g_v3_state_rc[1] = g_v3_state_rc[2] = 0;
    if (!g_v3.alive || !g_v3.comp) return -1;
    if (!buf || size < 68) return -2;
    if (!(buf[0] == 'V' && buf[1] == 'S' && buf[2] == 'T' && buf[3] == '3')) return -3;
    g_v3_state_rc[3] = ka_rd32(buf + 4);              /* 版本号，只是回执 */

    while (off + 4 <= size) {
        int64_t co, cs;
        if (buf[off] == 0 && buf[off + 1] == 0 && buf[off + 2] == 0 && buf[off + 3] == 0) break;
        if (off + 20 > size) return -4;
        co = ka_rd64(buf + off + 4);
        cs = ka_rd64(buf + off + 12);
        if (co < 0 || cs < 0 || co + cs > size) return -5;
        if (ka_id4(buf + off, "Comp")) { if (cs > 0) { comp_chunk = buf + co; comp_size = cs; } }
        else if (ka_id4(buf + off, "Cont")) { if (cs > 0) { cont_chunk = buf + co; cont_size = cs; } }
        off += 20;
        if (++n_entries > 64) return -6;
    }
    if (!comp_chunk && !cont_chunk) return -7;

    cvt = KA_VT(g_v3.comp, ka_component_vtbl);
    if (comp_chunk) {
        ka_stream s = { g_st_vtbl, 1, (unsigned char*)comp_chunk, comp_size, comp_size, 0 };
        g_v3_state_rc[0] = cvt->setState(g_v3.comp, &s);
    }
    if (g_v3.ctrl) {
        ctrlv = KA_VT(g_v3.ctrl, ka_controller_vtbl);
        /* 合并式插件（Kontakt 7：控制器就是组件自己）上面那一步已经吃下整块状态了；
         * 分开的（HALion）先让控制器同步组件状态，再吃它自己那一块（参数/界面）。 */
        if (g_v3.ctrl != g_v3.comp && comp_chunk) {
            ka_stream sc = { g_st_vtbl, 1, (unsigned char*)comp_chunk, comp_size, comp_size, 0 };
            g_v3_state_rc[1] = ctrlv->setComponentState(g_v3.ctrl, &sc);
        }
        if (cont_chunk) {
            ka_stream s2 = { g_st_vtbl, 1, (unsigned char*)cont_chunk, cont_size, cont_size, 0 };
            g_v3_state_rc[2] = ctrlv->setState(g_v3.ctrl, &s2);
        }
    }
    return 0;
}

/* ── 文件读 ──────────────────────────────────────────────────────────────── */

#define KA_FILE_OPEN_EXISTING 3
#define KA_FILE_CREATE_ALWAYS 2
#define KA_GENERIC_READ       0x80000000u
#define KA_GENERIC_WRITE      0x40000000u
#define KA_FILE_SHARE_READ    1
#define KA_FILE_SHARE_WRITE   2

static int32_t ka_file_read(const uint16_t* path, unsigned char** out, int64_t* out_size) {
    void* h;
    int64_t sz = 0, got = 0, total = 0;
    int32_t put;
    unsigned char* buf;

    *out = 0; *out_size = 0;
    if (!path) return -1;
    h = CreateFileW(path, KA_GENERIC_READ, KA_FILE_SHARE_READ | KA_FILE_SHARE_WRITE,
                    0, KA_FILE_OPEN_EXISTING, 0, 0);
    if (!h || h == (void*)(int64_t)-1) return -2;
    if (!GetFileSizeEx(h, &sz) || sz <= 0 || sz > (int64_t)256 * 1024 * 1024) {
        CloseHandle(h);
        return -3;
    }
    buf = (unsigned char*)VirtualAlloc(0, (uint64_t)sz, KA_MEM_COMMIT | KA_MEM_RESERVE,
                                       KA_PAGE_READWRITE);
    if (!buf) { CloseHandle(h); return -4; }
    while (total < sz) {
        int32_t want = (int32_t)((sz - total > 0x100000) ? 0x100000 : (sz - total));
        if (!ReadFile(h, buf + total, want, &put, 0) || put <= 0) {
            VirtualFree(buf, 0, KA_MEM_RELEASE);
            CloseHandle(h);
            return -5;
        }
        total += put;
    }
    CloseHandle(h);
    *out = buf;
    *out_size = total;
    return 0;
}

static int32_t ka_file_write(const uint16_t* path, const unsigned char* buf, int64_t size) {
    void* h;
    int64_t total = 0;
    int32_t put;
    if (!path || !buf || size <= 0) return -1;
    h = CreateFileW(path, KA_GENERIC_WRITE, 0, 0, KA_FILE_CREATE_ALWAYS, 0, 0);
    if (!h || h == (void*)(int64_t)-1) return -2;
    while (total < size) {
        int32_t want = (int32_t)((size - total > 0x100000) ? 0x100000 : (size - total));
        if (!WriteFile(h, buf + total, want, &put, 0) || put <= 0) {
            CloseHandle(h);
            return -3;
        }
        total += put;
    }
    CloseHandle(h);
    return (int32_t)total;
}

/** 读 .vstpreset 并交给插件。ret = 0 / 负；字节数写进 out_bytes。 */
static int32_t ka_v3_state_load(const uint16_t* path, int64_t* out_bytes) {
    unsigned char* buf = 0;
    int64_t sz = 0;
    int32_t rc;
    if (out_bytes) *out_bytes = 0;
    rc = ka_file_read(path, &buf, &sz);
    if (rc != 0) return -10 + rc;                 /* -11 打不开 / -12 太大 … */
    if (out_bytes) *out_bytes = sz;
    rc = ka_v3_state_set(buf, sz);
    VirtualFree(buf, 0, KA_MEM_RELEASE);
    return rc;
}

/** 把当前状态写成 .vstpreset（Cubase 同款布局）。返回字节数或负错误码。 */
static int32_t ka_v3_state_save(const uint16_t* path) {
    const ka_component_vtbl* cvt;
    const ka_controller_vtbl* ctrlv;
    int64_t cap = 68 + (int64_t)64 * 1024 * 1024;
    unsigned char* out;
    ka_stream comp, ctrl;
    int64_t total;
    int32_t rc, comp_size, ctrl_size, has_ctrl;

    if (!g_v3.alive || !g_v3.comp) return -1;
    out = (unsigned char*)VirtualAlloc(0, (uint64_t)cap, KA_MEM_COMMIT | KA_MEM_RESERVE,
                                       KA_PAGE_READWRITE);
    if (!out) return -2;

    memset(out, 0, 68);
    out[0] = 'V'; out[1] = 'S'; out[2] = 'T'; out[3] = '3';
    ka_wr32(out + 4, 1);                              /* 版本 1 */
    memcpy(out + 8, g_v3.cid, 16);

    comp.vtbl = g_st_vtbl; comp.refs = 1;
    comp.data = out + 68; comp.size = 0; comp.cap = cap - 68; comp.pos = 0;
    cvt = KA_VT(g_v3.comp, ka_component_vtbl);
    rc = cvt->getState(g_v3.comp, &comp);
    comp_size = (int32_t)comp.size;

    ctrl_size = 0;
    has_ctrl = 0;
    if (g_v3.ctrl) {
        ctrlv = KA_VT(g_v3.ctrl, ka_controller_vtbl);
        ctrl.vtbl = g_st_vtbl; ctrl.refs = 1;
        ctrl.data = out + 68 + comp_size; ctrl.size = 0;
        ctrl.cap = comp.cap - comp_size; ctrl.pos = 0;
        if (ctrlv->getState(g_v3.ctrl, &ctrl) == KA_OK && ctrl.size > 0) {
            ctrl_size = (int32_t)ctrl.size;
            has_ctrl = 1;
        }
    }
    if (rc != KA_OK && comp_size <= 0) { VirtualFree(out, 0, KA_MEM_RELEASE); return -3; }
    if (comp_size <= 0 && !has_ctrl) { VirtualFree(out, 0, KA_MEM_RELEASE); return -4; }

    /* 块表：有数据才写那一行（HALion 7 的组件 getState 是 0 字节，状态全在控制器）。
     * 空位天然是终止符（4 个 0）。 */
    {
        int32_t base = 24, nchunks = 0;
        if (comp_size > 0) {
            memcpy(out + base, "Comp", 4);
            ka_wr64(out + base + 4, 68);
            ka_wr64(out + base + 12, comp_size);
            base += 20;
            ++nchunks;
        }
        if (has_ctrl) {
            memcpy(out + base, "Cont", 4);
            ka_wr64(out + base + 4, 68 + comp_size);
            ka_wr64(out + base + 12, ctrl_size);
            ++nchunks;
        }
    }
    total = 68 + comp_size + ctrl_size;
    rc = ka_file_write(path, out, total);
    VirtualFree(out, 0, KA_MEM_RELEASE);
    return (rc < 0) ? rc - 100 : rc;
}

/* ── 事件与渲染 ──────────────────────────────────────────────────────────────────────────── */

/** 排障：把所有总线列成多行 "a|in|0|ch=2|flags=1"（a=audio e=event），返回行数。
 *  静音时先看这里：输出总线声道数是不是 0、flags 里有没有 default-active。 */
static int32_t ka_v3_buses(char* buf, int cap) {
    const ka_component_vtbl* cvt;
    ka_bus_info bi;
    int32_t dir, k, lines = 0, o = 0;
    if (!buf || cap < 32 || !g_v3.comp) { if (buf && cap) buf[0] = 0; return 0; }
    cvt = KA_VT(g_v3.comp, ka_component_vtbl);
    for (k = 0; k < 2; ++k) {
        int32_t type = (k == 0) ? KA_MEDIA_AUDIO : KA_MEDIA_EVENT;
        char tag = (k == 0) ? 'a' : 'e';
        for (dir = KA_DIR_INPUT; dir <= KA_DIR_OUTPUT; ++dir) {
            int32_t nb = cvt->getBusCount(g_v3.comp, type, dir), j;
            for (j = 0; j < nb; ++j) {
                memset(&bi, 0, sizeof(bi));
                if (cvt->getBusInfo(g_v3.comp, type, dir, j, &bi) != KA_OK) continue;
                if (o < cap - 1) buf[o++] = tag;
                if (o < cap - 1) buf[o++] = '|';
                if (o < cap - 1) buf[o++] = (dir == KA_DIR_INPUT) ? 'i' : 'o';
                if (o < cap - 1) buf[o++] = '|';
                if (o < cap - 1) buf[o++] = (char)('0' + (j % 10));
                if (o < cap - 3) { buf[o++] = '|'; buf[o++] = 'c'; buf[o++] = 'h';
                                   buf[o++] = (char)('0' + (bi.channelCount % 10)); }
                if (o < cap - 3) { buf[o++] = '|'; buf[o++] = 'f';
                                   buf[o++] = (char)('0' + (int)(bi.flags & 15)); }
                if (o < cap - 1) buf[o++] = '\n';
                ++lines;
            }
        }
    }
    if (o < cap) buf[o] = 0;
    return lines;
}

/** 塞一个音符事件。on=1 开、on=0 关；vel 0..127；offset = 落在这一块的第几帧。
 *  走带里按时钟排出来的音符带真实 offset（不然整块都挤在块首，听感是"一抖一抖"）。 */
static int32_t ka_v3_note(int32_t on, int32_t ch, int32_t pitch, int32_t vel, int32_t offset) {
    ka_event* e;
    if (!g_v3.alive) return -1;
    if (g_v3.evq.count >= KA_V3_MAX_EVENTS) return -2;
    if (ch < 0) ch = 0;
    if (ch > 15) ch = 15;
    if (pitch < 0) pitch = 0;
    if (pitch > 127) pitch = 127;
    if (offset < 0) offset = 0;
    if (offset > KA_V3_MAX_BLOCK - 1) offset = KA_V3_MAX_BLOCK - 1;
    e = g_v3.ev_items + g_v3.evq.count;
    memset(e, 0, sizeof(ka_event));
    e->busIndex = 0;
    e->sampleOffset = offset;
    e->flags = 0;
    if (on) {
        e->type = KA_EV_NOTEON;
        e->u.noteOn.channel = (int16_t)ch;
        e->u.noteOn.pitch = (int16_t)pitch;
        e->u.noteOn.tuning = 0.0f;
        e->u.noteOn.velocity = (float)vel / 127.0f;
        e->u.noteOn.length = 0;
        e->u.noteOn.noteId = -1;
    } else {
        e->type = KA_EV_NOTEOFF;
        e->u.noteOff.channel = (int16_t)ch;
        e->u.noteOff.pitch = (int16_t)pitch;
        e->u.noteOff.velocity = (float)vel / 127.0f;
        e->u.noteOff.noteId = -1;
        e->u.noteOff.tuning = 0.0f;
    }
    ++g_v3.evq.count;
    return g_v3.evq.count;
}

/** 渲染一块到内部缓冲。dst 非空时同时拷出交错立体声（LRLR…），供测试与导出用。
 *  pos = 这一块第一帧在时间线上的绝对位置（插件用它做自己的时间/琶音器）。
 *  返回 0 成功；负数是没打开或插件拒绝（-1 未打开 / -2 process 返回失败）。 */
static int32_t ka_v3_render(float* dst, int32_t frames, int64_t pos) {
    const ka_processor_vtbl* pvt;
    ka_process_data pd;
    ka_process_context ctx;
    int32_t i, f, biggest = 0;

    if (!g_v3.alive || !g_v3.proc) return -1;
    if (frames <= 0) return 0;
    if (frames > KA_V3_MAX_BLOCK) frames = KA_V3_MAX_BLOCK;

    memset(&pd, 0, sizeof(pd));
    pd.processMode = KA_MODE_REALTIME;
    pd.symbolicSampleSize = KA_SAMPLE32;
    pd.numSamples = frames;
    pd.numInputs = g_v3.n_in_bus;
    pd.inputs = (g_v3.n_in_bus > 0) ? g_v3.ins : 0;
    pd.numOutputs = g_v3.n_out_bus;
    pd.outputs = g_v3.outs;
    pd.inputEvents = (g_v3.n_ev_in > 0) ? (void*)&g_v3.evq : 0;
    pd.outputEvents = 0;
    pd.inputParameterChanges = (g_pchanges.count > 0) ? (void*)&g_pchanges : 0;
    pd.outputParameterChanges = 0;

    memset(&ctx, 0, sizeof(ctx));
    ctx.state = KA_CTX_PLAYING | KA_CTX_TEMPO_VALID | KA_CTX_PROJECTTIME_VALID;
    ctx.sampleRate = g_v3.setup.sampleRate;
    ctx.projectTimeSamples = pos;
    ctx.continousTimeSamples = pos;
    ctx.tempo = 120.0;
    ctx.projectTimeMusic = (g_v3.setup.sampleRate > 0.0)
        ? (double)pos / g_v3.setup.sampleRate * 2.0 : 0.0;
    pd.processContext = &ctx;

    /* 输出先清零：插件可以选择"不写"某一路，那时留下的就是我们上一次的内容。 */
    for (i = 0; i < g_v3.n_out_ch; ++i) {
        float* p = g_v3.out_ch_ptr[i];
        for (f = 0; f < frames; ++f) p[f] = 0.0f;
    }

    pvt = KA_VT(g_v3.proc, ka_processor_vtbl);
    if (!pvt) return -2;
    {
        ka_tresult prc = pvt->process(g_v3.proc, &pd);
        g_pchanges.count = 0;        /* 参数变更只发一块 */
        if (prc != KA_OK) { g_v3.evq.count = 0; return -2; }
    }

    g_v3.evq.count = 0;              /* 事件只发一块 */
    g_v3.frames_done += frames;

    for (i = 0; i < g_v3.n_out_ch; ++i) {
        const float* p = g_v3.out_ch_ptr[i];
        for (f = 0; f < frames; ++f) {
            float v = p[f];
            int32_t a = (v < 0.0f) ? -(int32_t)(v * -1000.0f) : (int32_t)(v * 1000.0f);
            if (a < 0) a = -a;
            if (a > biggest) biggest = a;
        }
    }
    g_v3.peak = biggest;

    if (dst) {
        int32_t ch = g_v3.n_out_ch;
        for (f = 0; f < frames; ++f) {
            for (i = 0; i < 2; ++i) {
                dst[f * 2 + i] = (i < ch) ? g_v3.out_ch_ptr[i][f] : 0.0f;
            }
        }
    }
    return 0;
}

/* ── 排障：createInstance 逐个 iid 试 ────────────────────────────────────────────────────────
 * 插件的工厂对 iid 是**自己比**的：有的 memcmp TUID，有的转成 FUID 再比，有的只认自己声明的
 * 那个组件 IID。返回 E_NOINTERFACE 时看不出它到底想要什么，所以把候选挨个递一遍，
 * 谁返回 0 就说明它认谁。which 见下。
 * ──────────────────────────────────────────────────────────────────────────────────────────── */
static int32_t ka_v3_probe_create(const uint16_t* path, int32_t cls_index, int32_t which) {
    const ka_factory_vtbl* fvt;
    ka_class_info ci;
    void* (*getfac)(void);
    void* h, *fac, *obj = 0;
    int32_t n, rc;

    h = ka_v3_load(path);
    if (!h) return -100;
    getfac = (void* (*)(void))GetProcAddress(h, "GetPluginFactory");
    if (!getfac) { FreeLibrary(h); return -101; }
    fac = getfac();
    if (!fac) { FreeLibrary(h); return -102; }
    fvt = KA_VT(fac, ka_factory_vtbl);
    n = fvt->countClasses(fac);
    if (cls_index < 0 || cls_index >= n) { FreeLibrary(h); return -103; }
    if (fvt->getClassInfo(fac, cls_index, &ci) != KA_OK) { FreeLibrary(h); return -104; }

    switch (which) {
    case 0: rc = fvt->createInstance(fac, ci.cid, KA_IID_ICOMPONENT, &obj); break;
    case 1: rc = fvt->createInstance(fac, ci.cid, KA_IID_FUNKNOWN, &obj); break;
    case 2: rc = fvt->createInstance(fac, ci.cid, KA_IID_IPLUGINBASE, &obj); break;
    case 3: rc = fvt->createInstance(fac, ci.cid, KA_IID_IAUDIOPROCESSOR, &obj); break;
    case 4: rc = fvt->createInstance(fac, ci.cid, ci.cid, &obj); break;
    case 5: rc = fvt->createInstance(fac, ci.cid, KA_IID_IEDITCONTROLLER, &obj); break;
    default: rc = -105; break;
    }
    if (obj) {
        /* 造出来的东西要还回去，否则每试一次漏一个 */
        const ka_component_vtbl* cvt = KA_VT(obj, ka_component_vtbl);
        cvt->release(obj);
    }
    FreeLibrary(h);
    return rc;
}

#endif /* KA_VST3_H */
