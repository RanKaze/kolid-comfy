import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  KF_EPS, fmtTime, kfChannelInfo, kfMoveKey, kfRecord, kfRemoveChannel, kfRemoveKey, kfSample,
  kfLocalTimes, kfSnapshotMeta, kfSnapshotValues, kfU, kfSec, rulerStep,
  type VidClip, type VidController, type VidKfChannelInfo, type VidKfMeta, type VidKfSnapshot, type VidKeyframe, type VidKeyframes as VidKfStore,
} from './model';
import { getVidSelection, subscribeVidSelection } from './selection';
import { getKfArmed, setKfArmed, subscribeKfArmed } from './kfArmed';
import { getKfSelection, kfKeyAt, kfPickBox, kfPickChannel, kfPickKey, kfPickKeys, subscribeKfSelection, switchKfClip } from './kfSelection';
import { markRender } from './perf';
import { wbStyles } from '../skin';
import { hit, isRecording } from '../../keybindings';

// ── Keyframes 窗（Dopesheet）──────────────────────────────────────────────────────────────────
// 读法照 Unity 的 Animation 视图：**左列一行一个属性，右侧同一行的泳道把这枚属性的关键帧按时刻
// 摊开**，播放头一根、贯穿两列。关键帧只是泳道上的菱形 —— 不占行、不展开成清单；一枚属性无论是
// 一个值还是一串帧，都**只有一行**（"一个变量两行"是旧行模型把每个 key 摊成子行、以及粘贴段
// 旧层 id 与新层 id 各出一组留下的问题，这里一并按属性身份归一）。
//
// 行的来源 = **这一枚段自己那套图层集**的参数清单与档里已有通道的**交集**：只有真的打过帧的
// 属性才出行，一枚帧都没有的参数不显示（与 Unity Animation 窗一致，一个变量永远只有一行）。
// 粘贴段换号后档里留下的旧通道按**层名/特效名**并进活表同一行；实在认不上的才单独立"旧层"组
// （帧不丢，但同一属性不会被摊成两行）。参数清单走 `kfSnapshot(段自己的 layerKey)`：必须按段
// 寻址，不能拿"页面当下活跃那套"的值录进这一段 —— 层 id 对不上时回放会被整条丢掉。
// 整段还没有任何帧时窗里只有一句提示：arm ● 停一下播放头，录下来的参数才会在这里出行。
//
// 时间域是**段内秒**（0…段长，与 model 的 VidKeyframe.t 同一口径）：段在时间线上挪动，帧跟着走，
// 这里的刻度不动。播放头用全局 transport（与 Player / Tracks 同一根），落在段外时值框与行首菱形都不出现。
//
// 一行的手势：
//  · 行首菱形 —— 播放头压在帧上 = 实心，点它删掉这枚；这枚属性在段内还没有帧 = 空心，点它按当下的值加一帧。
//  · 泳道菱形 —— 点=选中（Shift/⌘ 加选），拖=改时刻（默认吸附，按住 Ctrl/⌘ 临时关掉），选中后 Delete 删。
//  · 双击泳道 —— 在双击处那一时刻加帧，值取该刻的插值。
//  · 值框 —— 显示播放头处的值；播放头正好压在帧上时改它=改这枚帧，停在两帧之间=在该刻加一帧（Unity 规矩）。
//  · 空白处拖 = **框选**（橡皮筋）：压在框里的菱形 + 被框到的参数行一起选中（Shift/⌘ 起步 = 加选）。
//  · 右键 —— 在播放头加帧 / 删这枚帧 / 撤掉这条参数的全部帧。
// 整窗：K = 给选中的参数（没选中就全部）在播放头打帧，F = 缩放回"整段铺满"，Alt+滚轮 = 缩放。

const LIST_W = 200;          // 左列（参数表）宽
const RULER_H = 22;
const ROW_H = 22;            // 参数行
const HEAD_H = 20;           // 所属对象（层）行
const SUBHEAD_H = 16;        // 特效小标题行
const MARK_HIT = 14;         // 菱形的命中方块
const SNAP_PX = 6;           // 吸附阈值按屏幕像素给，缩放时手感一致
const PPS_STORE = 'sampler.vkfPps';
const PPS_MIN = 0.5, PPS_MAX = 480;

/** 通道排序：X Y W H Rotation 在前（变换读起来的顺序），Opacity 跟上，特效参数按特效链的先后垫后。 */
const PARAM_ORDER: Record<string, number> = { X: 0, Y: 1, Width: 2, Height: 3, Rotation: 4, Opacity: 5 };
const paramRank = (p: string): number | string => PARAM_ORDER[p] ?? p;
const sortChannel = (a: Channel, b: Channel): number => {
  const ra = paramRank(a.info?.param ?? a.key);
  const rb = paramRank(b.info?.param ?? b.key);
  return typeof ra === 'number' && typeof rb === 'number' ? ra - rb : String(ra).localeCompare(String(rb));
};

/** 一枚帧 + 它真正住在哪个原始通道键里。旧层 id / 别名键并进同一行后，删除、拖动、改值都得
 *  写回帧自己的那条键，不能一律按显示行的主键去改（否则删不掉、或者凭空多出一枚）。 */
type Frame = VidKeyframe & { src: string };
/** 一条属性行。frames = 这条属性上的全部帧（多个原始通道键的帧合并后按时刻排好）；
 *  **只有至少一枚帧的属性才出行**，没有帧的参数不列出来。keys = 这条属性背后的全部原始通道键
 *  —— 正常只有一条；粘贴换号前的旧 id、老别名键会并进来。一个属性永远只有一行：主键（key）
 *  优先用来写新帧，采样按 keys 的顺序找第一条有帧的。 */
type Channel = { key: string; keys: string[]; info: VidKfChannelInfo | null; frames: Frame[] };
type FxBlock = { id: string; name: string; channels: Channel[] };
type Group = { id: string; name: string; keys: number; base: Channel[]; fx: FxBlock[]; orphan: boolean };
type Row =
  | { kind: 'group'; id: string; name: string; keys: number; folded: boolean; height: number; orphan: boolean }
  | { kind: 'fxhead'; text: string; height: number }
  | { kind: 'channel'; ch: Channel; height: number };
type Drag = { x0: number; items: { key: string; t0: number; cur: number }[] };
/** 段自己那套图层集的实时参数清单（页面回的快照折成的两份）：values 给值框兜底与加帧取值，meta 补新面孔的名字。 */
type Avail = { values: Record<string, number>; meta: VidKfMeta };

const clampPps = (v: number): number => Math.max(PPS_MIN, Math.min(PPS_MAX, v));

/** 一条属性在 t 的读数：按 keys 顺序找第一条真有帧的通道（主键没帧、旧别名有帧也算）。
 *  这是行内所有读数（值框、播放头菱形、插值）共用的口径。 */
const sampleChannel = (kf: VidKfStore | undefined, clip: VidClip | null, ch: Channel, local: number): number | null => {
  const u = kfU(clip, local);                 // 通道里的时刻是归一化的（见 model 的 kfU）
  for (const key of ch.keys) {
    const v = kfSample(kf, key, u);
    if (v !== null) return v;
  }
  return null;
};
/** 播放头压着的那枚帧（合并后的一行里同刻只有一枚）。 */
const frameAt = (ch: Channel, t: number): Frame | undefined =>
  ch.frames.find(k => Math.abs(k.t - t) < KF_EPS);

/** 名字表合并：段上已有的通道为准，实时清单只补"还没打过帧的新面孔"。
 *  层名/特效名一旦随帧落进档里，就不该被工作台的改名追走（读档那刻写下的就是答案）。 */
const mergeMeta = (archive: VidKfMeta | undefined, live: VidKfMeta | undefined): VidKfMeta | undefined => {
  if (!archive) return live;
  if (!live) return archive;
  const layers: VidKfMeta['layers'] = { ...live.layers, ...archive.layers };
  for (const id of Object.keys(layers)) {
    const a = archive.layers[id], l = live.layers[id];
    if (a && l) layers[id] = { name: a.name, effects: { ...l.effects, ...a.effects } };
  }
  return { layers };
};

