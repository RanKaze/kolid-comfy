import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import EditPhase from './components/EditPhase';
import type { Tab, ServerConfig, StatusResponse, PipelineBlock, DetailerBlockParams, InterfaceBlockParams, StagingItem, InterfaceInfo, PipelinePackageInfo, BlockSet, PendingQuery, ActionLogEntry, PipelineSettings, InterfaceMeta, ArchSettings, ArchRule, OverrideKey, BlendDoc, BlendDocs, BlendDocCommand, BlendUiAction, BlendUiPayloads, BlendUiSend, BlendPen } from './types';
import { blocksToGraph, graphToBlocks, sanitizeGraph, type PipelineGraph } from './workbench/pipeline-graph';
import { EMPTY_PIPELINE_SETTINGS, EMPTY_ARCH_SETTINGS, EMPTY_BLEND_DOCS, EMPTY_BLEND_UI, preprocessFlag } from './types';
import type { BlendLayerRow, BlendRowMenu, BlendAttrKind, BlendAttrOpen, BlendFxOpenStep, BlendFxRow, BlendProcessorUi, BlendProcChoice, BlendProcInRow, BlendProcOutRow, BlendProcParamRow, BlendGeometryUi, BlendGeometryDesc, BlendPoseUi, BlendPoseDesc, BlendStaging } from './types';
import { getBlendUiOf, setBlendUi, setBlendActiveUid, dropBlendUi, getActiveBlendUid } from './workbench/store';
import { parseDocAssets, setDocAssets, dropDocAssets } from './workbench/docAssets';
import { getVidStagingOverlay, dropVidProcState } from './workbench/video/procRun';
import { dropVidProcPicks } from './workbench/video/procPicks';
import { bumpAssets } from './workbench/video/assetsTick';

const POLL_INTERVAL = 500;
const PROMPT_POLL_INTERVAL = 1500;

/** 行描述符过界的形状闸：读不出数组就当这一摞是空的。其余字段交给单元自己判（每一个都写了默认值），
 *  这里不替页面重述一遍它的契约 —— 那才是第二份真相。唯一例外是菜单那一格：它的六个字段决定条目
 *  出现还是灰掉，"缺字段"必须回成"这一条办不了"那一组值，而不是让 React 把 undefined 当假、摆出一灰排
 *  却没人说得清为什么。 */
/** 一条行描述符里菜单那一格。缺字段回的是"什么都办不了"那一组值（没有 buffer、画布没定、没成组、
 *  文档没开），而不是让 React 读一个 undefined 就当假 —— 少一格字段与那一格真是假在界面上必须不同形。 */
const rowMenu = (v: unknown): BlendRowMenu => {
  const m = (v && typeof v === 'object' ? v : {}) as Partial<BlendRowMenu>;
  return {
    genHasImg: m.genHasImg === true, hasBuffer: m.hasBuffer === true, canvasReady: m.canvasReady === true,
    groupSize: typeof m.groupSize === 'number' && Number.isFinite(m.groupSize) ? Math.max(0, Math.round(m.groupSize)) : 0,
    hasText: m.hasText === true, cudDocOpen: m.cudDocOpen === true,
  };
};
const rowList = (v: unknown): BlendLayerRow[] => (Array.isArray(v) ? v as Array<Record<string, unknown>> : [])
  .map(r => ({ ...(r as unknown as BlendLayerRow), menu: rowMenu(r.menu) }));
/** `+` 菜单的条目：不是数组回空表，条目里非字符串的两段丢掉（那一类摆不出名字就没法报它做什么）。
 *  `kind` 读不出来就当空串 —— 那是"不认识的分支"，视频模式下因此不会为它问轨道（安全的一侧）。 */
const kindList = (v: unknown): BlendAttrKind[] => (Array.isArray(v) ? (v as BlendAttrKind[]) : [])
  .filter(k => !!k && typeof k.type === 'string' && typeof k.label === 'string')
  .map(k => ({ ...k, kind: typeof k.kind === 'string' ? k.kind : '' }));

/** 一条快照里的面是增量：非字符串的值、以及页面那句"这张面没了"的空串都不算新面。 */
const faceDelta = (v: unknown): Record<string, string> => {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, url] of Object.entries(v as Record<string, unknown>)) if (typeof url === 'string') out[k] = url;
  return out;
};

const mergeFaces = (prev: Record<string, string>, delta: Record<string, string>): Record<string, string> => {
  const keys = Object.keys(delta);
  if (!keys.length) return prev;
  const next = { ...prev };
  for (const k of keys) {
    // 空串 = 墓碑（页面把这张面的键从行描述符里去掉的那一帧发过来的）；有内容才是这一张的新像素。
    if (delta[k]) next[k] = delta[k];
    else delete next[k];
  }
  return next;
};

/** 特效参数面那一格过界的形状闸。十种 kind 各自要读的字段不同，但每一行都得先报出 key 和一种认得出的
 *  kind —— 摆一根没有控件的行比少一根行更糟，所以这一格丢行不丢整摞。字段级的取值交给控件自己判
 *  （每一颗都写了默认），这里不替注册表重述它的契约。 */
const fxStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const fxNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const fxStrList = (v: unknown): string[] => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
const fxPairs = (v: unknown): [number, number][] => (Array.isArray(v) ? v : [])
  .filter(p => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
  .map(p => [p[0], p[1]] as [number, number]);

const fxRowOf = (r: unknown): BlendFxRow | null => {
  if (!r || typeof r !== 'object') return null;
  const x = r as Record<string, unknown>;
  const key = fxStr(x.key);
  if (!key) return null;
  const base = { key, label: fxStr(x.label), tip: fxStr(x.tip), readout: fxStr(x.readout) };
  switch (x.kind) {
    case 'fold': return { ...base, kind: 'fold', open: x.open === true };
    case 'range': return { ...base, kind: 'range', value: fxNum(x.value), min: fxNum(x.min), max: fxNum(x.max), step: fxNum(x.step) };
    case 'check': return { ...base, kind: 'check', flag: x.flag === true };
    case 'flag': return { ...base, kind: 'flag', flag: x.flag === true, onText: fxStr(x.onText), offText: fxStr(x.offText) };
    case 'color': return { ...base, kind: 'color', value: fxStr(x.value) };
    case 'enum': return { ...base, kind: 'enum', value: fxStr(x.value), options: fxStrList(x.options), labels: fxStrList(x.labels) };
    case 'map': return { ...base, kind: 'map', role: fxStr(x.role), optional: x.optional === true, bound: x.bound === true, missing: x.missing === true, title: fxStr(x.title) };
    case 'dir': return { ...base, kind: 'dir', bound: x.bound === true, missing: x.missing === true, title: fxStr(x.title), types: fxStrList(x.types) };
    case 'lattice': return { ...base, kind: 'lattice', hasGrid: x.hasGrid === true, active: x.active === true, editLabel: fxStr(x.editLabel), hint: fxStr(x.hint) };
    case 'curve': return {
      ...base, kind: 'curve',
      channels: (Array.isArray(x.channels) ? x.channels : []).flatMap((c: unknown) => {
        const cc = (c || {}) as Record<string, unknown>;
        return cc.value ? [{ value: fxStr(cc.value), label: fxStr(cc.label) }] : [];
      }),
      channel: fxStr(x.channel), points: fxPairs(x.points), lut: fxPairs(x.lut), minGap: fxNum(x.minGap),
    };
    default: return null;
  }
};

/** 坐标三样（哪一层、哪一枚容器、第几步）落不齐就当"此刻没有展开的那一步"：宿主那一格整块不摆，
 *  而不是摆出一个回发时找不到主人的面板。 */
const fxOpenOf = (v: unknown): BlendFxOpenStep | null => {
  if (!v || typeof v !== 'object') return null;
  const x = v as Record<string, unknown>;
  const layerId = fxNum(x.layerId);
  const stepId = fxNum(x.stepId);
  const attrId = fxStr(x.attrId);
  if (!layerId || !stepId || !attrId) return null;
  return {
    layerId, attrId, stepId,
    type: fxStr(x.type), label: fxStr(x.label), readout: fxStr(x.readout),
    rows: (Array.isArray(x.rows) ? x.rows : []).flatMap((r: unknown) => {
      const row = fxRowOf(r);
      return row ? [row] : [];
    }),
  };
};

/** 面 attribute 的参数面：坐标两样落不齐就当"笔尖没落在面上"，那一格照旧摆空态 —— 一块没有主人的
 *  下拉比一块不摆的下拉更糟。`trackId` 缺字段回 ''（= 用画好的面），这是页面那份记录的默认。 */
const attrOpenOf = (v: unknown): BlendAttrOpen | null => {
  if (!v || typeof v !== 'object') return null;
  const x = v as Record<string, unknown>;
  const layerId = fxNum(x.layerId);
  const attrId = fxStr(x.attrId);
  if (!layerId || !attrId) return null;
  return { layerId, attrId, type: fxStr(x.type), label: fxStr(x.label), trackId: fxStr(x.trackId) };
};

/** Processor 那一格的描述符：一行一行读回来，读不出形状的行就丢掉 —— 摆一行找不到落点的控件比少一行更糟。
 *  候选（来源 / 落位 / 参数枚举）同样逐枚读：值和短名缺一样就丢那一枚，别摆一条点了什么都不发生的按钮。 */
const procChoicesOf = (v: unknown): BlendProcChoice[] => {
  if (!Array.isArray(v)) return [];
  return v.flatMap((o: unknown) => {
    if (!o || typeof o !== 'object') return [];
    const x = o as Record<string, unknown>;
    const value = typeof x.value === 'string' ? x.value : '';
    const label = typeof x.label === 'string' ? x.label : '';
    if (!value || !label) return [];
    return [{ value, label, tip: typeof x.tip === 'string' ? x.tip : '' }];
  });
};
const procUiOf = (v: unknown): BlendProcessorUi => {
  if (!v || typeof v !== 'object') return { names: [], indices: [], choice: -1, inputs: [], params: [], outputs: [], allowList: false };
  const x = v as Record<string, unknown>;
  // names / indices 平行读：名字挡掉非字符串，下标就跟着名字走，绝不各自 filter（错位比缺一枚更糟）。
  const rawNames = Array.isArray(x.names) ? x.names : [];
  const rawIndices = Array.isArray(x.indices) ? x.indices : [];
  const names: string[] = [];
  const indices: number[] = [];
  rawNames.forEach((n, i) => {
    if (typeof n !== 'string') return;
    names.push(n);
    const idx = rawIndices[i];
    indices.push(typeof idx === 'number' && Number.isFinite(idx) ? Math.round(idx) : -1);
  });
  // 页面给的 choice 是这份列表里的位置；空表恒为 -1，越界就落回第一枚 —— 受控 select 的 value
  // 指向不存在的 option 时浏览器显示空白，比落回第一枚更像"切换失败"。
  let choice = typeof x.choice === 'number' && Number.isFinite(x.choice) ? Math.round(x.choice) : -1;
  if (!names.length) choice = -1;
  else if (choice < 0 || choice >= names.length) choice = 0;
  const inputs: BlendProcInRow[] = (Array.isArray(x.inputs) ? x.inputs : []).flatMap((r: unknown) => {
    if (!r || typeof r !== 'object') return [];
    const o = r as Record<string, unknown>;
    const num = typeof o.num === 'number' ? o.num : NaN;
    const options = procChoicesOf(o.options);
    if (!Number.isFinite(num) || !options.length) return [];
    const st = (o.asset || o.staging) && typeof (o.asset || o.staging) === 'object'
      ? (o.asset || o.staging) as Record<string, unknown> : null;
    const asset = st ? {
      options: (Array.isArray(st.options) ? st.options : []).flatMap((s: unknown) => {
        if (!s || typeof s !== 'object') return [];
        const q = s as Record<string, unknown>;
        return typeof q.id === 'string' ? [{ id: q.id, name: typeof q.name === 'string' ? q.name : '' }] : [];
      }),
      cur: typeof st.cur === 'string' ? st.cur : '',
    } : null;
    return [{
      num, name: typeof o.name === 'string' ? o.name : '', hint: typeof o.hint === 'string' ? o.hint : '',
      type: o.type === 'MASK' ? 'MASK' : 'IMAGE',
      options, cur: typeof o.cur === 'string' ? o.cur : '', asset,
    }];
  });
  const params: BlendProcParamRow[] = (Array.isArray(x.params) ? x.params : []).flatMap((r: unknown) => {
    if (!r || typeof r !== 'object') return [];
    const o = r as Record<string, unknown>;
    const num = typeof o.num === 'number' ? o.num : NaN;
    const kind = o.kind;
    if (!Number.isFinite(num)) return [];
    if (kind !== 'bool' && kind !== 'number' && kind !== 'text' && kind !== 'choices' && kind !== 'select') return [];
    return [{
      num, name: typeof o.name === 'string' ? o.name : '', tip: typeof o.tip === 'string' ? o.tip : '',
      kind, on: o.on === true,
      value: typeof o.value === 'string' ? o.value : (typeof o.value === 'number' ? String(o.value) : ''),
      step: typeof o.step === 'string' ? o.step : '',
      placeholder: typeof o.placeholder === 'string' ? o.placeholder : '',
      options: procChoicesOf(o.options), cur: typeof o.cur === 'string' ? o.cur : '',
    }];
  });
  const outputs: BlendProcOutRow[] = (Array.isArray(x.outputs) ? x.outputs : []).flatMap((r: unknown) => {
    if (!r || typeof r !== 'object') return [];
    const o = r as Record<string, unknown>;
    const num = typeof o.num === 'number' ? o.num : NaN;
    const options = procChoicesOf(o.options);
    if (!Number.isFinite(num) || !options.length) return [];
    return [{
      num, name: typeof o.name === 'string' ? o.name : '', hint: typeof o.hint === 'string' ? o.hint : '',
      options, cur: typeof o.cur === 'string' ? o.cur : '',
    }];
  });
  return { names, indices, choice, inputs, params, outputs, allowList: x.allowList === true };
};

/** Geometry 那一格的快照：一枚记录的世界形状 + 舞台参考图。位置 / 四元数 / 颜色三样里缺一样就把
 *  整枚当成"没有记录"（`desc: null`）—— 摆一个画不出来的舞台比摆一句空态更糟。色值不是 hex 就回
 *  默认那支（与页面 DIR_DEFAULTS.color 一字不差），参考图与版本只是搬运。 */
const geometryUiOf = (v: unknown): BlendGeometryUi => {
  const none: BlendGeometryUi = { on: false, kind: null, desc: null, ref: '', refVersion: 0, canvasW: 0, canvasH: 0 };
  if (!v || typeof v !== 'object') return none;
  const o = v as Record<string, unknown>;
  const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  const d = (o.desc && typeof o.desc === 'object' ? o.desc : null) as Record<string, unknown> | null;
  const p = d && d.position && typeof d.position === 'object' ? d.position as Record<string, unknown> : null;
  const q = d && d.rotation && typeof d.rotation === 'object' ? d.rotation as Record<string, unknown> : null;
  const pos = p && fin(p.x) && fin(p.y) && fin(p.z) ? { x: p.x, y: p.y, z: p.z } : null;
  const rot = q && fin(q.x) && fin(q.y) && fin(q.z) && fin(q.w) ? { x: q.x, y: q.y, z: q.z, w: q.w } : null;
  const color = d && /^#[0-9a-fA-F]{6}$/.test(String(d.color || '')) ? String(d.color) : '';
  const desc: BlendGeometryDesc | null = o.on === true && pos && rot
    ? { position: pos, rotation: rot, color: color || '#ff2e88' }
    : null;
  return {
    on: !!desc,
    kind: typeof o.kind === 'string' && o.kind ? o.kind : null,
    desc,
    ref: typeof o.ref === 'string' ? o.ref : '',
    refVersion: fin(o.refVersion) ? o.refVersion : 0,
    canvasW: fin(o.canvasW) ? Math.max(0, Math.round(o.canvasW)) : 0,
    canvasH: fin(o.canvasH) ? Math.max(0, Math.round(o.canvasH)) : 0,
  };
};

/** Pose 那一格的快照：一枚记录的形态/姿态/取景/皮肤形状 + 目标层原生尺寸。desc 逐字段兜住 —— 七参
 *  与取景五格是要有限数、姿态三样（bones / bonePositions / modelRotation）缺一样就整枚当"没有记录"
 *  （`desc: null`）。色值不是 hex 就回白（与页面 POSE_COLOR_DEFAULT 一字不差），皮肤档不在那三档里
 *  就回 dummy_white，层面尺寸收成非负整数。 */
const POSE_SKINS = ['naked', 'naked_marks', 'dummy_white'];
const poseUiOf = (v: unknown): BlendPoseUi => {
  const none: BlendPoseUi = { on: false, desc: null, layerW: 0, layerH: 0 };
  if (!v || typeof v !== 'object') return none;
  const o = v as Record<string, unknown>;
  const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  const d = (o.desc && typeof o.desc === 'object' ? o.desc : null) as Record<string, unknown> | null;
  if (o.on !== true || !d) return none;

  const mi = (d.mesh && typeof d.mesh === 'object' ? d.mesh : null) as Record<string, unknown> | null;
  const MESH = ['age', 'gender', 'weight', 'muscle', 'height', 'breast_size', 'firmness'] as const;
  if (!mi || !MESH.every(k => fin(mi[k]))) return none;
  const mesh: BlendPoseDesc['mesh'] = {
    age: mi.age as number, gender: mi.gender as number, weight: mi.weight as number, muscle: mi.muscle as number,
    height: mi.height as number, breast_size: mi.breast_size as number, firmness: mi.firmness as number,
  };
  if (mi.show_genitals === true) mesh.show_genitals = true;

  const ci = (d.cam && typeof d.cam === 'object' ? d.cam : null) as Record<string, unknown> | null;
  const CAM = ['yaw', 'pitch', 'zoom', 'offsetX', 'offsetY'] as const;
  if (!ci || !CAM.every(k => fin(ci[k]))) return none;
  const cam = {
    yaw: ci.yaw as number, pitch: ci.pitch as number, zoom: ci.zoom as number,
    offsetX: ci.offsetX as number, offsetY: ci.offsetY as number,
  };

  const pi = (d.pose && typeof d.pose === 'object' ? d.pose : null) as Record<string, unknown> | null;
  if (!pi) return none;
  const triple = (raw: unknown): Record<string, [number, number, number]> => {
    const out: Record<string, [number, number, number]> = {};
    if (raw && typeof raw === 'object') {
      for (const [k, r] of Object.entries(raw as Record<string, unknown>)) {
        if (Array.isArray(r) && r.length >= 3 && r.slice(0, 3).every(fin)) {
          out[k] = [r[0] as number, r[1] as number, r[2] as number];
        }
      }
    }
    return out;
  };
  const bones = triple(pi.bones);
  const bonePositions = triple(pi.bonePositions);
  const mr = Array.isArray(pi.modelRotation) ? pi.modelRotation : [];
  const modelRotation: [number, number, number] = mr.length >= 3 && mr.slice(0, 3).every(fin)
    ? [mr[0] as number, mr[1] as number, mr[2] as number] : [0, 0, 0];

  const skin = POSE_SKINS.includes(String(d.skin)) ? String(d.skin) : 'dummy_white';
  const color = /^#[0-9a-fA-F]{3,8}$/.test(String(d.color || '')) ? String(d.color) : '#ffffff';
  let bg: [number, number, number] | null = null;
  if (Array.isArray(d.bg) && d.bg.length === 3 && d.bg.every(fin)) {
    bg = d.bg.slice(0, 3).map(c => Math.max(0, Math.min(255, Math.round(c as number)))) as [number, number, number];
  }
  return {
    on: true,
    desc: { mesh, pose: { bones, bonePositions, modelRotation }, cam, skin, color, bg },
    layerW: fin(o.layerW) ? Math.max(0, Math.round(o.layerW)) : 0,
    layerH: fin(o.layerH) ? Math.max(0, Math.round(o.layerH)) : 0,
  };
};

/** Staging 那一格的快照：那条底栏里"属于页面"的三样 —— Extra Prompt 的序列化字符串（页面只留它这
 *  一份，.cud 与 run payload 都读它）、空态占位句（blend-config 的 tagDisabledHint 会覆写它）、以及
 *  run 的状态（busy / Cancel 该不该浮 / 进度，progress < 0 = 未知）。图池条目与两张钉卡预览不进这一格
 *  —— 它们本就是宿主的（App.staging 与这里的 blendPreview）。缺字段一律回"没说过"：占位句回页面那句
 *  默认、hasTagger 只有在页面明说 false 时才是假。 */
const stagingUiOf = (v: unknown): BlendStaging => {
  const base = EMPTY_BLEND_UI.staging;
  if (!v || typeof v !== 'object') return base;
  const o = v as Record<string, unknown>;
  return {
    prompt: typeof o.prompt === 'string' ? o.prompt : '',
    placeholder: typeof o.placeholder === 'string' && o.placeholder ? o.placeholder : base.placeholder,
    busy: o.busy === true,
    cancelLive: o.cancelLive === true,
    progress: typeof o.progress === 'number' && Number.isFinite(o.progress) ? o.progress : -1,
    hasTagger: o.hasTagger !== false,
  };
};

const App: React.FC = () => {
  const [tab, setTab] = useState<Tab>('draw');
  const tabRef = useRef<Tab>('draw');
  useEffect(() => { tabRef.current = tab; }, [tab]);

  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [promptReady, setPromptReady] = useState(false);
  const [detailStatus, setDetailStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [staging, setStaging] = useState<StagingItem[]>([]);
  const [showFinishDialog, setShowFinishDialog] = useState(false);
  const [finished, setFinished] = useState(false);
  const [syncingTab, setSyncingTab] = useState(false);
  const syncingTabRef = useRef(false);
  useEffect(() => { syncingTabRef.current = syncingTab; }, [syncingTab]);
  // Track whether the latest prompt-confirmed was consumed by handleTabChange sync
  const consumedPromptConfirmedRef = useRef(false);
  const [interfaces, setInterfaces] = useState<InterfaceInfo[]>([]);
  const [pipelinePackages, setPipelinePackages] = useState<PipelinePackageInfo[]>([]);
  /** Draw 页 Pipeline Settings：只剩选中项。`overrides` 是旧版按 pipeline 名字存的那批覆盖，
   *  界面不再编辑，整份对象只原样回写（见 types.ts）。 */
  const [pipelineSettings, setPipelineSettings] = useState<PipelineSettings>(EMPTY_PIPELINE_SETTINGS);
  /** Interface tab 给每个 interface 配置的持久化标注：端口改名 / 模式开关 / block 端口绑定 */
  const [interfaceMeta, setInterfaceMeta] = useState<InterfaceMeta>({});
  /** Settings tab 的 user preference：执行到节点时的打开方式。开 = KolidUI 不在就把
   *  Kolid Desktop.exe 拉起来再注入；关 = 原逻辑（在就注入，不在退浏览器）。 */
  const [openWithApp, setOpenWithApp] = useState(false);
  /** 此刻真正加载在节点上的 pipeline 名字（'' = 节点输入口那条 = [Default]） */
  const [loadedPipelineName, setLoadedPipelineName] = useState('');
  // Processor 运行（工作台 Tools → Processor 发起，现在也是 interface 唯一的执行入口）：
  // 走后端的 interface_status，有自己的轮询与回程通道 —— 结果按端口送回工作台落位。
  const [processorRunning, setProcessorRunning] = useState(false);
  const processorRunRef = useRef<number | null>(null);
  // A Query block parked mid-run: the chain is blocked until the user answers (or cancels).
  const [pendingQuery, setPendingQuery] = useState<PendingQuery | null>(null);
  // Enable Edit 下 prompt 引用的 <Image2>… 缺 ref image：后端拒绝启动本次 run，本页弹窗
  // 让用户从工作区补图（补完写回工作台 Extra Prompt 并重跑）。见 handleRefConfirm。
  const [refRequest, setRefRequest] = useState<{ need: number; have: number; action: 'blend' | 'layer'; body: Record<string, any> } | null>(null);
  const [refSel, setRefSel] = useState<string[]>([]);
  /**
   * 最近 32 条行为记录。工作台画布顶部那颗常显的状态药丸已经撤掉，它每次说话都改发一条
   * 'blend-log' 到这里；本页自己触发的动作（跑 preset / Execute / 取消 / 载入 / Query）也写进
   * 同一份列表，由 Context 标题行的 Log 按钮展开。
   */
  const [actionLog, setActionLog] = useState<ActionLogEntry[]>([]);
  const pushLog = useCallback((text: string, kind: ActionLogEntry['kind'] = '') => {
    if (!text) return;
    setActionLog(prev => [...prev, { at: Date.now(), text, kind }].slice(-32));
  }, []);
  const promptIframeRef = useRef<HTMLIFrameElement>(null);
  // Prompt tab 那份 LoRA 卡是 iframe 自己在 mount 时拉的副本：后端换 pipeline 时把 lora_regex
  // 换了代（并重扫了磁盘），这页看不见。`loraEpochRef` = 本页已知的当前代数，
  // `promptLoraEpochRef` = 那份副本是哪一代拉的，两者不等就是脏 —— 只在这一刻才让它重拉。
  const loraEpochRef = useRef(0);
  const promptLoraEpochRef = useRef(0);
  // 唯一的一处「让 Prompt tab 跟上现在的 pipeline」。`fromServer` = 先现拉一次 /api/config 才比
  // 代数：进 tab 那一趟要用它，因为 /api/status 只在运行中轮询，闲置时本页手上的代数可能是旧的。
  // 走 iframe 现成的 'reload-lora-data'（只重拉 lora，保住这一页没保存的选择），不是全量
  // 'kolid-reload-data'（那会把选择整片清空）。
  const flushPromptPipeline = useCallback(async (fromServer = false) => {
    if (fromServer) {
      try {
        const cfg: ServerConfig = await fetch('/api/config').then(r => r.json());
        if (typeof cfg?.pipeline_lora_epoch === 'number') loraEpochRef.current = cfg.pipeline_lora_epoch;
      } catch { /* 问不到就不动，下一次进 tab 再问 */ }
    }
    if (loraEpochRef.current === promptLoraEpochRef.current) return;
    const win = promptIframeRef.current?.contentWindow;
    // 记"已送达"要在真发出去之后：iframe 还没挂上就先把基线抬走，这一代就永远没人补了。
    if (!win) return;
    promptLoraEpochRef.current = loraEpochRef.current;
    win.postMessage({ type: 'reload-lora-data' }, '*');
  }, []);
  // The Blend workbench stays mounted for the whole session: it owns the layer stack and the
  // Mask layer, which would be lost if React unmounted it on every tab switch.
  const blendIframeRef = useRef<HTMLIFrameElement>(null);
  // The documents the workbench holds open, as the host draws them: one dock window each, one of them
  // the live one. The iframe owns them — this is only the mirror it re-sends whenever the list, the
  // active one or the IO lock changes.
  const [blendDocs, setBlendDocs] = useState<BlendDocs>(EMPTY_BLEND_DOCS);
  // 会话恢复的闸门：开机对盘上活动集的那次问询结束前，播报不落盘（否则工作台的空播报
  // 会把记录抢先覆写成空，恢复永远读到空）。写口在 blend-docs 播报处。
  const restoreGate = useRef(false);
  // 恢复在途的期望份数：>0 = restore 还没导完。中途播报（每导入一份就来一趟）是**部分**
  // 活动集，写回盘上会把记录截断 —— 一次恰好落在恢复中途的刷新就只能恢复出一半。
  const restorePending = useRef(0);
  // The last frame each document showed before it stopped being the live one. The engine is one per
  // page, so this is all a background window can show until the engine is scoped per document.
  const [docStills, setDocStills] = useState<Record<number, string>>({});
  const sendDocCommand = useCallback((action: BlendDocCommand, uid?: number) => {
    blendIframeRef.current?.contentWindow?.postMessage(
      { type: 'blend-doc-command', action, uid: uid === undefined ? null : uid }, '*');
  }, []);
  // 图层 / 工具 / 属性面板搬进宿主之后，控件按下的那一下发这一条；页面里那张 UI_COMMANDS 表是它唯一
  // 的落点 —— 一个动作仍然只有一个执行处，只是按下的人换了地方。载荷由 `BlendUiSend` 那个泛型绑死：
  // 旋钮是一个数、档位是一个词、行上的一下是一枚坐标（哪一层、哪一枚 chip、落在谁的哪一侧）、可见区是
  // 一串键。页面对它做的和被删掉的那颗 <input> 做的是同一行调用。
  const sendBlendUiCommand: BlendUiSend = useCallback(<A extends BlendUiAction,>(action: A, value?: BlendUiPayloads[A]) => {
    // 命令带着**此刻的活跃文档** uid 出门（拍板③）：页面按它校验 —— 攒在事件队列里的过期命令
    // （用户按下之后、执行之前切了 tab）会被页面当垃圾丢掉，不再打进刚切走的文档。
    blendIframeRef.current?.contentWindow?.postMessage(
      { type: 'blend-ui-command', uid: getActiveBlendUid(), action, value }, '*');
  }, []);
  const stagingRef = useRef<StagingItem[]>([]);
  useEffect(() => { stagingRef.current = staging; }, [staging]);
  // Which detailer result has already been handed to the workbench. The done branch below is
  // reached from a 500 ms poll and runs three requests (the history payload is big), so a second
  // tick can arrive before React has torn the interval down — and injecting one key twice put two
  // identical layers on the canvas, which the user then cannot get rid of by deleting one.
  const injectedDetailKeyRef = useRef<string | null>(null);
  // A layer-initiated Generate writes its result back into that layer instead of adding a new one.
  // The poller cannot tell the two apart from the status alone, so the target is parked here while
  // the run is in flight and consumed once, in the `done` branch.
  const layerGenerateRef = useRef<{ layerId: number } | null>(null);

  const defaultBlockParams: DetailerBlockParams = {
    add_noise: 'enable',
    start_step_rate: 0.8,
    end_step_rate: 1.0,
    pixels: 1048576,
    align: 8,
    crop_reserve: 32,
    recover_crop: true,
    enable_edit: false,
    edit_mode: 'fit' as const,
    ref_boost: 4.0,
    ref_boost_a: 1.0,
    enable_ref_boost_mask: false,
    grounding_px: 768,
    // Ref 图不再逐块配置：Blend 工作台 Extra Prompt 文本里的 <image_id:...> 标记
    // 在 Run 时统一解析，所有 detailer block 共用。
    context_regex: '.+',
  };
  // 每套链都保证带 `graph`：旧数据（只有 blocks）就地迁移；新数据原样用。
  // **载入即净化**：sanitizeGraph 把悬空边 / 端口不存在 / kind 不匹配 / 重复边 / exec 环
  // 全丢掉（缺 Start/End 就补），保证进来的图一定是合法的。
  const normalizeSet = useCallback((s: BlockSet): BlockSet => {
    const raw: PipelineGraph = (s.graph && Array.isArray(s.graph.nodes))
      ? s.graph
      : blocksToGraph(s.blocks ?? []);
    const g = sanitizeGraph(raw);
    return { ...s, graph: g, blocks: graphToBlocks(g) };
  }, []);
  // Multi-set Pipeline Blocks ("tabs" in the workbench). The ACTIVE set's blocks ARE the working
  // chain — everything downstream (EditPhase's list, /api/update_config, the Blend workbench's
  // block list) sees only that flat array; the sets are the storage layer wrapped around it.
  const [blockSets, setBlockSets] = useState<BlockSet[]>([
    normalizeSet({ id: 'set-1', name: 'Default', blocks: [
      { id: 'block-1', type: 'detailer', name: 'Detailer', params: { ...defaultBlockParams } },
    ] }),
  ]);
  const [activeBlockSetId, setActiveBlockSetId] = useState<string>('set-1');
  const blockSetIdCounter = useRef(2);
  const blocks = useMemo(
    () => blockSets.find(s => s.id === activeBlockSetId)?.blocks ?? blockSets[0]?.blocks ?? [],
    [blockSets, activeBlockSetId]);
  // 图视图编辑的是**激活那套的图**；老数据没图时现由 blocks 迁移一份（只读兜底）。
  const activeGraph = useMemo<PipelineGraph>(
    () => blockSets.find(s => s.id === activeBlockSetId)?.graph ?? blocksToGraph(blocks),
    [blockSets, activeBlockSetId, blocks]);
  const [architecture, setArchitecture] = useState<string | null>(null);
  const [maskGrow, setMaskGrow] = useState(32);
  const [maskBlur, setMaskBlur] = useState(32);
  // DEFAULT SETTING（Settings 页）：所有 preset 共享（server config 持久化）
  const [cropReserve, setCropReserve] = useState(32);
  const [pixelsVal, setPixelsVal] = useState(1048576);
  const [alignVal, setAlignVal] = useState(8);
  // 输入侧显存封顶四件套 —— pixels 是**上限**（只压不涨），0 = 不设上限
  const [refPixelsVal, setRefPixelsVal] = useState(1048576);
  const [refAlignVal, setRefAlignVal] = useState(8);
  const [tgenPixelsVal, setTgenPixelsVal] = useState(1048576);
  const [tgenAlignVal, setTgenAlignVal] = useState(8);
  const blockIdCounter = useRef(2);
  // 架构规则整份（顺序 = 优先级）：与 pipeline_settings 同一条落盘路径。
  const [archSettings, setArchSettings] = useState<ArchSettings>(EMPTY_ARCH_SETTINGS);
  const archRuleIdCounter = useRef(2);

  // Fetch config on mount
  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then((data: ServerConfig) => {
        setConfig(data);
        setMaskGrow(data.mask_grow);
        setMaskBlur(data.mask_blur);
        setCropReserve(data.crop_reserve);
        setPixelsVal(data.pixels);
        setAlignVal(data.align);
        setRefPixelsVal(data.ref_pixels ?? 1048576);
        setRefAlignVal(data.ref_align ?? 8);
        setTgenPixelsVal(data.tgen_pixels ?? 1048576);
        setTgenAlignVal(data.tgen_align ?? 8);
        if (Array.isArray(data.blocks_sets)) {
          setBlockSets(data.blocks_sets.map(normalizeSet));
          setActiveBlockSetId(
            data.active_block_set && data.blocks_sets.some((s: BlockSet) => s.id === data.active_block_set)
              ? data.active_block_set
              : (data.blocks_sets[0]?.id ?? ''));
        } else if (data.blocks && data.blocks.length > 0) {
          // Legacy config without sets: wrap the flat chain into a single Default tab.
          setBlockSets([normalizeSet({ id: 'set-1', name: 'Default', blocks: data.blocks })]);
          setActiveBlockSetId('set-1');
        } else if (data.graph && Array.isArray(data.graph.nodes)) {
          // 新格式但还没分 set：把图包成一个 Default tab。
          setBlockSets([normalizeSet({ id: 'set-1', name: 'Default', blocks: data.blocks ?? [], graph: data.graph })]);
          setActiveBlockSetId('set-1');
        }
        // Counters restart at 2 each load; skip past ids already persisted on the server,
        // otherwise "New tab" after a refresh mints an id that collides with an existing set.
        const maxIdSuffix = (ids: string[], prefix: string) =>
          ids.reduce((m, id) => { const n = parseInt(id.slice(prefix.length), 10); return Number.isFinite(n) ? Math.max(m, n) : m; }, 1);
        const allSets: BlockSet[] = Array.isArray(data.blocks_sets)
          ? data.blocks_sets
          : [{ id: 'set-1', name: 'Default', blocks: data.blocks ?? [] }];
        blockSetIdCounter.current = Math.max(2, maxIdSuffix(allSets.map(s => s.id), 'set-') + 1);
        blockIdCounter.current = Math.max(2, maxIdSuffix(allSets.flatMap(s => (s.blocks ?? []).map(b => b.id)), 'block-') + 1);
        // 架构规则同一套记账：计数器跳过服务端已有的 arch-N，刷新后新建才不会撞号。
        const archRules: ArchRule[] = data.arch_settings?.rules ?? [];
        setArchSettings({ rules: archRules });
        archRuleIdCounter.current = Math.max(2, maxIdSuffix(archRules.map(r => r.id), 'arch-') + 1);
        setDetailStatus(data.detail_status);
        setArchitecture(data.architecture ?? null);
        setPipelineSettings(data.pipeline_settings ?? EMPTY_PIPELINE_SETTINGS);
        setInterfaceMeta(data.interface_meta ?? {});
        setOpenWithApp(!!data.open_with_app);
        setLoadedPipelineName(data.loaded_pipeline_name ?? '');
        // Prompt iframe 此刻才被挂上（src 就是这一份 config 里的 prompt_url），它拉的就是这一代
        // 的 lora_regex —— 两枚代数从这里同时起步。
        loraEpochRef.current = promptLoraEpochRef.current = data.pipeline_lora_epoch ?? 0;
        if (data.has_package) {
          fetch('/api/package')
            .then(r => r.json())
            .then(pkgData => {
              if (pkgData.interfaces) setInterfaces(pkgData.interfaces);
            })
            .catch(() => {});
        }
        if (data.has_pipeline_package) {
          fetch('/api/pipeline_package')
            .then(r => r.json())
            .then(pkgData => {
              if (pkgData.pipeline_packages) setPipelinePackages(pkgData.pipeline_packages);
            })
            .catch(() => {});
        }
      })
      .catch(e => setError('Failed to load config: ' + e.message));
  }, []);

  // Fetch the staging pool on mount (the workbench strip + every picker read it).
  // hidden 条目（run/接口的生成产出、Original 种子）只供内部按 id 取图 —— 工作区
  // 镜像（本条带 + Blend 工作台 + 所有选择器）只展示用户主动拖入/导入的图。
  const refreshStaging = useCallback((): Promise<void> => {
    return fetch('/api/staging')
      .then(r => r.json())
      .then(data => {
        if (data.staging) setStaging(data.staging.filter((s: StagingItem) => !s.hidden));
      })
      .catch(() => {});
  }, []);

  useEffect(() => { refreshStaging(); }, [refreshStaging]);

  // 后端图池的一切变更走同一条 promise 链：打开/切换工程会整池 replace 上传（每条都是
  // 几 MB 的 base64，服务端逐张 decode 要跑好几秒），这条链若和拖文件、guidance 卡、
  // 单条移除并行跨连接竞，后端最后留下的池会取决于完成顺序而不是发起顺序。串行化保证
  // 「最后发起的 = 最后落地的」。
  const stagingChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const queueStaging = useCallback((op: () => Promise<unknown>) => {
    const run = () => op().catch(() => {});
    stagingChainRef.current = stagingChainRef.current.then(run, run);
  }, []);

  // 图池的两个后端写口，直接摆在宿主里：工作台那条 Staging 底栏拖文件进来 / ✕ 移除时调用，不再绕
  // iframe 消息。落到同一条串行链、同一个 /api/staging(_remove)，与下面那条消息分支的语义一字不差。
  const stageUpload = useCallback((images: string[], names: string[]) => {
    if (!images.length) return;
    queueStaging(() => fetch('/api/staging', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images, names, name: 'Loaded' }),
    }).then(() => refreshStaging()));
  }, [queueStaging, refreshStaging]);

  const stageRemove = useCallback((id: string) => {
    if (!id) return;
    queueStaging(() => fetch('/api/staging_remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).then(() => refreshStaging()));
  }, [queueStaging, refreshStaging]);

  // Push staging list changes into the Blend workbench (its strip renders from this mirror).
  useEffect(() => {
    blendIframeRef.current?.contentWindow?.postMessage({
      type: 'blend-staging',
      items: staging,
    }, '*');
  }, [staging]);

  // Processor 工具的可选接口（Interface tab 里开着 Processor 模式的那些）→ 工作台。
  // 两个时机都必须推，缺一个就会「枚举看起来不刷新」：
  //   (a) 列表本身变了 —— 开关 / 改名 / 端口改动（见下面那个 effect）；
  //   (b) 工作台 iframe load 完来要 init 时（见 blend-request-init 分支）—— 首次进前端
  //       时 (a) 常常跑在 iframe 的 document 就绪之前，那条消息会打进 about:blank 里丢掉，
  //       Processor 的 Interface 枚举就一直空着，只有回 Interface tab 重拨一下开关才刷出来。
  // modes 以 interfaceMeta 为准：开关一拨，前端这份 meta 立刻是真值，而 interfaces 是后端
  // 快照（toggle 只 POST 配置、不重拉 /api/package），照它过滤会把刚打开的接口又滤掉。
  const pushProcessors = useCallback(() => {
    const win = blendIframeRef.current?.contentWindow;
    if (!win) return;
    const processors = interfaces
      .filter(itf => {
        const modes = interfaceMeta[itf.name]?.modes;
        return modes ? !!modes.processor : !!itf.modes?.processor;
      })
      .map(itf => ({
        name: itf.name,
        index: interfaces.indexOf(itf),
        start_ports: itf.start_ports,
        end_ports: itf.end_ports,
        // image/mask 出口的默认落位与入口的默认来源:工作台拿它们当 Processor 小窗里对应行的
        // 初值 (meta 里的 output_targets / input_sources,/api/package 已按名字合并进 itf)。
        output_targets: itf.output_targets || interfaceMeta[itf.name]?.output_targets || {},
        input_sources: itf.input_sources || interfaceMeta[itf.name]?.input_sources || {},
        // Allow List：开着时 image 输入行多一枚 Video 候选（视频模式逐帧拆 list），输出也是 list。
        allow_list: !!(itf.allow_list ?? interfaceMeta[itf.name]?.allow_list),
      }));
    win.postMessage({ type: 'blend-processors', processors }, '*');
  }, [interfaces, interfaceMeta]);

  // Leaving the prompt tab flushes the prompt editor into prompt_server first.
  const handleTabChange = useCallback((newTab: Tab) => {
    const needPromptSync = tab === 'prompt' && newTab !== 'prompt';
    if (!needPromptSync) {
      setTab(newTab);
      // 打开 Prompt tab = 主动对一次账：这一页显示不显示是用户说了算，程序不该替他留着脏数据。
      if (newTab === 'prompt') void flushPromptPipeline(true);
      return;
    }
    setSyncingTab(true);
    const targetTab = newTab;
    let syncDone = false;
    const checkSyncDone = (event: MessageEvent) => {
      if (event.data?.type !== 'prompt-synced') return;
      syncDone = true;
      window.removeEventListener('message', checkSyncDone);
      setSyncingTab(false);
      consumedPromptConfirmedRef.current = true;
      setTab(targetTab);
    };
    window.addEventListener('message', checkSyncDone);
    const iframe = promptIframeRef.current;
    if (iframe?.contentWindow) iframe.contentWindow.postMessage({ type: 'sync-prompt' }, '*');
    // Timeout fallback
    setTimeout(() => {
      if (syncDone) return;
      window.removeEventListener('message', checkSyncDone);
      setSyncingTab(false);
      setTab(targetTab);
    }, 3000);
  }, [tab]);

  // Poll prompt status (fallback)
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/has_prompt');
        const data = await res.json();
        if (!cancelled) setPromptReady(!!data.has_prompt);
      } catch { /* ignore */ }
    };
    poll();
    const interval = setInterval(poll, PROMPT_POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Poll while the detailer runs, and drive the Blend workbench from the result.
  useEffect(() => {
    if (detailStatus !== 'running') return;
    let cancelled = false;
    let idleTicks = 0;               // the action may not have reached the main loop yet
    const post = (payload: Record<string, any>) => {
      blendIframeRef.current?.contentWindow?.postMessage({ type: 'blend-run-status', ...payload }, '*');
    };
    const poll = async () => {
      try {
        const res = await fetch('/api/status');
        const data: StatusResponse = await res.json();
        if (cancelled) return;
        // A Query block parks the run: open its dialog as soon as the backend says so, and
        // let the same field going back to null close it (answered / cancelled / aborted).
        setPendingQuery(data.pending_query || null);
        const st = data.detail_status;
        if (st === 'cancelled') {
          // 工作台的 Cancel 打断了本次运行：通知工作台复位，本页状态回 idle。
          post({ status: 'cancelled' });
          setDetailStatus('idle');
          return;
        }
        if (st === 'idle') {
          // The backend has not picked the action up yet. Keep waiting, but do not hang forever
          // if the main loop is stuck on something else (e.g. an interface run).
          if (++idleTicks > 40) {
            setDetailStatus('error');
            post({ status: 'error', error: 'The detailer never started' });
            setError('The detailer never started');
          }
          return;
        }
        const progress = {
          progress: data.progress || 0,
          current: data.current_step || 0,
          total: data.total_steps || 0,
        };
        setDetailStatus(st);
        // 一条 preset 绑定的 pipeline 是在 run 循环里现加载的：名字与架构都会跟着变，
        // 轮询顺手同步，前端就不用再拉一次 config。
        if (typeof data.loaded_pipeline_name === 'string') setLoadedPipelineName(data.loaded_pipeline_name);
        if (data.architecture !== undefined) setArchitecture(data.architecture ?? null);
        // 同一趟 run 里 lora_regex 也可能换了代（后端已经跟着重扫过 lora 了）：Prompt tab 开着
        // 的话这一代当场送过去，别等用户下次进那个 tab。
        if (typeof data.pipeline_lora_epoch === 'number') loraEpochRef.current = data.pipeline_lora_epoch;
        void flushPromptPipeline();
        // 同一趟里 lora_regex 也可能换了代（prompt server 已经跟着重扫过了）：Prompt tab 开着
        // 的话这一代要当场送过去，别等用户下次进那个 tab。
        if (typeof data.pipeline_lora_epoch === 'number') loraEpochRef.current = data.pipeline_lora_epoch;
        void flushPromptPipeline();
        if (st === 'running') {
          post({ status: 'running', ...progress });
        } else if (st === 'error') {
          post({ status: 'error', error: data.error || 'Detailer failed' });
          setError(data.error || 'Detailer failed');
        } else if (st === 'done') {
          post({ status: 'done' });
          // Kolid Desktop 的壳页监听 {__kolid:'tinkle'}:pipeline blocks 整链跑完,
          // 壳按铃铛开关响铃。浏览器直开时 parent 是自己,这条消息无人听,无副作用。
          try { window.parent.postMessage({ __kolid: 'tinkle', event: 'pipeline-done' }, '*'); } catch { /* ignore */ }
          // The result never becomes the pipeline image by itself: it lands in the staging pool
          // and then either is appended onto the layer it came from as one more Image step
          // (a layer-initiated Generate) or dropped on as a new layer (a preset run).
          const generateTarget = layerGenerateRef.current;
          layerGenerateRef.current = null;
          await refreshStaging();
          try {
            const result = await fetch('/api/result').then(r => r.json());
            const sid = result?.detailed_key;
            if (!sid || injectedDetailKeyRef.current === sid) return;
            injectedDetailKeyRef.current = sid;      // claimed before the awaits below, not after
            const list = await fetch('/api/staging').then(r => r.json());
            const item = (list?.staging || []).find((s: StagingItem) => s.id === sid);
            if (!item) return;
            if (generateTarget) {
              // The result goes back to the layer it came from as one more Image step on its
              // strip: the layer keeps its base pixels, mask and chains, and the new image is
              // placed where the backend drew it. No new layer, nothing overwritten.
              blendIframeRef.current?.contentWindow?.postMessage(
                { type: 'blend-append-image', layer_id: generateTarget.layerId, items: [item] }, '*');
            } else {
              blendIframeRef.current?.contentWindow?.postMessage({ type: 'blend-add-layer', items: [item] }, '*');
            }
          } catch { /* the layer is a convenience, not a hard requirement */ }
        }
      } catch { /* ignore */ }
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(interval); };
  }, [detailStatus, refreshStaging]);

  // Flush the prompt editor into prompt_server. The detailer reads the prompt from there, so a
  // A run must not start while the prompt editor still holds unsaved edits.
  const syncPrompt = useCallback((): Promise<void> => {
    return new Promise((resolve) => {
      const iframe = promptIframeRef.current;
      if (!iframe?.contentWindow) { resolve(); return; }
      let done = false;
      const handler = (event: MessageEvent) => {
        if (event.data?.type === 'prompt-synced') {
          done = true;
          window.removeEventListener('message', handler);
          resolve();
        }
      };
      window.addEventListener('message', handler);
      iframe.contentWindow.postMessage({ type: 'sync-prompt' }, '*');
      setTimeout(() => {
        if (!done) {
          window.removeEventListener('message', handler);
          resolve();
        }
      }, 3000);
    });
  }, []);

  // The Blend workbench asks for its seed image so the canvas is never empty. The run's
  // initial image lands in the pool as a HIDDEN 'Original' entry — hidden entries never
  // reach the workbench strip, so the seed must read the full /api/staging list, falling
  // back to the newest user item.
  const seedBlendCanvas = useCallback(async () => {
    const iframe = blendIframeRef.current;
    if (!iframe?.contentWindow) return;
    // 会话恢复优先于播种：上一次会话开着的那批 .cud（宿主在每次播报后写盘，见下面的
    // effect）整批按原打开序重开 —— 刷新后文档窗口原地认领保留位，而不是留一排 Untitled
    // 幽灵 tab。描述符由服务端从自己写下的记录里造，页面照样说不出路径。恢复成功就不再
    // 播种管线图：工程的图层来自 .cud 自己，再把池里的图铺一层只会污染刚恢复的工程。
    try {
      const r = await fetch('/api/open_cuds').then(r => r.json());
      const docs = (r?.docs || []) as BlendDoc[];
      if (docs.length) {
        restorePending.current = docs.length;
        // 兜底：某一份导入失败时播报永远到不了期望数，30s 后放行记账（之后来什么播什么）。
        setTimeout(() => { restorePending.current = 0; }, 30000);
        iframe.contentWindow.postMessage({ type: 'blend-restore-cuds', docs }, '*');
        return;
      }
    } catch { /* no record, no backend — fall through to seeding */ }
    finally {
      // 恢复问询结束（无论读没读到）才允许播报落盘：工作台开机的那趟**空播报**如果抢在
      // 前面，盘上的活动集会先被覆写成空 —— 恢复就永远读到一份空记录。
      restoreGate.current = true;
    }
    let full: StagingItem[] = [];
    try {
      const r = await fetch('/api/staging').then(r => r.json());
      full = (r?.staging || []) as StagingItem[];
    } catch { /* nothing to seed with */ }
    if (!full.length) {
      // Nothing to seed with = the pipeline carried no image. The workbench then reopens the
      // last .cud *this machine* chose in the file dialog: the backend holds that record and
      // mints the token for it, so the page never names a path. Whether it succeeds or refuses,
      // the workbench says so in its own status line — that's where Load reports live.
      try {
        const r = await fetch('/api/recent_cud').then(r => r.json());
        iframe.contentWindow.postMessage(
          { type: 'blend-reopen-cud', doc: r?.doc || null, reason: r?.reason || '' }, '*');
      } catch { /* no record, no backend — the canvas simply stays empty */ }
      return;
    }
    const item = full.find(s => s.name === 'Original')
      ?? stagingRef.current[stagingRef.current.length - 1]
      ?? full[full.length - 1];
    if (!item) return;
    iframe.contentWindow.postMessage({
      type: 'blend-init-layer',
      items: [{ name: item.name, src: item.src, place: item.place }],
    }, '*');
  }, []);

  /**
   * Single entry point for the workbench toolbar. The backend composites the canvas
   * (blend_action) and then either archives it, tags it, or hands it to the detailer —
   * the composite is the Context Image, so nothing here switches context.
   */
  const handleBlendAction = useCallback(async (body: Record<string, any>) => {
    setError(null);
    // Several document windows can be open now, so a run has to say which canvas its pixels came out
    // of. The workbench stamps the document it was looking at into the payload; this only reads it out.
    if (body?.doc?.name) pushLog(`Run on 「${body.doc.name}」`);
    const reply = (success: boolean, extra: Record<string, any> = {}) => {
      blendIframeRef.current?.contentWindow?.postMessage(
        { type: 'blend-action-result', action: body?.action, success, ...extra }, '*');
    };
    // A run reads the prompt from prompt_server, so flush the editor first.
    if (body.action === 'detailer') await syncPrompt();
    try {
      const res = await fetch('/api/blend_action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: body.action,
          tag_mode: body.tag_mode,
          layers: body.layers,
          // attribute 面表：图层那条只剩表键，共享的一面只编码一份，所以这张表必须跟着包走 ——
          // 漏转发 = 后端认不出键 = 条带上归它重放的那一段整段消失（静默，画面少了蒙版/贴片）。
          attributes: body.attributes ?? [],
          width: body.width,
          height: body.height,
          mask: body.mask,
          // detailer：blendCanvas 已合成好的 PNG dataURL（与预览同源、直通 alpha）。
          // 后端直接拿它当管线输入，跳过按 layers 的二次合成。漏转发 = 静默回退。
          composite: body.composite ?? null,
          extra_prompt: body.extra_prompt,
          // Run 设置（以及 ▶ 预设胶囊）选的 preset：决定后端跑哪条 block 链，
          // Enable Mask 总闸也随这条链解析。之前漏转发 —— 对话框的选择被静默丢弃。
          preset_id: body.preset_id ?? null,
          // Detector 工具：source 合成图 + 可选的裁剪用 mask + 表达式参数，整体一个对象。
          detect: body.detect ?? null,
        }),
      });
      const data = await res.json();
      if (data && data.ref_request) {
        // Enable Edit 下 prompt 引用的 <Image N> 缺 ref image：后端没启动本次 run，
        // 由本页弹窗从工作区补图后再重跑（见 handleRefConfirm）。
        blendIframeRef.current?.contentWindow?.postMessage(
          { type: 'blend-ref-request', need: data.ref_request.need, have: data.ref_request.have }, '*');
        setRefSel([]);
        setRefRequest({ need: data.ref_request.need, have: data.ref_request.have, action: 'blend', body });
        return;
      }
      if (!data.success) {
        setError(data.error || 'Blend action failed');
        reply(false, { error: data.error || 'Blend action failed' });
        return;
      }
      if (body.action === 'detect') {
        // 检测是同步的：mask 直接随响应回来，转手交给工作台落地（destination 在那边解释）。
        reply(true, { mask: data.mask || null });
      } else if (body.action === 'blend') {
        reply(true, {});
        // 合成结果只作为新的智能对象图层放回画布顶层（图层自带像素 dataURL，
        // 非破坏、可继续改 transform / 画 mask）；不再自动归档进工作区 ——
        // 工作区只收用户主动拖入的图。画布原有图层与 Mask 层一律不动。
        blendIframeRef.current?.contentWindow?.postMessage(
          { type: 'blend-add-layer', smart: true,
            items: [{ name: data.name || 'Blend', src: data.image }],
            note: 'Blend result added as a new smart layer' }, '*');
      } else if (body.action === 'tag' || body.action === 'clear_tag') {
        // clear_tag returns an empty tag/tags/custom/temporary — pushing it through the same
        // auto-tag channel is exactly how a real tag lands, so the editor clears its parsing
        // tags and its Temporary Prompts alike.
        reply(true, { tag: data.tag });
        setPromptReady(true);
        // Tag output belongs to the prompt stage: push it into the prompt editor's tags.
        setTimeout(() => {
          promptIframeRef.current?.contentWindow?.postMessage({
            type: 'auto-tag',
            tag: data.tag,
            tags: data.tags || [],
            custom: data.custom || '',
            // What the tagger produced that matches no known prompt. Landing these as
            // temporary (not custom) keeps a tag one-pass, exactly like prompt_parsing does.
            temporary: Array.isArray(data.temporary) ? data.temporary : undefined,
          }, '*');
        }, 100);
      } else {
        // The run itself is asynchronous — progress arrives through the status poller.
        setDetailStatus('running');
        reply(true);
      }
    } catch (e: any) {
      setError('Blend action error: ' + e.message);
      reply(false, { error: e.message });
    }
  }, [refreshStaging, syncPrompt, pushLog]);

  /**
   * Generate on a single layer, driven from the layer row's context menu.
   *
   * The difference from a preset run is what is sent: a preset run composites the
   * whole canvas and uses the singleton Mask layer, whereas this sends *that layer's* own image as
   * the context image and *that layer's* own mask as the context mask. The result is written back
   * over that layer's image rather than added as a new layer.
   *
   * `preset_id` names the pipeline preset (block set) that runs this Generate — the enum in the
   * workbench's Generate dialog. The backend resolves it per run; the preset's own start steps apply.
   */
  const handleLayerGenerate = useCallback(async (body: Record<string, any>) => {
    setError(null);
    if (body?.doc?.name) pushLog(`Generate on 「${body.doc.name}」`);
    const layerId = Number(body.layer_id);
    const reply = (success: boolean, extra: Record<string, any> = {}) => {
      blendIframeRef.current?.contentWindow?.postMessage(
        { type: 'blend-action-result', action: 'layer-generate', success, ...extra }, '*');
    };
    if (!body.image) { reply(false, { error: 'That layer has no image' }); return; }
    if (!body.mask) { reply(false, { error: 'That layer has no mask painted' }); return; }
    await syncPrompt();
    try {
      const res = await fetch('/api/blend_action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'layer_generate',
          layer_image: body.image,
          layer_mask: body.mask,
          width: body.width,
          height: body.height,
          preset_id: body.preset_id ?? null,
          extra_prompt: body.extra_prompt,
        }),
      });
      const data = await res.json();
      if (data && data.ref_request) {
        // 与 toolbar Run 同一条闸门：缺 ref image 时不启动，弹窗补图后重跑。
        blendIframeRef.current?.contentWindow?.postMessage(
          { type: 'blend-ref-request', need: data.ref_request.need, have: data.ref_request.have }, '*');
        setRefSel([]);
        setRefRequest({ need: data.ref_request.need, have: data.ref_request.have, action: 'layer', body });
        return;
      }
      if (!data.success) {
        setError(data.error || 'Generate failed');
        reply(false, { error: data.error || 'Generate failed' });
        return;
      }
      // Park the target so the `done` branch knows to replace instead of inject. Set *before* the
      // first poll can see `done`, for the same reason injectedDetailKeyRef is.
      layerGenerateRef.current = { layerId };
      setDetailStatus('running');
      reply(true);
    } catch (e: any) {
      setError('Generate error: ' + e.message);
      reply(false, { error: e.message });
    }
  }, [syncPrompt, pushLog]);

  /**
   * 用户在 ref image 弹窗里补完图：把选中的 staging id 追加进工作台 Extra Prompt（持久化，
   * 下次手点 Run 也在），再把同样的 token 拼进本次 payload 重跑原来那条动作。
   */
  const handleRefConfirm = useCallback(async (ids: string[]) => {
    const req = refRequest;
    setRefRequest(null);
    if (!req || ids.length === 0) return;
    blendIframeRef.current?.contentWindow?.postMessage({ type: 'blend-insert-image-ids', ids }, '*');
    const tokens = ids.map(id => `<image_id:${id}>`).join(' ');
    const prev = String(req.body.extra_prompt || '').trim();
    const body = { ...req.body, extra_prompt: prev ? `${prev} ${tokens}` : tokens };
    if (req.action === 'layer') await handleLayerGenerate(body);
    else await handleBlendAction(body);
  }, [refRequest, handleBlendAction, handleLayerGenerate]);

  // Processor run initiated by the workbench: canvas-derived input images go up as hidden
  // staging entries (in-flight transport), asset-store inputs go up as `asset:<hash>` and the
  // backend reads those bytes itself, then we kick an offline interface execution. Results
  // come back through the poller.
  // Must stay ABOVE the postMessage listener below — the listener's dep array reads this
  // const, and a declaration below it is a TDZ ReferenceError on the first render.
  const handleProcessorRun = useCallback(async (data: any) => {
    const win = blendIframeRef.current?.contentWindow;
    if (!win) return;
    const idx = typeof data.interface_index === 'number' ? data.interface_index : -1;
    const inputs = Array.isArray(data.inputs) ? data.inputs : [];
    if (processorRunRef.current !== null) {
      win.postMessage({ type: 'blend-processor-result', ok: false, error: 'Another interface execution is already running' }, '*');
      return;
    }
    if (idx < 0 || idx >= interfaces.length) {
      win.postMessage({ type: 'blend-processor-result', ok: false, error: 'Processor interface is missing (package disconnected?)' }, '*');
      return;
    }
    processorRunRef.current = idx;
    pushLog(`Run processor 「${interfaces[idx]?.name || '#' + idx}」`);
    try {
      const image_keys: Record<string, string> = {};
      for (const inp of inputs) {
        if (!inp || typeof inp.port !== 'number') continue;
        // Assets 来源：后端按 `asset:<哈希>` 直接从仓库读字节，这里不落图池条目。
        if (typeof inp.asset === 'string' && inp.asset) {
          image_keys[String(inp.port)] = 'asset:' + inp.asset;
          continue;
        }
        if (typeof inp.dataUrl !== 'string' || !inp.dataUrl) continue;
        const res = await fetch('/api/staging', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            images: [inp.dataUrl],
            names: [`in: value${inp.port}`],
            hidden: true,
          }),
        });
        const j = await res.json();
        if (j?.success && j.added?.[0]?.id) image_keys[String(inp.port)] = j.added[0].id;
      }
      setProcessorRunning(true);
      await fetch('/api/execute_interface', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          interface_index: idx,
          manual_values: data.manual_values || {},
          exec_options: { offline: true, image_keys },
        }),
      });
    } catch (e: any) {
      setProcessorRunning(false);
      processorRunRef.current = null;
      win.postMessage({ type: 'blend-processor-result', ok: false, error: e?.message || String(e) }, '*');
    }
  }, [interfaces, pushLog]);

  // Listen for postMessage from the prompt iframe and the Blend workbench.
  // Declared after the handlers so the listener always closes over the current ones.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'kolid-prompt-ready') {
        // Prompt 页刚把监听挂上（它的 mount 拉取与这句几乎同时发出，拉的是当时那一代）。这一句
        // 唯一的用处是补发：切换发生在它就绪之前的那一趟，postMessage 已经丢在空气里了。
        void flushPromptPipeline();
      } else if (event.data?.type === 'kolid-prompt-library-changed') {
        // A prompt document wrote the shared library (词条 / 分类 / prefab / program). Every prompt
        // UI in this workbench is a separate document with its own React copy of /prompts_data, and
        // the Prompt tab never re-fetches on its own — so relay to it. Skip the writer itself: it
        // already patched its own state. Only the always-mounted Prompt tab can be stale while
        // something else writes, since an open Query / preset dialog is modal over this page.
        if (event.source === promptIframeRef.current?.contentWindow) return;
        promptIframeRef.current?.contentWindow?.postMessage({ type: 'kolid-prompt-refresh-library' }, '*');
      } else if (event.data?.type === 'prompt-confirmed') {
        setPromptReady(true);
        // Skip auto-advance if this was consumed by handleTabChange sync
        if (consumedPromptConfirmedRef.current) {
          consumedPromptConfirmedRef.current = false;
          return;
        }
        // Auto-advance: prompt → draw
        if (tabRef.current === 'prompt' && !syncingTabRef.current) {
          setTab('draw');
        }
      } else if (event.data?.type === 'blend-staging-changed') {
        // 工作区条目变了（工作台上传/删除）：重拉列表，effect 会自动镜像回工作台。
        queueStaging(() => refreshStaging());
      } else if (event.data?.type === 'blend-action') {
        // Blend workbench action: blend (archive) / tag / detailer
        handleBlendAction(event.data);
      } else if (event.data?.type === 'blend-layer-generate') {
        // Generate from the layer row's context menu: that layer in, that layer out.
        handleLayerGenerate(event.data);
      } else if (event.data?.type === 'blend-processor-run') {
        // Processor 工具的 Run：输入图上传为隐藏条目 → 离线 interface 执行，轮询回程。
        void handleProcessorRun(event.data);
      } else if (event.data?.type === 'blend-cancel-run') {
        // 工作台的 Cancel（运行中才浮出）—— 打断当前 run
        // （后端用 ComfyUI 原生 interrupt：采样步 / block 边界 / Generate Text 后抛
        // InterruptProcessingException，run 循环转成 detail_status='cancelled'）。
        fetch('/api/cancel_run', { method: 'POST' }).catch(() => {});
      } else if (event.data?.type === 'blend-request-init') {
        // Seed the canvas with the current pipeline image, report the tagger availability,
        // and hand over the staging pool (its strip renders from this mirror).
        const iframe = blendIframeRef.current;
        if (!iframe?.contentWindow) return;
        iframe.contentWindow.postMessage({
          type: 'blend-config',
          hasTagger: !!config?.has_tagger,
          // Detector 工具总闸：节点没连 detector 时，工作台整块 Detector 工具隐藏。
          hasDetector: !!config?.has_detector,
          // 激活 tab 的 Enable Mask 总闸：关 = 整幅是工作区，Run 不要求先画 Mask 层。
          mask_required: preprocessFlag(blockSets, activeBlockSetId, 'enable_mask', true),
          staging: stagingRef.current,
        }, '*');
        // The Generate dialog's Pipeline Preset enum picks which block set runs the generate, so
        // the workbench needs every set's id/name plus the tab that is active right now.
        iframe.contentWindow.postMessage({
          type: 'blend-pipeline-presets',
          presets: blockSets.map((s: BlockSet) => ({
            id: s.id, name: s.name,
            enable_mask: preprocessFlag(blockSets, s.id, 'enable_mask', true),
            enable_fit: preprocessFlag(blockSets, s.id, 'enable_fit', false),
            // Dynamic Layer 三开关：▶ Run 分流到框选→建层→自动 Generate 的工作台侧流程。
            dynamic_layer: preprocessFlag(blockSets, s.id, 'enable_dynamic_layer', false),
            layer_limit: preprocessFlag(blockSets, s.id, 'dynamic_layer_limit', true),
            layer_ctx: preprocessFlag(blockSets, s.id, 'dynamic_layer_ctx', true),
          })),
          active_id: activeBlockSetId,
        }, '*');
        // Processor 的 Interface 枚举同理：iframe 只在 load 时要一次，列表推送若早于它
        // 就绪就已经丢在 about:blank 里了 —— 这里补一次，等于和 presets 一样对齐 init。
        pushProcessors();
        seedBlendCanvas();
      } else if (event.data?.type === 'blend-staging-upload') {
        // 工作台拖文件/Processor 产出：批量追加进图池。replace=true 是工作台换工程的
        // 整池换水（.cud 导入或 tab 激活）：后端先清可见条目、再按 ids 原样落回，
        // 这时空 images 也要发 —— 那是一次纯清空。
        const images: string[] = Array.isArray(event.data.images) ? event.data.images : [];
        const names: string[] = Array.isArray(event.data.names) ? event.data.names : [];
        const ids: string[] = Array.isArray(event.data.ids) ? event.data.ids : [];
        const replace = event.data.replace === true;
        if (!images.length && !replace) return;
        queueStaging(() => fetch('/api/staging', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            images, names,
            ...(ids.length ? { ids } : {}),
            ...(replace ? { replace: true } : {}),
            name: 'Loaded',
          }),
        }).then(() => {
          void refreshStaging();
          // 整池换水（载入 .cud）会把 staging_guidance 一并清掉（这张卡故意不随文档走），而
          // iframe 端只在「自己算出来的图变了」时才重发 —— 换一张长得一样的文档就会永久缺卡。
          // 这里点名让它重发一次（显示本来就吃本地那份，这条是给 run 的取图兜底）。
          if (replace) {
            blendIframeRef.current?.contentWindow?.postMessage({ type: 'blend-guidance-republish' }, '*');
          }
        }));
      } else if (event.data?.type === 'blend-assets-changed') {
        // 工作台自己往仓库里写了一件（Processor 的 Assets 落位）。Assets 窗的清单是拉的，
        // 这里敲一下让每一扇挂着的窗重拉；写方自己不重复导入。
        bumpAssets();
      } else if (event.data?.type === 'blend-cud-assets') {
        // 活跃文档内嵌的那些图（Video / Image 两档的唯一数据源）。页面按整份清单去过重才发，
        // 这里再按 uid 入桶 —— 切 tab 那一瞬窗里显示的就是目标文档自己的清单。
        const next = parseDocAssets(event.data);
        if (next.uid !== null) setDocAssets(next);
      } else if (event.data?.type === 'blend-guidance-card') {
        // Guidances 栈的那一张总卡（Layers 合成 + 整个 guidance 栈）。后端按保留 id
        // staging_guidance 原地换像素 —— 工作区永远只有这一张；image 为空 = 撤回它
        // （栈被清空 / 全隐藏）。条目是真 staging：可删、可 <image_id:…> 引用、可当参考图。
        queueStaging(() => fetch('/api/guidance_card', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: event.data.image || null, name: event.data.name || 'Guidance' }),
        }).then(() => refreshStaging()));
      } else if (event.data?.type === 'blend-staging-remove') {
        const sid = typeof event.data.id === 'string' ? event.data.id : '';
        if (!sid) return;
        queueStaging(() => fetch('/api/staging_remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: sid }),
        }).then(() => refreshStaging()));
      } else if (event.data?.type === 'blend-log') {
        // 工作台画布上那颗常显的状态药丸撤掉了：它每次说话改发一条到这里，攒成 Log 面板
        // （Context 标题行 → Log）。kind 只可能是 '' / 'success' / 'error'，别的按普通行显示。
        const t = typeof event.data.text === 'string' ? event.data.text : '';
        const k = event.data.kind === 'success' || event.data.kind === 'error' ? event.data.kind : '';
        pushLog(t, k);
      } else if (event.data?.type === 'blend-docs') {
        // The workbench's document list, its live one and its IO lock, in one announcement — the host
        // draws a dock window per document and greys File while a .cud is being read or written.
        const docs: BlendDoc[] = Array.isArray(event.data.docs) ? event.data.docs : [];
        const au = typeof event.data.activeUid === 'number' ? event.data.activeUid : null;
        setBlendDocs({
          activeUid: au,
          busy: event.data.busy === true,
          docs,
          // 第一份播报（哪怕是空的）说明"未知"结束了：此后开文档集说什么就是什么，布局照此对账。
          announced: true,
        });
        // 投影跟着播报走：面板这一瞬就换成目标文档离开时的那份快照（桶里留影），不等页面重推。
        setBlendActiveUid(au);
        // 关掉的文档连快照桶一起收走 —— 留着就是一条永远没人读的旧面板状态。
        setDocStills(prev => {
          const open = new Set(docs.map(d => d.uid));
          const stale = Object.keys(prev).map(Number).filter(uid => !open.has(uid));
          for (const uid of stale) {
            dropBlendUi(uid);
            dropVidProcState(uid);
            dropVidProcPicks(uid);
            dropDocAssets(uid);
          }
          if (!stale.length) return prev;
          const next = { ...prev };
          for (const uid of stale) delete next[uid];
          return next;
        });
        // 会话记录跟着播报走：这份活动集就是下一次刷新要整批重开的那批 .cud（打开序）。
        // 带路径的才记 —— 导入的 PNG 没有盘上文件，恢复不了，留给保留位当占位。
        // restoreGate：开机那趟空播报要等恢复问询结束才能落盘（见 seedBlendCanvas）。
        // restorePending：恢复在途时播报是部分活动集，不许写回（等齐了这一趟再记）。
        if (restorePending.current > 0 && docs.length >= restorePending.current) restorePending.current = 0;
        if (restoreGate.current && restorePending.current === 0) fetch('/api/open_cuds', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: docs.map(d => d.path).filter((p): p is string => !!p) }),
        }).catch(() => {});
      } else if (event.data?.type === 'blend-doc-still') {
        const uid = typeof event.data.uid === 'number' ? event.data.uid : 0;
        const image = typeof event.data.image === 'string' ? event.data.image : '';
        if (!uid || !image) return;
        setDocStills(prev => ({ ...prev, [uid]: image }));
      } else if (event.data?.type === 'blend-ui') {
        // 工作台面板的状态快照。页面那边等值去过重才发，所以这里换掉就算数；画布和整页都不订阅它，
        // 只有读了这份快照的那几格正文会重绘 —— 拖动中每帧都在变的读数因此打扰不到采样器。
        // 这是一条跨 iframe 的边界，所以逐格取值：读不出来的当作没说过，回默认而不是回 0。
        // 快照自带所属文档的 uid（页面盖章）：按它入桶，后台文档的桶就是它切走时的留影。
        const uiUid = typeof event.data.uid === 'number' && Number.isFinite(event.data.uid) ? event.data.uid : null;
        if (uiUid === null) return;
        const dec = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
        const str = (v: unknown) => (typeof v === 'string' ? v : '');
        const penOf = (p: Partial<BlendPen> | undefined, d: BlendPen): BlendPen => ({
          mode: typeof p?.mode === 'string' ? p.mode : d.mode,
          size: dec(p?.size, d.size), strength: dec(p?.strength, d.strength),
          center: dec(p?.center, d.center), edge: dec(p?.edge, d.edge), gamma: dec(p?.gamma, d.gamma),
        });
        const ui = event.data;
        const base = EMPTY_BLEND_UI;
        setBlendUi(uiUid, {
          mode: str(ui.mode) || 'none',
          canvas: { w: num(ui.canvas?.w), h: num(ui.canvas?.h) },
          transform: { readout: str(ui.transform?.readout) },
          view: { readout: str(ui.view?.readout) },
          paint: {
            maskLayer: ui.paint?.maskLayer === true, decal: ui.paint?.decal === true,
            tool: str(ui.paint?.tool) || 'brush', selection: ui.paint?.selection === true,
            ring: str(ui.paint?.ring),
          },
          tools: {
            brush: penOf(ui.tools?.brush, base.tools.brush),
            eraser: penOf(ui.tools?.eraser, base.tools.eraser),
            bucket: {
              tolerance: dec(ui.tools?.bucket?.tolerance, base.tools.bucket.tolerance),
              continuous: ui.tools?.bucket?.continuous === true,
              allLayers: ui.tools?.bucket?.allLayers === true,
            },
          },
          color: {
            fg: str(ui.color?.fg) || base.color.fg, bg: str(ui.color?.bg) || base.color.bg,
            fgAlpha: dec(ui.color?.fgAlpha, base.color.fgAlpha),
            bgAlpha: dec(ui.color?.bgAlpha, base.color.bgAlpha),
            hue: dec(ui.color?.hue, base.color.hue),
            mode: str(ui.color?.mode) || 'rgba',
          },
          // 覆盖面那张图读不出来就当没说过（空 = 占位），显示开关缺字段时回默认的那颗 true 而不是 false：
          // 一条旧快照没有 mask 这一格，不代表那一层是隐藏的。
          mask: {
            visible: ui.mask ? ui.mask.visible !== false : base.mask.visible,
            still: str(ui.mask?.still),
          },
          // 两摞行 + 那些缩略图。行的形状由页面那一侧的描述符说话（它才是图层、attribute 和链的
          // 持有者），这里只兜住"读不出来就当没有"：不是数组回空摞。字段级的默认留给单元自己判。
          stacks: { layers: rowList(ui.stacks?.layers), guidances: rowList(ui.stacks?.guidances) },
          // 特效总开关那颗按钮的读数：读不出来就当没说过，回 false（默认不旁路），而不是把 undefined 当成按下。
          // `wand` 是这颗按钮的画法等值 —— 魔棒那串 SVG 只有页面画得对，所以它进快照、这里只搬运。
          // `open` 是此刻摊开的那一步的参数面：那一摞行由注册表编好递过来（when 过滤、折叠分组、贴图槽
          // 绑没绑，判据全在页面），这一侧只按 kind 画控件。读不出坐标就当没摊开 —— 头部那颗按钮不该
          // 亮着，而一块没有主人的面板比一块不摆的面板更糟。
          fx: { bypass: ui.fx?.bypass === true, wand: str(ui.fx?.wand), open: fxOpenOf(ui.fx?.open) },
          // 笔尖落在面 attribute 上时的参数面（Frame source）：坐标落不齐就当没落在面上。
          attrOpen: attrOpenOf(ui.attrOpen),
          // Add 菜单里那条 raster 偏好的勾：同一句读法 —— 缺字段就是没翻开过，不是翻开。
          rasterDrop: ui.rasterDrop === true,
          // `+` 那口菜单的条目表：读不出数组就是空表（那一格菜单一条都不摆），条目里少了名字或那句说明
          // 就丢掉那一类 —— 摆一条没名字的条目比少一条条目更糟。
          attrKinds: kindList(ui.attrKinds),
          // History 那一列：读不出数组就是空列（那一格只报"还没有记账"），一步里少了下标或那句名字
          // 就丢掉那一步 —— 列子里排错顺序比少一行更糟。limit/两颗开关的取值同样"读不出来回默认"。
          history: {
            limit: dec(ui.history?.limit, 0),
            canUndo: ui.history?.canUndo === true,
            canRedo: ui.history?.canRedo === true,
            steps: (Array.isArray(ui.history?.steps) ? ui.history.steps : []).flatMap((s: unknown) => {
              const st = (s || {}) as Record<string, unknown>;
              return typeof st.i === 'number' && Number.isFinite(st.i)
                ? [{ i: Math.max(0, Math.floor(st.i)), label: str(st.label), face: str(st.face), current: st.current === true }]
                : [];
            }),
          },
          // `faces` 是**增量**（页面发完就清），所以这一份 store 是累加的：合并这一帧新给的那几张，
          // 空串那一句是页面发来的"这张面不存在了"，跟着删 —— 删过的层不能一直占着一张没人读的 PNG。
          // 没有新面时回同一个对象引用：否则一条只动了读数的快照也要把整张表复制一遍、惊动每一格。
          // ---- 六格工具面板（Text / Geometry / 3D / Pose / Detector / Processor）----
          // 逐字段兜住"读不出来就当没说过"：这一条跨 iframe，一条旧快照没有这几格不代表它们真是空的。
          text: {
            on: ui.text?.on === true,
            fontLabel: str(ui.text?.fontLabel) || base.text.fontLabel,
            // 字体名 / 那道脸 / 缺字告警都由页面算好，这里只搬运；色值不是 6 位 hex 就回默认（不把脏值摆上去）。
            fontFace: str(ui.text?.fontFace),
            fontMissing: ui.text?.fontMissing === true,
            padding: num(ui.text?.padding),
            weight: str(ui.text?.weight) === 'bold' ? 'bold' : 'normal',
            color: /^#[0-9a-fA-F]{6}$/.test(str(ui.text?.color)) ? str(ui.text?.color) : base.text.color,
          },
          scene3d: {
            on: ui.scene3d?.on === true,
            canOpen: ui.scene3d?.canOpen === true,
            note: str(ui.scene3d?.note) || base.scene3d.note,
          },
          // Geometry：描述符逐字段兜住（位置 / 四元数 / 颜色三样齐了才算有记录），见 geometryUiOf。
          geometry: geometryUiOf(ui.geometry),
          // Pose：形态/姿态/取景三样齐了才算有记录，见 poseUiOf。
          pose: poseUiOf(ui.pose),
          detector: {
            available: ui.detector?.available === true,
            prompt: str(ui.detector?.prompt),
            threshold: dec(ui.detector?.threshold, base.detector.threshold),
            invert: ui.detector?.invert === true,
          },
          // Processor 的三段行是描述符：逐行逐枚读回来，形状不对的丢掉（见 procUiOf）。
          processor: procUiOf(ui.processor),
          // 视频 list 跑（宿主那一趟）在飞时，staging 段的 run 状态归它 —— 页面在跑动期间推来的
          // 快照不认识这趟跑，按页面那份合流会把 busy/进度冲掉。overlay 就是那趟跑留下的旗，
          // 按**来的快照的 uid** 取 —— 跑在 A 时，B 推来的快照不该被 A 的旗盖上。
          staging: (() => {
            const st = stagingUiOf(ui.staging);
            const ov = getVidStagingOverlay(uiUid);
            if (!ov.busy) return st;
            return { ...st, busy: true, cancelLive: true, progress: ov.progress };
          })(),
          faces: mergeFaces(getBlendUiOf(uiUid).faces, faceDelta(ui.faces)),
        });
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [config, blockSets, activeBlockSetId, handleBlendAction, handleLayerGenerate, handleProcessorRun, seedBlendCanvas, refreshStaging, queueStaging, pushLog, pushProcessors]);

  // Push preset (tab) changes to the Blend workbench as they happen. The iframe only asks for
  // init once, on load — without this effect a tab created / renamed / deleted / switched after
  // that would never reach the Generate dialog's Pipeline Preset enum.
  useEffect(() => {
    const iframe = blendIframeRef.current;
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage({
      type: 'blend-pipeline-presets',
      presets: blockSets.map((s: BlockSet) => ({
        id: s.id, name: s.name,
        enable_mask: preprocessFlag(blockSets, s.id, 'enable_mask', true),
        enable_fit: preprocessFlag(blockSets, s.id, 'enable_fit', false),
        // Dynamic Layer 三开关：▶ Run 分流到框选→建层→自动 Generate 的工作台侧流程。
        dynamic_layer: preprocessFlag(blockSets, s.id, 'enable_dynamic_layer', false),
        layer_limit: preprocessFlag(blockSets, s.id, 'dynamic_layer_limit', true),
        layer_ctx: preprocessFlag(blockSets, s.id, 'dynamic_layer_ctx', true),
      })),
      active_id: activeBlockSetId,
    }, '*');
  }, [blockSets, activeBlockSetId]);

  // Push processor-mode interfaces to the workbench whenever they change: the Processor tool's
  // enum picks from this list, and its source/destination pickers read the (renamed) ports.
  useEffect(() => {
    pushProcessors();
  }, [pushProcessors, interfaces, interfaceMeta]);

  // Processor 轮询：interface_status 每跳一次就同步给工作台（进度条走 blend-run-status 同款
  // 语义），done 时按 interface_result_meta 把隐藏条目逐端口发回去。started 后第一次 status
  // 可能还是 idle（action 还没被取走），所以 idle 不收尾、running 见过一次才算数。
  useEffect(() => {
    if (!processorRunning) return;
    let cancelled = false;
    let seenRunning = false;
    const poll = async () => {
      try {
        const data: StatusResponse = await fetch('/api/status').then(r => r.json());
        if (cancelled) return;
        const st = data.interface_status || 'idle';
        const win = blendIframeRef.current?.contentWindow;
        if (win) {
          win.postMessage({
            type: 'blend-run-status',
            status: st === 'running' ? 'running' : st,
            current: data.interface_current_step || 0,
            total: data.interface_total_steps || 0,
          }, '*');
        }
        if (st === 'running') seenRunning = true;
        if (st === 'idle' && !seenRunning) return;
        if (st === 'done' || st === 'error' || st === 'idle') {
          cancelled = true;
          setProcessorRunning(false);
          const idx = processorRunRef.current;
          processorRunRef.current = null;
          if (!win) return;
          if (st === 'done') {
            const meta = (data.interface_result_meta || []) as
              { key: string; port: number; type: string; name: string; video?: string; frames?: number }[];
            const full = await fetch('/api/staging').then(r => r.json()).catch(() => null);
            const list = (full?.staging || []) as StagingItem[];
            const results = meta
              .map(m => {
                // 视频结果（Allow List 的视频路）：没有 staging 条目，URL 直接在 meta 上。
                if (m.video) return { port: m.port, type: m.type, name: m.name, video: m.video, frames: m.frames };
                const item = list.find((s: StagingItem) => s.id === m.key);
                return item ? { port: m.port, type: m.type, name: m.name, id: item.id, src: item.src, width: item.width, height: item.height } : null;
              })
              .filter(Boolean);
            win.postMessage({ type: 'blend-processor-result', ok: true, interface_index: idx, results }, '*');
            pushLog(`Processor done — ${results.length} result${results.length === 1 ? '' : 's'}`, 'success');
          } else {
            win.postMessage({ type: 'blend-processor-result', ok: false, cancelled: st === 'idle', error: data.interface_error || 'Processor failed' }, '*');
            if (st === 'error') pushLog(`Processor failed: ${data.interface_error || 'error'}`, 'error');
          }
          clearInterval(interval);
        }
      } catch { /* keep polling */ }
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(interval); };
  }, [processorRunning, pushLog]);

  const handleSwitchPipeline = useCallback(async (packageIdx: number, pipelineIdx: number) => {
    setError(null);
    try {
      const res = await fetch('/api/switch_pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ package_idx: packageIdx, pipeline_idx: pipelineIdx }),
      });
      const data = await res.json();
      if (data.success) {
        // 切换即加载：edit 设置按架构渲染、override 按名字取，两者都要跟着刷新
        fetch('/api/config').then(r => r.json()).then((cfg: ServerConfig) => {
          setArchitecture(cfg.architecture ?? null);
          setLoadedPipelineName(cfg.loaded_pipeline_name ?? '');
          loraEpochRef.current = cfg.pipeline_lora_epoch ?? loraEpochRef.current;
          // 这里以前是 setTimeout(100) 的一次性 post：iframe 还没挂上监听就永久丢在空气里。
          // 现在漏发有 'kolid-prompt-ready' 和进 tab 那两趟兜，只留这一处发送点。
          void flushPromptPipeline();
        }).catch(() => {});
      } else {
        setError(data.error || 'Failed to switch pipeline');
      }
    } catch (e: any) {
      setError('Failed to switch pipeline: ' + e.message);
    }
  }, []);

  // 图落盘的合并写：节点内联编辑会高频触发，这里延后到停顿 400ms 再发（UI 已即时更新）。
  const graphSaveTimer = useRef<number | null>(null);
  const scheduleGraphSave = useCallback((sets: BlockSet[], activeId: string, blocks: PipelineBlock[], graph: PipelineGraph) => {
    if (graphSaveTimer.current !== null) window.clearTimeout(graphSaveTimer.current);
    graphSaveTimer.current = window.setTimeout(() => {
      graphSaveTimer.current = null;
      fetch('/api/update_config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks_sets: sets, active_block_set: activeId, blocks, graph }),
      }).catch(() => {});
    }, 400);
  }, []);

  // Graph 视图的写路径：图是真源，`blocks` 是它沿 Execute 顺序的投影（给旧路径/摘要用）。
  const handleGraphChange = useCallback((next: PipelineGraph) => {
    const nextSets = blockSets.map(s => s.id === activeBlockSetId
      ? { ...s, graph: next, blocks: graphToBlocks(next) }
      : s);
    setBlockSets(nextSets);
    const active = nextSets.find(s => s.id === activeBlockSetId) ?? nextSets[0];
    // 节点内联编辑每敲一下都会走到这里 —— 网络写必须合并，否则一次编辑就是几十个 POST。
    // UI 立即更新（setBlockSets 在上面），落盘延后到停顿 400ms。
    scheduleGraphSave(nextSets, activeBlockSetId, active?.blocks ?? [], next);
  }, [blockSets, activeBlockSetId]);

  const handleDefaultParamChange = useCallback((key: OverrideKey, value: number) => {
    if (key === 'mask_grow') setMaskGrow(value);
    if (key === 'mask_blur') setMaskBlur(value);
    if (key === 'crop_reserve') setCropReserve(value);
    if (key === 'pixels') setPixelsVal(value);
    if (key === 'align') setAlignVal(value);
    if (key === 'ref_pixels') setRefPixelsVal(value);
    if (key === 'ref_align') setRefAlignVal(value);
    if (key === 'tgen_pixels') setTgenPixelsVal(value);
    if (key === 'tgen_align') setTgenAlignVal(value);
    fetch('/api/update_config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    }).catch(() => {});
  }, []);


  /**
   * Run one pipeline preset right now — the ▶ half of the sampler's Pipeline Presets
   * capsule. The canvas and the Mask layer live in the Blend workbench, so the workbench
   * issues the run; we only name which preset it should use. Its reply is the ordinary
   * blend-action, which starts the status poller.
   */
  const handleRunPreset = useCallback((presetId: string) => {
    setError(null);
    blendIframeRef.current?.contentWindow?.postMessage({ type: 'blend-run-preset', preset_id: presetId }, '*');
  }, []);

  /** Answer a parked Query block. The selection is the prompt UI's RAW choice — the run
   *  merges it and runs its programs, exactly like a prompt block's preset. A Persistent
   *  Query overwrites its bound preset with this same selection, server-side, inside the
   *  POST — that's why the caller awaits us before refreshing the preset summaries. */
  const handleQueryAnswer = useCallback(async (selection: Record<string, any>) => {
    setPendingQuery(null);
    pushLog('Query confirmed — the chain continues');
    try {
      await fetch('/api/query_answer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selection }),
      });
    } catch { /* the run aborts on its own if the answer never lands */ }
  }, [pushLog]);

  /** Closing the Query dialog aborts the whole chain — the user chose to stop, not to skip. */
  const handleQueryCancel = useCallback(async () => {
    setPendingQuery(null);
    pushLog('Query closed — the whole chain was aborted', 'error');
    try {
      await fetch('/api/query_answer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cancelled: true }),
      });
    } catch { /* as above */ }
  }, [pushLog]);

  // ── Pipeline Blocks tabs（多套 blocks，每套独立持久化在后端 config）──
  const persistSets = useCallback((nextSets: BlockSet[], nextActiveId: string) => {
    // 每套保证带图：缺图的旧 set 就地迁移，**已有的图原样保留** —— tab 的新建/改名/删除
    // 不能把用户在图里搭好的接线按 blocks 重算成线性迁移（那会悄悄清掉分支）。
    const sets: BlockSet[] = nextSets.map(normalizeSet);
    setBlockSets(sets);
    setActiveBlockSetId(nextActiveId);
    const active = sets.find(s => s.id === nextActiveId) ?? sets[0];
    fetch('/api/update_config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks_sets: sets, active_block_set: nextActiveId, blocks: active?.blocks ?? [], graph: active?.graph }),
    }).catch(() => {});
  }, [normalizeSet]);

  const handleAddBlockSet = useCallback(() => {
    const id = 'set-' + blockSetIdCounter.current++;
    const nextSets: BlockSet[] = [...blockSets, {
      id,
      name: `Set ${blockSets.length + 1}`,
      blocks: [{ id: 'block-' + blockIdCounter.current++, type: 'detailer', name: 'Detailer', params: { ...defaultBlockParams } }],
    }];
    persistSets(nextSets, id);
  }, [blockSets, persistSets]);

  const handleRenameBlockSet = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    persistSets(blockSets.map(s => s.id === id ? { ...s, name: trimmed } : s), activeBlockSetId);
  }, [blockSets, activeBlockSetId, persistSets]);

  const handleDuplicateBlockSet = useCallback((id: string) => {
    const src = blockSets.find(s => s.id === id);
    if (!src) return;
    const newId = 'set-' + blockSetIdCounter.current++;
    // Deep-copy so editing the copy never aliases the source set's blocks.
    const copy = JSON.parse(JSON.stringify(src.blocks)) as PipelineBlock[];
    persistSets([...blockSets, { id: newId, name: `${src.name} copy`, blocks: copy, pipeline_name: src.pipeline_name }], newId);
  }, [blockSets, persistSets]);

  const handleRemoveBlockSet = useCallback((id: string) => {
    const nextSets = blockSets.filter(s => s.id !== id);
    const nextActive = nextSets.some(s => s.id === activeBlockSetId) ? activeBlockSetId : (nextSets[0]?.id ?? '');
    persistSets(nextSets, nextActive);
  }, [blockSets, activeBlockSetId, persistSets]);

  const handleReorderBlockSets = useCallback((from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= blockSets.length || to >= blockSets.length) return;
    const nextSets = [...blockSets];
    const [moved] = nextSets.splice(from, 1);
    nextSets.splice(to, 0, moved);
    persistSets(nextSets, activeBlockSetId);
  }, [blockSets, activeBlockSetId, persistSets]);

  const handleSwitchBlockSet = useCallback((id: string) => {
    if (id === activeBlockSetId) return;
    persistSets(blockSets, id);
  }, [blockSets, activeBlockSetId, persistSets]);

  // Pipeline Settings 整体落盘在 blocks_sets.json：界面只编辑 selected，
  // overrides 是旧版按名字存的那批覆盖，原样带回、无人再读。
  const handlePipelineSettingsChange = useCallback((next: PipelineSettings) => {
    setPipelineSettings(next);
    fetch('/api/update_config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipeline_settings: next }),
    }).catch(() => {});
  }, []);

  // Architecture Settings（按 pipeline architecture 正则命中的覆盖规则）：整份列表落盘，
  // 顺序就是优先级，所以增删改序全部走同一条写路径。
  const handleArchSettingsChange = useCallback((next: ArchSettings) => {
    setArchSettings(next);
    fetch('/api/update_config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arch_settings: next }),
    }).catch(() => {});
  }, []);

  // Open With Application（Settings tab 的 user preference）：同一写路径，后端把它落进
  // libs.client_host 的共享偏好文件 —— 各节点执行时的 open_ui 从那里读，跨节点生效。
  const handleOpenWithAppChange = useCallback((v: boolean) => {
    setOpenWithApp(v);
    fetch('/api/update_config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ open_with_app: v }),
    }).catch(() => {});
  }, []);

  const handleAddArchRule = useCallback(() => {
    const rule: ArchRule = { id: 'arch-' + archRuleIdCounter.current++, architecture: '', overrides: {} };
    handleArchSettingsChange({ rules: [...archSettings.rules, rule] });
  }, [archSettings, handleArchSettingsChange]);

  // 复制插在源的那一条后面 —— 追加到末尾的话，"照着上面那条改一份"会把你扔到列表底部。
  const handleDuplicateArchRule = useCallback((id: string) => {
    const idx = archSettings.rules.findIndex(r => r.id === id);
    if (idx < 0) return;
    const src = archSettings.rules[idx];
    const copy: ArchRule = {
      id: 'arch-' + archRuleIdCounter.current++,
      architecture: src.architecture,
      overrides: JSON.parse(JSON.stringify(src.overrides)),
    };
    const next = [...archSettings.rules];
    next.splice(idx + 1, 0, copy);
    handleArchSettingsChange({ rules: next });
  }, [archSettings, handleArchSettingsChange]);

  const handleRemoveArchRule = useCallback((id: string) => {
    handleArchSettingsChange({ rules: archSettings.rules.filter(r => r.id !== id) });
  }, [archSettings, handleArchSettingsChange]);

  const handleReorderArchRules = useCallback((from: number, to: number) => {
    const rules = archSettings.rules;
    if (from === to || from < 0 || to < 0 || from >= rules.length || to >= rules.length) return;
    const next = [...rules];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    handleArchSettingsChange({ rules: next });
  }, [archSettings, handleArchSettingsChange]);

  // Interface meta（端口改名 / 模式开关 / block 端口绑定）同一落盘路径，按 interface 名字索引。
  const handleChangeInterfaceMeta = useCallback((next: InterfaceMeta) => {
    setInterfaceMeta(next);
    fetch('/api/update_config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interface_meta: next }),
    }).catch(() => {});
  }, []);

  // preset 行 ⚙：这套链跑起来时用哪条 pipeline（按名字绑，run 时解析）。
  const handleSetPresetPipeline = useCallback((setId: string, pipelineName: string) => {
    persistSets(blockSets.map(s => s.id === setId ? { ...s, pipeline_name: pipelineName } : s), activeBlockSetId);
  }, [blockSets, activeBlockSetId, persistSets]);

  // One-time migration: interface nodes saved before name-binding only carry interface_idx.
  // Once the interfaces list is known, resolve and write the name into every set's **graph**
  // nodes (图是唯一真源)，blocks 由图重算 —— 否则这一步会把用户搭好的接线冲成线性迁移。
  const ifaceNameMigratedRef = useRef(false);
  useEffect(() => {
    if (ifaceNameMigratedRef.current || interfaces.length === 0 || blockSets.length === 0) return;
    ifaceNameMigratedRef.current = true;
    let changed = false;
    const sets: BlockSet[] = blockSets.map(set => {
      const g: PipelineGraph = (set.graph && Array.isArray(set.graph.nodes))
        ? set.graph : blocksToGraph(set.blocks ?? []);
      const nodes = g.nodes.map(n => {
        if (n.kind !== 'interface') return n;
        const ip = n.params as InterfaceBlockParams;
        if (ip.interface_name) return n;
        const itf = interfaces[ip.interface_idx];
        if (!itf) return n;   // out of range: stays unnamed = Missing until the user re-picks
        changed = true;
        return { ...n, params: { ...ip, interface_name: itf.name } };
      });
      const graph: PipelineGraph = { nodes, edges: g.edges };
      return { ...set, graph, blocks: graphToBlocks(graph) };
    });
    if (!changed) return;
    setBlockSets(sets);
    const active = sets.find(s => s.id === activeBlockSetId) ?? sets[0];
    fetch('/api/update_config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks_sets: sets, active_block_set: activeBlockSetId, blocks: active?.blocks ?? [], graph: active?.graph }),
    }).catch(() => {});
  }, [interfaces, blockSets, activeBlockSetId]);

  const handleFinishClick = useCallback(() => {
    setShowFinishDialog(true);
  }, []);

  const handleFinish = useCallback(async (selectedKeys?: string[]) => {
    try {
      await fetch('/api/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected_keys: selectedKeys }),
      });
    } catch { /* ignore */ }
    setFinished(true);
    window.close();
  }, []);

  if (!config) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#888' }}>
        {error || 'Loading...'}
      </div>
    );
  }

  if (finished) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: 16, background: '#0d0d0d', color: '#fff' }}>
        <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'rgba(48,209,88,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: 28, color: '#30d158' }}>✓</span>
        </div>
        <div style={{ fontSize: 18, fontWeight: 700 }}>Finished</div>
        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)' }}>You can close this tab.</div>
      </div>
    );
  }

  return (
    <div>
      {syncingTab && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 32, height: 32, borderRadius: '50%', border: '3px solid rgba(255,255,255,0.1)', borderTopColor: '#0a84ff', animation: 'spin 0.8s linear infinite' }} />
            <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: 600 }}>Syncing...</span>
          </div>
        </div>
      )}
      <EditPhase
        tab={tab}
        onTabChange={handleTabChange}
        promptUrl={config.prompt_url}
        promptReady={promptReady}
        detailStatus={detailStatus}
        staging={staging}
        promptIframeRef={promptIframeRef}
        architecture={architecture}
        maskGrow={maskGrow}
        maskBlur={maskBlur}
        cropReserve={cropReserve}
        pixelsVal={pixelsVal}
        alignVal={alignVal}
        refPixelsVal={refPixelsVal}
        refAlignVal={refAlignVal}
        tgenPixelsVal={tgenPixelsVal}
        tgenAlignVal={tgenAlignVal}
        onDefaultParamChange={handleDefaultParamChange}
        pendingQuery={pendingQuery}
        onRunPreset={handleRunPreset}
        onQueryAnswer={handleQueryAnswer}
        onQueryCancel={handleQueryCancel}
        blockSets={blockSets}
        activeBlockSetId={activeBlockSetId}
        activeGraph={activeGraph}
        onGraphChange={handleGraphChange}
        onAddBlockSet={handleAddBlockSet}
        onRenameBlockSet={handleRenameBlockSet}
        onDuplicateBlockSet={handleDuplicateBlockSet}
        onRemoveBlockSet={handleRemoveBlockSet}
        onReorderBlockSets={handleReorderBlockSets}
        onSwitchBlockSet={handleSwitchBlockSet}
        onFinishClick={handleFinishClick}
        showFinishDialog={showFinishDialog}
        onFinish={handleFinish}
        onCloseFinishDialog={() => setShowFinishDialog(false)}
        blendIframeRef={blendIframeRef}
        blendDocs={blendDocs}
        docStills={docStills}
        onDocCommand={sendDocCommand}
        onBlendUiCommand={sendBlendUiCommand}
        stageUpload={stageUpload}
        stageRemove={stageRemove}
        interfaces={interfaces}
        interfaceMeta={interfaceMeta}
        onChangeInterfaceMeta={handleChangeInterfaceMeta}
        openWithApp={openWithApp}
        onOpenWithAppChange={handleOpenWithAppChange}
        pipelinePackages={pipelinePackages}
        pipelineSettings={pipelineSettings}
        loadedPipelineName={loadedPipelineName}
        onSwitchPipeline={handleSwitchPipeline}
        onPipelineSettingsChange={handlePipelineSettingsChange}
        onSetPresetPipeline={handleSetPresetPipeline}
        archSettings={archSettings}
        onArchSettingsChange={handleArchSettingsChange}
        onAddArchRule={handleAddArchRule}
        onDuplicateArchRule={handleDuplicateArchRule}
        onRemoveArchRule={handleRemoveArchRule}
        onReorderArchRules={handleReorderArchRules}
        actionLog={actionLog}
        pushLog={pushLog}
      />

      {refRequest && (() => {
        // Enable Edit 下 prompt 引用了 <Image N> 却没有对应 ref image：从这里补图。
        // 新补的图按在 Extra Prompt 中的追加顺序排在已有 ref 之后，编号从 have+2 起。
        const wanted = Math.max(1, refRequest.need - refRequest.have);
        const baseIndex = refRequest.have + 2;
        const toggle = (id: string) => setRefSel(prev => {
          if (prev.includes(id)) return prev.filter(x => x !== id);
          if (prev.length >= wanted) return prev;
          return [...prev, id];
        });
        const label = wanted > 1 ? `<Image${baseIndex}>…<Image${baseIndex + wanted - 1}>` : `<Image${baseIndex}>`;
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 720, maxWidth: '90vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column', background: '#1c1c1e', borderRadius: 16, padding: 20, color: '#fff', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Pick reference image{wanted > 1 ? 's' : ''}</div>
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', marginBottom: 14, lineHeight: 1.5 }}>
                The prompt references <b>{label}</b> but no ref image is loaded. Select {wanted} from the workspace — the order becomes {label}.
              </div>
              <div style={{ flex: 1, overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))', gap: 10, alignContent: 'start' }}>
                {staging.length === 0 && (
                  <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 13, padding: 20 }}>No workspace items yet — drag an image in first, then Run again.</div>
                )}
                {staging.map(s => {
                  const idx = refSel.indexOf(s.id);
                  const on = idx >= 0;
                  return (
                    <div key={s.id} onClick={() => toggle(s.id)}
                      style={{ position: 'relative', cursor: 'pointer', borderRadius: 10, overflow: 'hidden', border: on ? '2px solid #0a84ff' : '2px solid transparent', background: 'rgba(255,255,255,0.05)' }}>
                      <img src={s.src} alt={s.name} style={{ width: '100%', height: 84, objectFit: 'cover', display: 'block' }} />
                      <div style={{ fontSize: 11, padding: '4px 6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'rgba(255,255,255,0.7)' }}>{s.name}</div>
                      {on && (
                        <div style={{ position: 'absolute', top: 4, right: 4, width: 20, height: 20, borderRadius: '50%', background: '#0a84ff', color: '#fff', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{baseIndex + idx}</div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
                <button onClick={() => { setRefRequest(null); setRefSel([]); }}
                  style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: 'rgba(255,255,255,0.1)', color: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
                <button disabled={refSel.length !== wanted}
                  onClick={() => { const ids = [...refSel]; setRefSel([]); void handleRefConfirm(ids); }}
                  style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: refSel.length === wanted ? '#0a84ff' : 'rgba(10,132,255,0.3)', color: '#fff', cursor: refSel.length === wanted ? 'pointer' : 'default', fontSize: 13, fontWeight: 600 }}>
                  Confirm ({refSel.length}/{wanted})
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {error && (
        <div style={{
          position: 'fixed',
          top: 12,
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(255, 69, 58, 0.85)',
          color: '#fff',
          padding: '8px 24px',
          borderRadius: 10,
          fontSize: 13,
          fontWeight: 600,
          zIndex: 9999,
          backdropFilter: 'blur(12px)',
          letterSpacing: '0.2px',
          boxShadow: '0 4px 16px rgba(255, 69, 58, 0.25)',
        }}>
          {error}
        </div>
      )}
    </div>
  );
};

export default App;