/** 值框的读数：大数收小数位，小数给到能看出差别为止（Opacity 与像素尺寸住在同一列里）。 */
const fmtVal = (v: number): string => {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  return v.toFixed(a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 3);
};
/** 帧地址（通道键 + 时刻）拆回两半；分隔符与 kfSelection 的 kfKeyAt 同一颗（NUL，键名里不会出现）。 */
const SEP = String.fromCharCode(0);
const splitAddr = (addr: string): { key: string; t: number } | null => {
  const i = addr.indexOf(SEP);
  return i < 0 ? null : { key: addr.slice(0, i), t: Number(addr.slice(i + 1)) };
};

// ── 小图标 ── 菱形是关键帧的形状本体（Unity 那一颗），描边/实心两种状态；折叠三角照 DockView 的
// rotate(-90deg) 读法。都是 SVG：字符字形（◆ ▾）会随字体变形、缩放发糊。
const Diamond: React.FC<{ sel?: boolean }> = ({ sel }) => (
  <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden>
    <path d="M5.5 1 10 5.5 5.5 10 1 5.5Z"
      fill={sel ? '#0a84ff' : 'rgba(255,255,255,0.92)'}
      stroke={sel ? '#8ecbff' : 'rgba(255,255,255,0.98)'} strokeWidth="1" />
  </svg>
);

const IconTri: React.FC<{ open: boolean }> = ({ open }) => (
  <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor" aria-hidden
    style={{ transform: open ? 'none' : 'rotate(-90deg)', flexShrink: 0 }}>
    <path d="M2 3.4h6L5 7.4z" />
  </svg>
);

/** 把 ref 回调收到的元素按 key 归进一张表（null = 卸载，摘掉）。播放头的逐帧直写要靠它。 */
const reg = <T,>(map: React.MutableRefObject<Map<string, T>>, key: string, val: T | null): void => {
  if (val) map.current.set(key, val); else map.current.delete(key);
};

export const VidKeyframes: React.FC<{ vid: VidController }> = ({ vid }) => {
  const { project: p, transport } = vid;
  markRender('VidKeyframes');
  const sel = useSyncExternalStore(subscribeVidSelection, getVidSelection);
  const kfSel = useSyncExternalStore(subscribeKfSelection, getKfSelection);
  const armed = useSyncExternalStore(subscribeKfArmed, getKfArmed);
  // 恰好一枚、且是 Layer 段（不是占位坑）才有东西可摊；多选或选了视频段 = 空态那句话。
  const clip: VidClip | null = useMemo(() => {
    if (sel.size !== 1) return null;
    const id = [...sel][0];
    return p.clips.find(c => c.id === id && c.kind === 'layer' && !c.pending) ?? null;
  }, [p, sel]);

  const [folds, setFolds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [menu, setMenu] = useState<{ x: number; y: number; key: string; addr: string | null } | null>(null);
  // 缩放：zoom = 用户定的每秒像素；null = 铺满整段（默认，也是 Fit 那颗按钮的落点）。
  const [zoom, setZoom] = useState<number | null>(() => {
    const v = Number(localStorage.getItem(PPS_STORE));
    return v > 0 ? v : null;
  });
  const [laneVisible, setLaneVisible] = useState(0);
  // 段自己那套图层集的实时参数清单（`kfSnapshot(段自己的 layerKey)` 折出来的两份）。行的第二个来源：
  // 帧都没打过的参数也出行，新建的 Layer 段一开这扇窗就有地方落第一帧。
  const [avail, setAvail] = useState<Avail | null>(null);

  const dur = clip?.duration ?? 0;
  const fitPps = laneVisible > 40 && dur > 0 ? clampPps(laneVisible / dur) : 20;
  const pps = zoom ?? fitPps;
  const domainW = Math.max(24, dur * pps);
  const contentW = LIST_W + domainW;

  // ── 通道 → 所属对象（层）→ 特效，摊成一份行表 ──
  // 一行 = 一枚属性（layers 面板里的一个参数），不是一枚帧。行来自档里有帧的通道；活表（这一枚段
  // 自己那套图层集）只负责给这些通道认出**同一属性**的主键与名字。贴段换号后档里可能还留着旧层 id /
  // 旧特效 id 的通道：按层名、特效类型名并回活表同一行 —— **一个属性永远只有一行**。
  // 收尾时把一枚帧都没有的属性、以及因此变空的层/特效块整块收掉：没帧的参数不该出现在表里。
  const groups = useMemo<Group[]>(() => {
    const kf = clip?.keyframes;
    const meta = mergeMeta(kf?.meta, avail?.meta);
    type Ent = { g: Group; props: Map<string, Channel>; fx: Map<string, FxBlock>; fxByName: Map<string, string | null> };
    const byId = new Map<string, Ent>();
    const ensureGroup = (id: string, name: string): Ent => {
      let ent = byId.get(id);
      if (!ent) {
        ent = {
          g: { id, name, keys: 0, base: [], fx: [], orphan: false },
          props: new Map(), fx: new Map(), fxByName: new Map(),
        };
        byId.set(id, ent);
      }
      return ent;
    };
    /** 参数身份 = 同一层 id 下通道键的剩余部分（transform:cx / opacity / fx:<fxId>:<param>）。
     *  `transform:opacity` 是老别名写法，并进 Opacity 这一行。 */
    const propOf = (key: string, layerId: string): string => {
      const rest = key.slice(`layer:${layerId}:`.length);
      return rest === 'transform:opacity' ? 'opacity' : rest;
    };
    const ensureChannel = (ent: Ent, pid: string, key: string, info: VidKfChannelInfo): Channel => {
      let ch = ent.props.get(pid);
      if (!ch) {
        ch = { key, keys: [], info, frames: [] };
        ent.props.set(pid, ch);
        const fxId = info.fxId;
        if (fxId) {
          let blk = ent.fx.get(fxId);
          if (!blk) {
            blk = { id: fxId, name: info.fxName || `fx ${fxId}`, channels: [] };
            ent.fx.set(fxId, blk);
            ent.g.fx.push(blk);
          }
          blk.channels.push(ch);
          // 特效类型名 → 活表里的 id（同名挂了两枚时记 null：不猜，旧帧单独立块）。
          const nm = info.fxName || '';
          if (nm) {
            const seen = ent.fxByName.get(nm);
            ent.fxByName.set(nm, seen === undefined || seen === fxId ? fxId : null);
          }
        } else {
          ent.g.base.push(ch);
        }
      }
      if (!ch.keys.includes(key)) ch.keys.push(key);
      return ch;
    };
    // ① 活表先立行：参数全在，帧可以后补。层 id 就是这一套里的身份（粘贴后是新号）。
    const liveIds = new Set<string>();
    for (const key of Object.keys(avail?.values ?? {})) {
      const info = kfChannelInfo(key, meta);
      if (!info) continue;
      liveIds.add(info.layerId);
      ensureChannel(ensureGroup(info.layerId, info.layerName), propOf(key, info.layerId), key, info);
    }
    const liveByName = new Map<string, string[]>();
    for (const id of liveIds) {
      const nm = byId.get(id)!.g.name;
      const arr = liveByName.get(nm) ?? [];
      arr.push(id);
      liveByName.set(nm, arr);
    }
    // ② 档里的帧并进来：活层 id 直接对号；旧 id 按层名认亲（唯一同名才认），认不上才立"旧层"组。
    for (const [key, frames] of Object.entries(kf?.channels ?? {})) {
      if (!frames?.length) continue;
      const info = kfChannelInfo(key, meta);
      if (!info) continue;
      let gid = info.layerId;
      if (!liveIds.has(gid)) {
        const same = liveByName.get(info.layerName) ?? [];
        if (same.length === 1) gid = same[0];
      }
      const ent = ensureGroup(gid, info.layerName);
      let rest = propOf(key, info.layerId);
      let fxId = info.fxId;
      let fxName = info.fxName;
      if (fxId) {
        // 旧特效 id 在目标套里没有：按特效类型名认到活表那一条（同类型挂了两枚时不猜）。
        const liveFx = ent.fxByName.get(fxName || '');
        if (!ent.fx.has(fxId) && liveFx) fxId = liveFx;
        const m = /^fx:[^:]+:(.+)$/.exec(rest);
        if (m) rest = `fx:${fxId}:${m[1]}`;
        fxName = meta?.layers?.[gid]?.effects?.[String(fxId)] || fxName;
      }
      const ch = ensureChannel(ent, rest, key, { ...info, layerId: gid, layerName: ent.g.name, fxId, fxName });
      for (const f of frames) {
        const tl = kfSec(clip, f.t);          // 档里是归一化，界面按段内秒摊开
        const hit = ch.frames.find(x => Math.abs(x.t - tl) < KF_EPS);
        if (!hit) ch.frames.push({ t: tl, v: f.v, src: key });
        else if (hit.src !== ch.key && key === ch.key) { hit.v = f.v; hit.src = key; }
      }
    }
    // ③ 收尾：先收掉没有帧的属性（活表列出的参数只是候选，打上帧才成行），再算键数、排序、
    // 标出活表里已经没有的"旧层"组（帧照样能看能删）。
    for (const ent of byId.values()) {
      ent.g.base = ent.g.base.filter(ch => ch.frames.length > 0);
      ent.g.fx = ent.g.fx
        .map(blk => ({ ...blk, channels: blk.channels.filter(ch => ch.frames.length > 0) }))
        .filter(blk => blk.channels.length > 0);
    }
    const out = [...byId.values()]
      .filter(ent => ent.g.base.length > 0 || ent.g.fx.length > 0)
      .map(ent => ent.g)
      .sort((a, b) => Number(a.id) - Number(b.id));
    for (const g of out) {
      g.orphan = !liveIds.has(g.id);
      let n = 0;
      const bump = (ch: Channel): void => {
        ch.frames.sort((a, b) => a.t - b.t);
        n += ch.frames.length;
      };
      g.base.forEach(bump);
      g.base.sort(sortChannel);
      g.fx.sort((a, b) => Number(a.id) - Number(b.id));
      for (const blk of g.fx) { blk.channels.forEach(bump); blk.channels.sort(sortChannel); }
      g.keys = n;
    }
    return out;
  }, [clip, avail]);

  /** 显示行主键 → 通道。值框、行首菱形、右键清通道都按主键找回这条属性（含它背后的全部原始键）。 */
  const channels = useMemo(() => {
    const m = new Map<string, Channel>();
    for (const g of groups) {
      for (const ch of g.base) m.set(ch.key, ch);
      for (const blk of g.fx) for (const ch of blk.channels) m.set(ch.key, ch);
    }
    return m;
  }, [groups]);
  const channelsRef = useRef(channels); channelsRef.current = channels;

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const g of groups) {
      const folded = folds.has(g.id);
      out.push({ kind: 'group', id: g.id, name: g.name, keys: g.keys, folded, height: HEAD_H, orphan: g.orphan });
      if (folded) continue;
      for (const ch of g.base) out.push({ kind: 'channel', ch, height: ROW_H });
      for (const blk of g.fx) {
        out.push({ kind: 'fxhead', text: blk.name, height: SUBHEAD_H });
        for (const ch of blk.channels) out.push({ kind: 'channel', ch, height: ROW_H });
      }
    }
    return out;
  }, [groups, folds]);

  const allKeys = useMemo(() => {
    const out: string[] = [];
    for (const r of rows) if (r.kind === 'channel') out.push(r.ch.key);
    return out;
  }, [rows]);
  const times = useMemo(() => kfLocalTimes(clip), [clip]);

  // ── refs：逐帧的直写与拖动都读这一份，不闭包在旧的渲染上 ──
  const vidRef = useRef(vid); vidRef.current = vid;
  const clipRef = useRef(clip); clipRef.current = clip;
  const ppsRef = useRef(pps); ppsRef.current = pps;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const lineRef = useRef<HTMLDivElement | null>(null);
  const triRef = useRef<HTMLDivElement | null>(null);
  const snapRef = useRef<HTMLDivElement | null>(null);
  const valueRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const toggleRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const solidRefs = useRef<Map<string, SVGPathElement>>(new Map());
  const dragRef = useRef<Drag | null>(null);
  const scrubRef = useRef(false);
  const anchorRef = useRef<{ t: number; off: number } | null>(null);
  const availRef = useRef<Avail | null>(null); availRef.current = avail;
  // 框选（橡皮筋）：按下点（客户端坐标）+ 是否加选 + 那一条框本体。框本体是直写 DOM 的，
  // 不在 React 树里 —— 拖动中每动一次都改选中集，框要是跟着重挂就会闪。
  const bandRef = useRef<{ x0: number; y0: number; add: boolean; live: boolean; el: HTMLDivElement | null } | null>(null);
  // ── 播放头那一趟直写 ── 线/三角/每行值框/每行菱形状态，都跟着 transport 走（与 Tracks 同一口径：
  // 读在先写在后，避免每帧一次强制重排）。值框只在**没在打字**时写，不然会把用户正在敲的字符吞掉。
  const paint = useCallback((): void => {
    const c = clipRef.current;
    const sc = scrollRef.current;
    const sl = sc ? sc.scrollLeft : 0;
    const cw = sc ? sc.clientWidth : 0;
    const t = transport.get();
    const local = c ? t - c.start : 0;
    const inRange = !!c && local >= 0 && local <= c.duration;
    // 播放头画在**段自己的范围里**：越出去（播到下一段、或者外力 seek 到别处）就不画，而不是顺着
    // 泳道一路画到内容区外面去 —— 那样看起来就像"播放头被拖到范围外了"。
    const px = Math.max(0, Math.min(c ? c.duration : 0, local)) * ppsRef.current;
    const line = lineRef.current;
    if (line) {
      line.style.transform = `translateX(${LIST_W + px}px)`;
      line.style.display = inRange ? 'block' : 'none';
    }
    const tri = triRef.current;
    if (tri) {
      tri.style.transform = `translateX(${px}px)`;
      tri.style.display = inRange ? 'block' : 'none';
    }
    const kf = c?.keyframes;
    const live = availRef.current?.values;
    valueRefs.current.forEach((el, key) => {
      // 有帧的属性读插值（这条属性的全部原始键都算）；一条帧都没有的读**页面当下的值** ——
      // 空心那行也得让人看见它此刻是多少，不然"能出行不能看值"会让人以为这行是死的。
      const ch = channelsRef.current.get(key);
      const v = c && inRange ? (ch ? (sampleChannel(kf, c, ch, local) ?? live?.[key] ?? null) : null) : null;
      if (document.activeElement !== el) {
        el.value = v === null ? '' : fmtVal(v);
        el.dataset.kfShown = el.value;      // 落账时认这份：点进去又点出来不算改值
      }
      el.style.opacity = v === null ? '0.35' : '1';
    });
    toggleRefs.current.forEach((btn, key) => {
      btn.style.display = inRange ? 'flex' : 'none';
      const ch = channelsRef.current.get(key);
      const on = inRange && !!ch && ch.frames.some(k => Math.abs(k.t - local) < KF_EPS);
      const solid = solidRefs.current.get(key);
      if (solid) solid.style.opacity = on ? '1' : '0';
      btn.style.color = on ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.4)';
    });
    // 跟随：播放头走出视野就滚过去。拖着东西的时候不滚 —— 滚一下，按下点与命中框的坐标就错位了
    // （橡皮筋是按客户端坐标算命中的，内容跟着跑会框错地方）。
    if (sc && inRange && !dragRef.current && !bandRef.current && !scrubRef.current) {
      const laneW = Math.max(40, cw - LIST_W);
      if (px < sl || px > sl + laneW - 24) sc.scrollLeft = Math.max(0, px - laneW / 2);
    }
  }, [transport]);

  useEffect(() => { paint(); return transport.subscribe(paint); }, [transport, paint]);
  // 每次提交后补一趟：工程改动（加帧/删帧/撤销）也立刻反映到值框与菱形，不用等下一次播放头动。
  useEffect(() => { paint(); });
  // 窗口宽度：铺满档按可见泳道宽算，拖窗/换布局要跟着重算。
  // 依赖看"有没有段"：空态那趟根本没有滚动容器（ref 还是 null），选中段后必须再挂一次观察器，
  // 否则 laneVisible 永远停在 0，铺满档只能退回兜底缩放。
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc || !('ResizeObserver' in window)) return;
    const ro = new ResizeObserver(() => setLaneVisible(Math.max(0, sc.clientWidth - LIST_W)));
    ro.observe(sc);
    setLaneVisible(Math.max(0, sc.clientWidth - LIST_W));
    return () => ro.disconnect();
  }, [clip !== null]);
  // 换一枚段 = 换一套地址：关键帧选中态先塌掉，别把上一枚段的选中带过来。
  useEffect(() => { switchKfClip(clip?.id ?? null); }, [clip?.id]);
  // ── 段自己那套图层集的参数清单 ── 换段、以及 ● 关掉那一趟（刚整套落过帧，页面上也可能多了图层
  // 或特效）问一遍。加帧当下的**值**另有现取（见 recordAt），这里只问"有哪些参数"：空表补行、
  // 空心行的值框读数都靠它。取不到（页面不在/超时）= null，行退回档里已有的通道，什么都不加。
  const availSeq = useRef(0);
  const pullAvail = useCallback((): void => {
    const c = clipRef.current, v = vidRef.current;
    const id = ++availSeq.current;
    if (!c) { setAvail(null); return; }
    void Promise.resolve(v.kfSnapshot?.(c.layerKey || c.id))
      .then(snap => { if (id === availSeq.current) setAvail(snap ? { values: kfSnapshotValues(snap), meta: kfSnapshotMeta(snap) } : null); })
      .catch(() => { if (id === availSeq.current) setAvail(null); });
  }, []);
  useEffect(() => { pullAvail(); }, [clip?.id, clip?.layerKey, pullAvail]);
  const armedWas = useRef(armed);
  useEffect(() => {
    if (armedWas.current && !armed) pullAvail();
    armedWas.current = armed;
  }, [armed, pullAvail]);
  // Alt+滚轮缩放后把"指针下那一刻"钉回原位（pps 落定那一趟再滚）。
  useEffect(() => {
    const a = anchorRef.current;
    const sc = scrollRef.current;
    if (!a || !sc) return;
    anchorRef.current = null;
    sc.scrollLeft = Math.max(0, a.t * pps - a.off);
  }, [pps]);

  /** 指针位置 → 段内时刻（夹在 0…段长）。原点 = 内容层左缘 + 左列宽，与刻度/泳道同一口径。 */
  const localFromX = (clientX: number): number => {
    const el = contentRef.current;
    const c = clipRef.current;
    if (!el || !c) return 0;
    return Math.max(0, Math.min(c.duration, (clientX - el.getBoundingClientRect().left - LIST_W) / ppsRef.current));
  };

  const showSnap = (t: number | null): void => {
    const el = snapRef.current;
    if (!el) return;
    if (t === null) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.style.transform = `translateX(${LIST_W + t * ppsRef.current}px)`;
  };

  /** 拖帧的吸附靶子（段内秒）：段头、段尾、播放头、别的关键帧的时刻。拖着的这几枚自己不算靶子
   *  （否则一按下去就被吸在原地不动）。阈值 = SNAP_PX 像素。 */
  const nearestSnap = (c: VidClip, d: Drag, want: number): number | null => {
    const tol = SNAP_PX / ppsRef.current;
    const mine = new Set(d.items.map(it => it.cur));
    const cand: number[] = [0, c.duration];
    const head = transport.get() - c.start;
    if (head >= 0 && head <= c.duration) cand.push(head);
    for (const t of kfLocalTimes(c)) {
      if (mine.has(t)) continue;
      if (cand.every(x => Math.abs(x - t) >= KF_EPS)) cand.push(t);
    }
    let best: number | null = null, bd = tol;
    for (const s of cand) {
      const dd = Math.abs(s - want);
      if (dd < bd) { bd = dd; best = s; }
    }
    return best;
  };

  // ── 写账的动作 ─────────────────────────────────────────────────────────────────────────────
  /** 落帧只走这一颗：model 的 kfRecord —— 与 ● 录制同一条路（同刻判定、通道惰性建、meta 合并只此
   *  一份规矩）。值先取**这一段自己那套图层**的实时快照（刚在图层上手动拧过的旋钮要按拧成的样子落帧）；
   *  快照里没有这条通道 = 退回档里在该刻的插值；两头都拿不到才什么都不写。 */
  const recordAt = useCallback(async (keys: string[], at: number, label: string): Promise<void> => {
    const c = clipRef.current, v = vidRef.current;
    if (!c || !keys.length) return;
    let snap: VidKfSnapshot | null = null;
    try { snap = (await v.kfSnapshot?.(c.layerKey || c.id)) ?? null; } catch { snap = null; }
    const live = snap ? kfSnapshotValues(snap) : (availRef.current?.values ?? {});
    const values: Record<string, number> = {};
    for (const key of keys) {
      const val = live[key] ?? kfSample(c.keyframes, key, kfU(c, at));
      if (typeof val === 'number' && Number.isFinite(val)) values[key] = val;
    }
    if (!Object.keys(values).length) return;
    v.update(pp => kfRecord(pp, c.id, kfU(c, at), values, snap ? kfSnapshotMeta(snap) : availRef.current?.meta), label);
  }, []);

  /** 在播放头给这些参数各加一枚帧。 */
  const addKeysAtPlayhead = useCallback(async (keys: string[]): Promise<void> => {
    const c = clipRef.current, v = vidRef.current;
    if (!c || !keys.length) return;
    const local = v.transport.get() - c.start;
    if (local < 0 || local > c.duration) return;
    await recordAt(keys, local, 'Add keyframes');
  }, [recordAt]);

  /** 行首菱形：播放头压在帧上 = 删这枚，否则 = 加一帧。删的是帧真正住着的那条原始键。 */
  const toggleKeyAtPlayhead = (ch: Channel): void => {
    const c = clipRef.current, v = vidRef.current;
    if (!c) return;
    const local = v.transport.get() - c.start;
    if (local < 0 || local > c.duration) return;
    const at = frameAt(ch, local);
    if (at) { v.update(pp => kfRemoveKey(pp, c.id, at.src, kfU(c, at.t)), 'Remove keyframe'); return; }
    void addKeysAtPlayhead([ch.key]);
  };

  /** 双击泳道：在双击处那一时刻加一帧 —— 已有帧的属性取该刻的插值，一条帧都没有的属性取当下的实时值。 */
  const addKeyAt = (ch: Channel, t: number): void => {
    const c = clipRef.current;
    if (!c) return;
    void recordAt([ch.key], t, 'Add keyframe').then(() => {
      if (clipRef.current?.id === c.id) kfPickKey(c.id, kfKeyAt(ch.key, t), false);
    });
  };

  const removeKeys = (addrs: string[]): void => {
    const c = clipRef.current, v = vidRef.current;
    if (!c || !addrs.length) return;
    const items = addrs.map(splitAddr).filter((x): x is { key: string; t: number } => !!x);
    if (!items.length) return;
    v.update(pp => items.reduce((q, it) => kfRemoveKey(q, c.id, it.key, kfU(c, it.t)), pp), 'Remove keyframes');
    kfPickKeys(c.id, []);   // 删掉的地址不能再当选中留着
  };

  /** 撤掉一条属性的全部帧：这条属性背后的所有原始键（含旧 id / 别名）一起删干净 ——
   *  只删主键的话，旧键里的帧会立刻以"表里还有帧"的样子把这一行又顶回来。 */
  const clearChannel = (ch: Channel): void => {
    const c = clipRef.current, v = vidRef.current;
    if (!c) return;
    const keys = new Set([ch.key, ...ch.keys]);
    v.update(pp => {
      let q = pp;
      for (const key of keys) q = kfRemoveChannel(q, c.id, key);
      return q;
    }, 'Remove keyframe channel');
  };

  /** 值框落账：播放头压在帧上 = 改这枚帧；停在两帧之间 = 在这一刻加一帧（Unity 的规矩）。
   *  这条不取快照 —— 用户敲进去的数就是答案，页面那份要覆盖它反而改错了。 */
  const commitValue = (ch: Channel, el: HTMLInputElement): void => {
    const c = clipRef.current, v = vidRef.current;
    if (!c) return;
    const shown = el.dataset.kfShown;
    if (shown !== undefined && shown === el.value) return;   // 一个字没敲，光进光出 = 不动档
    const local = v.transport.get() - c.start;
    if (local < 0 || local > c.duration) return;
    const n = parseFloat(el.value);
    if (!Number.isFinite(n)) return;
    const at = frameAt(ch, local);
    if (at && Math.abs(n - at.v) <= 1e-9) return;
    // 停在一枚旧键上就改那一枚（帧住哪条原始键就写回哪条）；不在键上 = 在主键上加一枚。
    const key = at ? at.src : ch.key;
    v.update(pp => kfRecord(pp, c.id, kfU(c, local), { [key]: n }, availRef.current?.meta), at ? 'Edit keyframe' : 'Add keyframe');
  };

  // ── 拖帧 ── 按下落在哪枚菱形上：普通点击只选它，Shift/⌘ 加选/减选；已选中的一枚被按下去 = 整组一起拖。
  const startKeyDrag = (e: React.PointerEvent, f: Frame): void => {
    const c = clipRef.current;
    if (!c || e.button !== 0) return;
    e.stopPropagation();
    const addr = kfKeyAt(f.src, f.t);
    const additive = e.shiftKey || e.metaKey;
    if (additive) kfPickKey(c.id, addr, true);
    else if (!getKfSelection().keys.has(addr)) kfPickKey(c.id, addr, false);
    const addrs = [...getKfSelection().keys];
    const items = (addrs.length ? addrs : [addr])
      .map(splitAddr)
      .filter((x): x is { key: string; t: number } => !!x)
      .map(x => ({ key: x.key, t0: x.t, cur: x.t }));
    if (!items.length) return;
    dragRef.current = { x0: e.clientX, items };
    // 指针捕获挂在**外层不重挂的那棵树**上：菱形自己按时刻编 key，拖动中会被 React 换掉，
    // 捕获在它身上会当场丢。
    try { scrollRef.current?.setPointerCapture(e.pointerId); } catch { /* 合成事件：不挡手势 */ }
  };

  const dragMove = (clientX: number, noSnap: boolean): void => {
    const d = dragRef.current, c = clipRef.current, v = vidRef.current;
    if (!d || !c) return;
    const total = (clientX - d.x0) / ppsRef.current;
    const primary = d.items[0];
    let adj = 0;
    if (noSnap) showSnap(null);
    else {
      const hit = nearestSnap(c, d, primary.t0 + total);
      if (hit !== null) { adj = hit - (primary.t0 + total); showSnap(hit); } else showSnap(null);
    }
    const moves: { key: string; from: number; to: number }[] = [];
    for (const it of d.items) {
      const to = Math.max(0, Math.min(c.duration, it.t0 + total + adj));
      if (Math.abs(to - it.cur) < 1e-9) continue;
      moves.push({ key: it.key, from: it.cur, to });
      it.cur = to;
    }
    if (!moves.length) return;
    v.update(pp => moves.reduce((q, m) => kfMoveKey(q, c.id, m.key, kfU(c, m.from), kfU(c, m.to)), pp), 'Move keyframe');
  };

  const endDrag = (): void => {
    if (!dragRef.current) return;
    dragRef.current = null;
    showSnap(null);
  };

  // ── 框选（橡皮筋）────────────────────────────────────────────────────────────────────────
  // 空白处按下、拖出 4px 以上才算一框：落在框里的菱形 + 被框到的参数行一起进选中集，**拖动中实时**
  // 算命中（松手前就看到选中了什么）。Shift/⌘ 起步 = 往既有选中上加进去，普通起步 = 整块换掉。
  // 按下没挪动不算框选 —— 那是"点一行选这一行"，交给行自己的按下。菱形、行首按钮、标尺都自己收走
  // 按下（stopPropagation 或各自的守卫），不会被这趟抢走。
  const hitBox = (x0: number, y0: number, x1: number, y1: number, add: boolean): void => {
    const c = clipRef.current, el = contentRef.current;
    if (!c || !el) return;
    const l = Math.min(x0, x1), r = Math.max(x0, x1), tp = Math.min(y0, y1), bt = Math.max(y0, y1);
    const over = (q: DOMRect): boolean => q.right > l && q.left < r && q.bottom > tp && q.top < bt;
    const keys: string[] = [], channels: string[] = [];
    // 菱形按**方块整个**算 intersect（不是只看中心）：14px 的一颗，中心点判定会让人觉得"明明压着
    // 却没选上"。地址按帧真正住着的原始键算（旧 id / 别名键的帧也在同一行里显示）。
    for (const m of el.querySelectorAll<HTMLElement>('[data-kf-mark]')) {
      const addr = m.dataset.kfMark;
      if (addr && !keys.includes(addr) && over(m.getBoundingClientRect())) keys.push(addr);
    }
    for (const row of el.querySelectorAll<HTMLElement>('[data-kf-row]')) {
      const key = row.dataset.kfRow;
      if (key && !channels.includes(key) && over(row.getBoundingClientRect())) channels.push(key);
    }
    kfPickBox(c.id, keys, channels, add);
  };

  const bandMove = (e: PointerEvent, additive: boolean): void => {
    const b = bandRef.current, host = contentRef.current;
    if (!b || !host) return;
    const x = e.clientX, y = e.clientY;
    if (!b.live) {
      if (Math.abs(x - b.x0) < 4 && Math.abs(y - b.y0) < 4) return;
      b.live = true;
      // 指针捕获**只在框真的出来之后**才要（拖出窗口也能收到抬起）。按下那趟就捕获会把整条
      // click/dblclick 链改道到容器上 —— "双击泳道加一帧"当场没了（实测就是这个回归）。
      try { scrollRef.current?.setPointerCapture(e.pointerId); } catch { /* 捕获不了也不挡手势 */ }
      const el = document.createElement('div');
      el.setAttribute('data-kf-marquee', '');
      el.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:7;pointer-events:none;'
        + 'border:1px solid rgba(120,200,255,0.9);background:rgba(10,132,255,0.16);border-radius:2px';
      host.appendChild(el);
      b.el = el;
    }
    const cr = host.getBoundingClientRect();
    const box = b.el!;
    box.style.transform = `translate(${Math.min(b.x0, x) - cr.left}px, ${Math.min(b.y0, y) - cr.top}px)`;
    box.style.width = `${Math.abs(x - b.x0)}px`;
    box.style.height = `${Math.abs(y - b.y0)}px`;
    hitBox(b.x0, b.y0, x, y, b.add || additive);
  };

  const endBand = (): void => {
    const b = bandRef.current;
    if (!b) return;
    bandRef.current = null;
    if (b.el) b.el.remove();
  };
  const bandMoveRef = useRef(bandMove); bandMoveRef.current = bandMove;
  const endBandRef = useRef(endBand); endBandRef.current = endBand;
  // 框选的手势挂在滚动容器上，走**原生监听**，不用 React 的 onPointerDown：React 18 给按下处理器
  // 插的是 `setPointerCapture(e)` —— 指针一被重定向到容器，抬起之后的按下就再也不落到行/菱形身上
  // （点一行选一行、拖帧全废，就是"框了一下别的全点不动了"）。原生监听挂在容器自己身上，捕获阶段
  // 还能赶在标尺的 React 按下之前把它拦下（框选不从标尺起步，标尺继续只管 scrub）。
  // 依赖同滚动容器那两趟：空态没有这个节点，选中段之后必须重新挂。
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const down = (e: PointerEvent): void => {
      if (e.button !== 0 || !clipRef.current || dragRef.current || e.defaultPrevented) return;
      const tg = e.target as HTMLElement | null;
      if (!tg || tg.closest('[data-kf-ruler], [data-kf-mark], button, input')) return;
      bandRef.current = { x0: e.clientX, y0: e.clientY, add: e.shiftKey || e.metaKey, live: false, el: null };
    };
    // 只在框真的出来了之后才拦默认行为 —— 按下那一趟就 preventDefault 会把 dblclick 一起掐掉
    // （"双击泳道加一帧"就没了）。拖动中的 preventDefault 管的是浏览器自己的文字选区。
    const move = (e: PointerEvent): void => {
      if (!bandRef.current) return;
      if (bandRef.current.live) e.preventDefault();
      bandMoveRef.current(e, e.shiftKey || e.metaKey);
    };
    const up = (): void => { endBandRef.current(); };
    sc.addEventListener('pointerdown', down, true);
    sc.addEventListener('pointermove', move);
    sc.addEventListener('pointerup', up);
    sc.addEventListener('pointercancel', up);
    return () => {
      sc.removeEventListener('pointerdown', down, true);
      sc.removeEventListener('pointermove', move);
      sc.removeEventListener('pointerup', up);
      sc.removeEventListener('pointercancel', up);
    };
  }, [clip !== null]);
  // ── 标尺 = 唯一的 scrub 入口（与 Tracks 同一读法：点哪拖哪，播放头跟到指针）────────────────
  /** 把目标时刻吸附并**夹进这一段自己的帧范围**：第一帧到"起点仍在段内"的最后一帧。
   *  拖到两头时，落在段边界上的时刻在宿主那边是"这段之外"（区间半开）—— 合成会当场退出这段、
   *  线也消失，看起来就是"播放头被拖到范围外"。所以这里先吸附到帧、再夹进 [首帧, 末帧]。 */
  const clampScrub = (c: VidClip, tTimeline: number): number => {
    const f = Math.max(1, p.fps || 30);
    const loF = Math.ceil(c.start * f - 1e-6);                        // 段的第一帧
    const hiF = Math.max(loF, Math.ceil((c.start + c.duration) * f - 1e-6) - 1);   // 起点仍在段内的最后一帧
    const want = Math.round(tTimeline * f);
    return Math.min(hiF, Math.max(loF, want)) / f;
  };
  const scrubTo = (clientX: number): void => {
    const c = clipRef.current, v = vidRef.current;
    if (!c) return;
    v.seek(clampScrub(c, c.start + localFromX(clientX)));
  };
  const onRulerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0 || !clip) return;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 合成事件 */ }
    scrubRef.current = true;
    scrubTo(e.clientX);
  };
  const onRulerMove = (e: React.PointerEvent): void => { if (scrubRef.current) scrubTo(e.clientX); };
  const onRulerUp = (): void => { scrubRef.current = false; };

  // ── Alt+滚轮缩放 ── React 的 onWheel 是 passive 的（挡不住 Chromium 自己的 Alt+滚轮横向滚），
  // 所以自己挂一趟非 passive 的。缩放把指针下那一刻钉住不动，视觉上就是"围着鼠标推近"。
  // 依赖同窗口宽度那一趟：空态没有滚动容器，选中段之后必须重新挂，否则滚轮永远没反应。
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent): void => {
      if (!e.altKey || !clipRef.current) return;
      e.preventDefault();
      const at = localFromX(e.clientX);
      const next = clampPps(ppsRef.current * Math.exp(-e.deltaY * 0.0018));
      if (Math.abs(next - ppsRef.current) < 1e-6) return;
      anchorRef.current = { t: at, off: e.clientX - sc.getBoundingClientRect().left - LIST_W + sc.scrollLeft };
      localStorage.setItem(PPS_STORE, String(Math.round(next * 1000) / 1000));
      setZoom(next);
    };
    sc.addEventListener('wheel', onWheel, { passive: false });
    return () => { sc.removeEventListener('wheel', onWheel); };
  }, [clip !== null]);

  const fit = (): void => {
    localStorage.removeItem(PPS_STORE);
    setZoom(null);
  };

  // ── 键盘 ── 只在**这扇窗**的焦点上生效（根 div 可聚焦）：K 打帧、Delete 删选中的帧、F 铺满。
  // 打字的时候一概不理。Tracks 的 C（剃刀）与段删除有自己的全局监听，这里不碰。
  // 接下的键要 stopPropagation：Tracks 的"Delete = 删选中的段"挂在 window 的冒泡阶段，
  // 不拦就会先删帧、再把整枚段一起删掉（段在 Tracks 里始终是选中的，删帧时它一定在选中集里）。
  const onKey = (e: React.KeyboardEvent): void => {
    const t = e.target as HTMLElement | null;
    if (!!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!clip || e.repeat || isRecording()) return;
    // 三条命令按名字查表（keyframes.add / delete / fit）；React 的事件包一层，判定要用原生那个。
    const add = hit(e.nativeEvent, 'keyframes.add');
    const del = add ? false : hit(e.nativeEvent, 'keyframes.delete');
    const fitH = add || del ? false : hit(e.nativeEvent, 'keyframes.fit');
    if (!add && !del && !fitH) return;
    if (add) {
      e.preventDefault();
      e.stopPropagation();
      const picked = kfSel.clipId === clip.id && kfSel.channels.size ? [...kfSel.channels] : allKeys;
      void addKeysAtPlayhead(picked.filter(key => allKeys.includes(key)));
    } else if (del) {
      if (kfSel.clipId !== clip.id || !kfSel.keys.size) return;
      e.preventDefault();
      e.stopPropagation();
      removeKeys([...kfSel.keys]);
    } else {
      e.preventDefault();
      e.stopPropagation();
      fit();
    }
  };

  // 右键菜单：点别处/滚动/失焦都收掉（与 Tracks 的轨头菜单同一口径）。
  useEffect(() => {
    if (!menu) return;
    const close = (ev: Event): void => {
      if ((ev as MouseEvent).type === 'contextmenu' && (ev.target as HTMLElement)?.closest?.('[data-kf-menu]')) return;
      setMenu(null);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('blur', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu !== null]);

  const openMenu = (e: React.MouseEvent, key: string, addr: string | null): void => {
    if (!clip) return;
    e.preventDefault();
    e.stopPropagation();
    if (!getKfSelection().keys.has(addr ?? '')) {
      if (addr) kfPickKey(clip.id, addr, false);
    }
    setMenu({ x: e.clientX, y: e.clientY, key, addr });
  };

  const toggleFold = (id: string): void => setFolds(s => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  // ── 皮 ── 左列粘在左、标尺粘在顶，与 Tracks 那棵树同一做法；行高一致才谈得上"同一行"。
  const cornerBox = (h: number): React.CSSProperties => ({
    position: 'sticky', left: 0, width: LIST_W, height: h, flexShrink: 0, zIndex: 4,
    background: '#1b1b1e', borderRight: '0.5px solid rgba(255,255,255,0.10)',
    display: 'flex', alignItems: 'center', gap: 4, padding: '0 6px', userSelect: 'none', minWidth: 0,
  });
  const laneBox = (h: number): React.CSSProperties => ({
    position: 'relative', width: domainW, height: h, flexShrink: 0,
  });
  const triBtn: React.CSSProperties = {
    background: 'transparent', border: 'none', padding: 0, width: 12, height: 12, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'rgba(255,255,255,0.45)', cursor: 'pointer',
  };
  const diaBtn: React.CSSProperties = {
    ...triBtn, width: 14, height: 14, color: 'rgba(255,255,255,0.4)',
  };
  const nameStyle = (indent: number): React.CSSProperties => ({
    fontSize: 10.5, color: 'rgba(255,255,255,0.78)', minWidth: 0, flex: '1 1 0',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingLeft: indent,
  });
  const valBox: React.CSSProperties = {
    width: 52, flexShrink: 0, fontSize: 10, fontVariantNumeric: 'tabular-nums', textAlign: 'right',
    color: 'rgba(255,255,255,0.88)', background: 'rgba(0,0,0,0.3)',
    border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: 4, padding: '1px 4px', outline: 'none',
  };
  const rowBox = (h: number, band: string): React.CSSProperties => ({
    display: 'flex', height: h, borderBottom: '0.5px solid rgba(255,255,255,0.05)', background: band,
  });
  const markStyle = (f: VidKeyframe, h: number): React.CSSProperties => ({
    position: 'absolute', left: f.t * pps - MARK_HIT / 2, top: (h - MARK_HIT) / 2,
    width: MARK_HIT, height: MARK_HIT, padding: 0, border: 'none', background: 'transparent',
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'ew-resize',
  });

  if (!clip) {
    return (
      <div style={emptyStyle}>
        Select <b>one Layer segment</b> in the Tracks window — its animated parameters show up here.
      </div>
    );
  }

  const clipId = clip.id;
  const head0 = transport.get() - clip.start;
  const inRange0 = head0 >= 0 && head0 <= clip.duration;
  const step = rulerStep(pps);
  const ticks: React.ReactNode[] = [];
  const tickEnd = domainW / pps;
  const TICK_LABEL_W = 40;
  for (let t = 0; LIST_W + t * pps + TICK_LABEL_W <= contentW; t += step) {
    ticks.push(
      <div key={t} style={{ position: 'absolute', left: LIST_W + t * pps, top: 7, bottom: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', pointerEvents: 'none' }}>
        <div style={{ width: 1, height: 5, background: 'rgba(255,255,255,0.42)' }} />
        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.45)', padding: '1px 0 0 3px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', letterSpacing: 0.2 }}>{fmtTime(t)}</span>
      </div>,
    );
    if (t + step / 2 <= tickEnd) {
      ticks.push(
        <div key={'m' + t} style={{ position: 'absolute', left: LIST_W + (t + step / 2) * pps, top: 7, width: 1, height: 4, background: 'rgba(255,255,255,0.16)', pointerEvents: 'none' }} />,
      );
    }
  }

  const mark = (ch: Channel, f: Frame, h: number): React.ReactNode => {
    // 地址按帧**真正住着**的那条原始键算：合并进这一行的旧 id / 别名键的帧，选中、拖动、删除
    // 都得回到它自己的键上（按显示主键写会删不掉、或者凭空多出一枚）。
    const addr = kfKeyAt(f.src, f.t);
    const isSel = kfSel.clipId === clipId && kfSel.keys.has(addr);
    const label = ch.info?.param ?? ch.key;
    return (
      <button key={addr} data-kf-mark={addr} type="button"
        style={{ ...markStyle(f, h), zIndex: isSel ? 3 : 2 }}
        title={`${label} = ${fmtVal(f.v)} at ${f.t.toFixed(3)}s (timeline ${fmtTime(clip.start + f.t)}) — drag sideways to retime (snaps; hold Ctrl for free), Shift-click to add to the selection, Delete removes selected keys.`}
        onPointerDown={e => startKeyDrag(e, f)}
        onClick={e => e.stopPropagation()}
        onDoubleClick={e => e.stopPropagation()}
        onContextMenu={e => openMenu(e, ch.key, addr)}
      >
        <Diamond sel={isSel} />
      </button>
    );
  };

  return (
    <div data-kf-root="" tabIndex={0} onKeyDown={onKey}
      onPointerDownCapture={e => {
        // 泳道/行空白处按下 = 把焦点收到这扇窗上，K / Delete / F 才有人接。
        // 落在 input/button 上不动（打字中的值框不能被抢走焦点）。
        if (!(e.target as HTMLElement).closest('input,button')) (e.currentTarget as HTMLDivElement).focus({ preventScroll: true });
      }}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: '#141416', outline: 'none' }}>

      {/* 工具条：● 录制（从 Tracks 左上角搬来，一处一个入口）+ 铺满。说明都进 title。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', borderBottom: '0.5px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
        <button
          data-vid-kf-rec=""
          type="button"
          onClick={() => setKfArmed(!armed)}
          title={armed
            ? 'Keyframe record is ON — a change you make to the layer (opacity / alpha, transform, fx values) is stored as a keyframe right where the playhead is, and a playhead stop records whatever is still different since the previous stop. Click to stop recording.'
            : 'Keyframe record is OFF — click to arm it: changes to the layer (opacity / alpha, transform, fx values) then land as keyframes where you make them, and playhead stops record anything else that changed (stored on the segment).'}
          style={{
            width: 18, height: 18, borderRadius: '50%', cursor: 'pointer', padding: 0, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: armed ? '#ff3b30' : 'rgba(96,26,22,0.92)',
            border: armed ? '1px solid rgba(255,140,130,0.95)' : '1px solid rgba(255,255,255,0.22)',
            boxShadow: armed ? '0 0 9px rgba(255,59,48,0.8)' : 'none',
            transition: 'box-shadow 120ms, background 120ms',
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: armed ? '#fff' : 'rgba(255,255,255,0.32)' }} />
        </button>
        <div style={{ flex: '1 1 0', minWidth: 0 }} />
        <button
          type="button"
          onClick={fit}
          title="Fit (F) — scale so the whole segment spans the lane. Alt+wheel zooms around the pointer."
          style={{ ...wbStyles.btn, ...(zoom === null ? wbStyles.btnOn : {}) }}
        >
          Fit<span style={wbStyles.key}>F</span>
        </button>
      </div>

      {/* 滚动区：标尺 sticky 在顶、参数列 sticky 在左，同一根播放头贯穿两列。 */}
      <div
        ref={scrollRef}
        data-kf-scroll=""
        style={{ flex: '1 1 0', minHeight: 0, overflow: 'auto', position: 'relative' }}
        onPointerMove={e => { if (dragRef.current) dragMove(e.clientX, e.ctrlKey || e.metaKey); }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div ref={contentRef} data-kf-pps={Math.round(pps * 1000) / 1000} style={{ width: contentW, minWidth: '100%', position: 'relative', minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
          {/* 每枚关键帧一根贯穿的细列线：一行的菱形和别的行的菱形对齐时，眼睛能顺着看下去。 */}
          {times.map(t => (
            <div key={'g' + t} style={{ position: 'absolute', left: LIST_W + t * pps - 0.5, top: RULER_H, bottom: 0, width: 1, background: 'rgba(255,255,255,0.05)', pointerEvents: 'none' }} />
          ))}
          {/* 标尺：段内秒。整条只认播放头（点哪拖哪），刻度用与 Tracks 同一把阶梯。 */}
          <div style={{ position: 'sticky', top: 0, zIndex: 5, background: '#141416' }}>
            <div
              data-kf-ruler=""
              onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp} onPointerCancel={onRulerUp}
              style={{ position: 'relative', height: RULER_H, borderBottom: '0.5px solid rgba(255,255,255,0.10)', cursor: 'ew-resize', userSelect: 'none' }}
            >
              <div style={{ position: 'sticky', left: 0, width: LIST_W, height: '100%', zIndex: 7, background: '#1b1b1e', borderRight: '0.5px solid rgba(255,255,255,0.10)', display: 'flex', alignItems: 'center', padding: '0 6px' }}>
                <span data-kf-seg="" title={`This window lays out the keys of one Layer segment on the timeline, in segment-local seconds (0…${dur.toFixed(2)}s) — the segment starts at ${fmtTime(clip.start)} on the timeline.`}
                  style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.42)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', letterSpacing: 0.2 }}>
                  {`0 … ${fmtTime(dur)}`}
                </span>
              </div>
              {ticks}
              <div ref={triRef} data-kf-ph="" style={{ position: 'absolute', left: LIST_W - 5, top: 0, width: 10, height: 7, background: '#ff453a', clipPath: 'polygon(0 0, 100% 0, 50% 100%)', pointerEvents: 'none', zIndex: 8, transform: `translateX(${Math.max(0, head0) * pps}px)`, display: inRange0 ? 'block' : 'none' }} />
            </div>
          </div>

          {rows.map((r, i) => {
            if (r.kind === 'group') {
              return (
                <div key={'h' + r.id} data-kf-group={r.id} style={rowBox(r.height, 'rgba(255,255,255,0.035)')}>
                  <div style={cornerBox(r.height)}>
                    <button type="button" style={triBtn} title={r.folded ? 'Expand this layer — show the parameters it has keys on' : 'Collapse this layer'}
                      onClick={() => toggleFold(r.id)}><IconTri open={!r.folded} /></button>
                    <span style={{ ...nameStyle(0), fontWeight: 700, color: r.orphan ? 'rgba(255,255,255,0.42)' : 'rgba(255,255,255,0.62)' }}
                      title={r.orphan
                        ? `Layer "${r.name}" is no longer in this segment's layer set (its id changed, e.g. after a paste) — its ${r.keys} key${r.keys === 1 ? '' : 's'} are kept and still editable here, but new keys go on the live parameters.`
                        : `Layer "${r.name}" — ${r.keys} keyframe${r.keys === 1 ? '' : 's'} in this segment.`}>{r.name}</span>
                    <span style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.32)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{r.keys}</span>
                  </div>
                  <div style={laneBox(r.height)} />
                </div>
              );
            }
            if (r.kind === 'fxhead') {
              return (
                <div key={'x' + i} style={rowBox(r.height, 'transparent')}>
                  <div style={{ ...cornerBox(r.height), background: '#18181a' }}>
                    <span style={{ ...nameStyle(17), ...wbStyles.groupHead, marginTop: 0 }}
                      title={`Effect "${r.text}" — its parameters live inside the layer group above.`}>{r.text}</span>
                  </div>
                  <div style={laneBox(r.height)} />
                </div>
              );
            }
            const ch = r.ch;
            if (r.kind === 'channel') {
              const label = ch.info?.param ?? ch.key;
              const isSel = kfSel.clipId === clipId && kfSel.channels.has(ch.key);
              const onAtHead = inRange0 && ch.frames.some(k => Math.abs(k.t - head0) < KF_EPS);
              // 能出现在这一行的属性一定已经至少有一枚帧（见 groups 的收尾过滤）。
              return (
                <div key={ch.key} data-kf-row={ch.key}
                  style={rowBox(r.height, isSel ? 'rgba(10,132,255,0.13)' : 'transparent')}
                  onPointerDown={e => {
                    if ((e.target as HTMLElement).closest('input,button')) return;
                    kfPickChannel(clipId, ch.key, e.shiftKey || e.metaKey);
                  }}>
                  <div style={cornerBox(r.height)}>
                    <button ref={el => reg(toggleRefs, ch.key, el)} type="button" data-kf-toggle="" style={diaBtn}
                      title={onAtHead
                        ? `Remove the key on "${label}" at the playhead.`
                        : `Add a key on "${label}" at the playhead — the value comes from the layer as it is on the workbench page right now (interpolated value if the page can't answer).`}
                      onClick={() => toggleKeyAtPlayhead(ch)}>
                      <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden style={{ display: 'block' }}>
                        <path d="M5.5 1 10 5.5 5.5 10 1 5.5Z" fill="none" stroke="currentColor" strokeWidth="1.2" />
                        <path ref={el => reg(solidRefs, ch.key, el)} d="M5.5 1 10 5.5 5.5 10 1 5.5Z" fill="currentColor" stroke="none" style={{ opacity: onAtHead ? 1 : 0 }} />
                      </svg>
                    </button>
                    <span style={{ ...nameStyle(0), color: 'rgba(255,255,255,0.78)' }}
                      title={`${label} — ${ch.frames.length} key${ch.frames.length === 1 ? '' : 's'} (segment-local seconds: ${ch.frames.map(f => f.t.toFixed(2)).join(', ')}). Click this row to select the parameter, then press K to key it at the playhead.`}>{label}</span>
                    <input
                      ref={el => reg(valueRefs, ch.key, el)}
                      data-kf-value=""
                      type="text" inputMode="decimal" style={valBox}
                      title={`Value of "${label}" at the playhead. Enter commits: sitting on a key edits that key, stopped between keys adds one there. Blank = the playhead is outside this segment.`}
                      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      onBlur={e => commitValue(ch, e.currentTarget)}
                    />
                  </div>
                  <div style={laneBox(r.height)} data-kf-lane={ch.key}
                    onDoubleClick={e => addKeyAt(ch, localFromX(e.clientX))}
                    onContextMenu={e => openMenu(e, ch.key, null)}
                    title="Drag a diamond sideways to retime it (snaps to the segment edges, the playhead and other keys — hold Ctrl for free). Double-click here to add a key at that time."
                  >
                    {ch.frames.map(f => mark(ch, f, r.height))}
                  </div>
                </div>
              );
            }
          })}

          {/* 播放头竖线（贯穿标尺与所有行）+ 拖帧时的吸附引导线。逐帧只写 transform。 */}
          <div ref={lineRef} data-kf-line="" style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 1, background: '#ff453a', zIndex: 6, pointerEvents: 'none', opacity: 0.85, transform: `translateX(${LIST_W + Math.max(0, head0) * pps}px)`, display: inRange0 ? 'block' : 'none' }} />
          <div ref={snapRef} style={{ position: 'absolute', left: 0, top: RULER_H, bottom: 0, width: 1, background: 'rgba(120,200,255,0.75)', zIndex: 7, pointerEvents: 'none', display: 'none' }} />
        </div>
      </div>

      {/* 没有任何属性带帧时只剩一句：没有帧的参数不出行，第一帧只能靠 ● 录制落到段上。
          页面没答上（拿不到参数清单）时也是这句话 —— 两种情形要做的事是同一件。 */}
      {!groups.length && (
        <div data-kf-empty="" style={{ ...wbStyles.note, padding: '7px 10px', borderTop: '0.5px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
          <b style={{ color: 'rgba(255,255,255,0.55)' }}>No keyed parameters yet</b> — arm <b style={{ color: 'rgba(255,255,255,0.55)' }}>●</b> and stop the playhead: the parameters you changed get keys on this segment, and only those rows show up here.
        </div>
      )}
      {/* 右键菜单：与 Tracks 的轨头菜单同一份皮，挂 body（不受滚动/裁剪影响）。 */}
      {menu && (() => {
        // 菜单挂的是**合并后的属性行**（channels 表），不是某一条原始通道键：旧 id / 别名键的帧
        // 也在同一行里，"全选/删全部帧"必须把它们一起算上，否则删不干净、行会立刻顶回来。
        const chOf = channels.get(menu.key);
        const chFrames = chOf?.frames ?? [];
        const info = chOf?.info ?? kfChannelInfo(menu.key, clip.keyframes?.meta);
        const chLabel = info?.param ?? menu.key;
        const owner = info?.layerName ? `${info.layerName} · ` : '';
        const picked = kfSel.clipId === clipId && chOf
          ? [...kfSel.keys].filter(a => chFrames.some(f => kfKeyAt(f.src, f.t) === a))
          : [];
        const del = menu.addr ? [menu.addr] : picked;
        const items: { k: string; label: string; tip: string; on: () => void; danger?: boolean }[] = [
          { k: 'add', label: 'Add Key at Playhead', tip: `Put a key on "${chLabel}" at the playhead — value from the layer as it is on the workbench page now. Does nothing when the playhead is outside this segment.`, on: () => { void addKeysAtPlayhead([chOf?.key ?? menu.key]); } },
        ];
        if (del.length) items.push({
          k: 'del', danger: true,
          label: del.length === 1 ? 'Delete Key' : `Delete ${del.length} Keys`,
          tip: `Remove ${del.length === 1 ? `the key on "${chLabel}" at ${Number(del[0].split(SEP)[1]).toFixed(3)}s` : `the ${del.length} selected keys of "${chLabel}"`}.`,
          on: () => removeKeys(del),
        });
        if (chFrames.length > 1) items.push({
          k: 'sel', label: 'Select All Keys of This Parameter',
          tip: `Select all ${chFrames.length} keys of "${chLabel}" — drag one to move them together, Delete to remove them.`,
          on: () => kfPickKeys(clipId, chFrames.map(f => kfKeyAt(f.src, f.t))),
        });
        if (chOf) items.push({
          k: 'clear', danger: true, label: 'Remove All Keys of This Parameter',
          tip: `Take "${chLabel}" off ${owner}this segment — the row goes away with it (the parameter itself keeps its value).`,
          on: () => clearChannel(chOf),
        });
        return createPortal(
          <div
            data-kf-menu="1"
            onContextMenu={e => e.preventDefault()}
            style={{
              position: 'fixed', zIndex: 9999,
              left: Math.max(8, Math.min(menu.x, window.innerWidth - 250)),
              top: Math.max(8, Math.min(menu.y, window.innerHeight - 40 - 30 * items.length)),
              minWidth: 210, padding: 4, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 1,
              background: 'rgba(34,34,38,0.985)', border: '0.5px solid rgba(255,255,255,0.16)',
              boxShadow: '0 12px 36px rgba(0,0,0,0.6)',
            }}
          >
            {items.map(it => (
              <button key={it.k} type="button"
                onClick={() => { it.on(); setMenu(null); }}
                title={it.tip}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left',
                  padding: '6px 9px', borderRadius: 5, border: 'none',
                  background: 'transparent', color: it.danger ? '#ff6b60' : 'rgba(255,255,255,0.92)',
                  fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >{it.label}</button>
            ))}
          </div>,
          document.body,
        );
      })()}
    </div>
  );
};

const emptyStyle: React.CSSProperties = {
  padding: '14px 12px', fontSize: 10.5, lineHeight: 1.6, color: 'rgba(255,255,255,0.42)',
};

