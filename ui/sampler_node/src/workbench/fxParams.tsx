import React, { useRef, useState } from 'react';
import { useBlendUi } from './store';
import { wbStyles } from './skin';
import type { BlendFxCoord, BlendFxOpenStep, BlendFxRow, BlendUiSend } from '../types';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';

// 特效参数面这一格 = 页面注册表编好的那一串行（快照 `fx.open.rows`），一个 kind 一颗控件。
// 判据全在页面那一侧：哪几行出现（声明序 + 每行自己的 when + 折叠组的开合）、贴图槽那一行叫什么
// 名字、绑的那张图此刻还在不在、曲线的 x 夹在两个邻居之间、范围外不加控制点、首末点删不得 ——
// 这一侧一条都不重述，画完控件把手势的坐标发回去（拍板 25「都改成组件」：不留 hole，也不留第二份真相）。
//
// 一趟只有一步摊着（`fxOpenId` 那一个变量说的就是它），所以头部不需要"是哪一步"的选择器：那颗 chip
// 就是入口，再点一次收起来 —— 一个动作一个可见入口。

type Base = { step: BlendFxOpenStep; send: BlendUiSend };
type Of<K extends BlendFxRow['kind']> = Base & { row: Extract<BlendFxRow, { kind: K }> };

const coordOf = (s: BlendFxOpenStep): BlendFxCoord => ({ layerId: s.layerId, attrId: s.attrId, stepId: s.stepId });

/** 曲线那格的四条边：150px 见方、内缩 7px。换的是画法（SVG 连点），不是那张图的分辨率 ——
 *  两边量的还是同一套 0..1，所以同一个手势落同一个点。 */
const CURVE_PAD = 7, CURVE_SIZE = 150;
const CURVE_INNER = CURVE_SIZE - 2 * CURVE_PAD;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

const Chevron = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 10, height: 10 }}>
    {open ? <path d="M2.6 4.4 6 7.8l3.4-3.4" /> : <path d="M4.4 2.6 7.8 6l-3.4 3.4" />}
  </svg>
);

const ResetGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M13.2 8a5.2 5.2 0 1 1-1.7-3.85" />
    <path d="M13.4 2.6v2.6h-2.6" />
  </svg>
);

// ---- 一行一个旋钮 ----
// 落笔分两次，与 DOM 那对 input/change 一字不差：拖途中发 `live`（只清缓存重画布，不记账），松手/点定
// 发 `commit`（页面在那一句里记一步历史，并重问那批行的 when）。
// 提交带的是**这一次拖到的那个值**，不是快照里的那一个 —— 最后一帧播报可能还在路上，落定的那一步
// 不能拿旧值代它说话。
const RangeRow = ({ step, row, send }: Of<'range'>) => {
  const c = coordOf(step);
  const last = useRef<number | null>(null);
  const commit = () => send('fx-param-commit', { ...c, key: row.key, value: last.current ?? row.value });
  return (
    <div style={wbStyles.ctrl}>
      <label style={wbStyles.ctrlLabel} title={row.tip || undefined}>{row.label}</label>
      <input style={wbStyles.slider} type="range" min={row.min} max={row.max} step={row.step} value={row.value}
        onChange={e => { const v = parseFloat(e.target.value); last.current = v; send('fx-param-live', { ...c, key: row.key, value: v }); }}
        onPointerUp={commit} onKeyUp={commit} />
      <span style={wbStyles.value}>{row.readout}</span>
    </div>
  );
};

// 布尔开关行：勾选就是落定，没有"拖途中"那一半。
const CheckRow = ({ step, row, send }: Of<'check'>) => (
  <div style={wbStyles.ctrl}>
    <input style={wbStyles.check} type="checkbox" checked={row.flag} title={row.tip || undefined}
      onChange={() => send('fx-param-commit', { ...coordOf(step), key: row.key, value: !row.flag })} />
    <label style={{ ...wbStyles.ctrlLabel, width: 'auto' }}>{row.label}</label>
  </div>
);

// 双态按钮：值是真参数（进存档、进缓存键），所以按钮上那句 ON/OFF 就是可见读数。
const FlagRow = ({ step, row, send }: Of<'flag'>) => (
  <div style={wbStyles.row}>
    <label style={{ ...wbStyles.ctrlLabel, width: 'auto' }} title={row.tip || undefined}>{row.label}</label>
    <button type="button" className="mini-btn" style={row.flag ? wbStyles.btnOn : undefined}
      title={`${row.label}: ${row.readout}`}
      onClick={() => send('fx-param-commit', { ...coordOf(step), key: row.key, value: !row.flag })}>
      {row.readout}
    </button>
  </div>
);

const ColorRow = ({ step, row, send }: Of<'color'>) => {
  const c = coordOf(step);
  const last = useRef<string | null>(null);
  return (
    <div style={wbStyles.ctrl}>
      <label style={wbStyles.ctrlLabel} title={row.tip || undefined}>{row.label}</label>
      <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(row.value) ? row.value : '#000000'}
        style={{ width: 26, height: 18, padding: 0, border: 'none', background: 'transparent', flex: '0 0 auto' }}
        onChange={e => { last.current = e.target.value; send('fx-param-live', { ...c, key: row.key, value: e.target.value }) }}
        onPointerUp={() => send('fx-param-commit', { ...c, key: row.key, value: last.current ?? row.value })} />
      <span style={wbStyles.value}>{row.readout}</span>
    </div>
  );
};

// 枚举行用分段钮 —— 与兄弟格（Brush 那三档、Bucket 那两颗）同一套控件词汇。选项的显示文本由页面
// 交过来：def.labels 是注册表那一份，'trailing' 缩成 'trail' 也是原来那颗钮上写的字。
const EnumRow = ({ step, row, send }: Of<'enum'>) => (
  <div style={wbStyles.row}>
    <label style={{ ...wbStyles.ctrlLabel, width: 'auto' }} title={row.tip || undefined}>{row.label}</label>
    <div className="mini-group" style={{ justifyContent: 'flex-start' }}>
      {row.options.map((o, i) => (
        <button key={o} type="button" className="mini-btn" style={o === row.value ? wbStyles.btnOn : undefined}
          title={`${row.label}: ${o}`}
          onClick={() => send('fx-param-commit', { ...coordOf(step), key: row.key, value: o })}>
          {row.labels[i] ?? o}
        </button>
      ))}
    </div>
  </div>
);

// 贴图槽 / 方向引用：一条按钮写着当前绑的是哪张，行尾一枚 ×。没绑转淡、绑了但图没了转红 ——
// 静默降级是最难发现的那种 bug，所以这一格的读数必须看得见。
const BindShell = (p: { readout: string; title: string; bound: boolean; missing: boolean;
  clearTitle: string; onPick: () => void; onClear: () => void }) => (
  <div style={wbStyles.row}>
    <button type="button" className={'mini-btn fx-bind' + (p.missing ? ' gone' : p.bound ? '' : ' unset')}
      style={{ flex: '1 1 0', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      title={p.title} onClick={p.onPick}>
      {p.readout}
    </button>
    {p.bound && (
      <button type="button" className="mini-btn ico-btn" title={p.clearTitle} onClick={p.onClear}>×</button>
    )}
  </div>
);

const MapRow = ({ step, row, send }: Of<'map'>) => {
  const c = coordOf(step);
  return (
    <BindShell readout={row.readout} title={row.title} bound={row.bound} missing={row.missing}
      clearTitle={`Unbind this ${row.role.toLowerCase()} map`}
      onPick={() => send('fx-map-pick', { ...c, key: row.key })}
      onClear={() => send('fx-map-bind', { ...c, key: row.key, ref: null })} />
  );
};

const DirRow = ({ step, row, send }: Of<'dir'>) => {
  const c = coordOf(step);
  return (
    <BindShell readout={row.readout} title={row.title} bound={row.bound} missing={row.missing}
      clearTitle="Unbind this attribute"
      onPick={() => send('fx-dir-pick', { ...c, key: row.key })}
      onClear={() => send('fx-dir-bind', { ...c, key: row.key, ref: null })} />
  );
};

// 扭曲网格那一行：两枚各指一个目的地的钮（摊开 / 收起）+ 一枚丢掉。网格本身摊在主画布上，
// 这一格只说它现在摊没摊开、几列几行。
const LatticeRow = ({ step, row, send }: Of<'lattice'>) => {
  const c = coordOf(step);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={wbStyles.row}>
        <label style={{ ...wbStyles.ctrlLabel, width: 'auto' }} title={row.tip || undefined}>{row.label}</label>
        <span style={wbStyles.readout}>{row.readout}</span>
      </div>
      <div className="mini-group" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="mini-btn" style={row.active ? wbStyles.btnOn : undefined}
          title={`${row.editLabel} — the grid is dragged on the canvas`}
          onClick={() => send('fx-lattice', { ...c, which: 'edit' })}>{row.editLabel}</button>
        <button type="button" className="mini-btn" disabled={!row.hasGrid}
          title="Stop editing the grid on the canvas — the grid itself stays in this effect"
          onClick={() => send('fx-lattice', { ...c, which: 'hide' })}>Hide</button>
        <button type="button" className="mini-btn" disabled={!row.hasGrid}
          title="Remove the grid — this effect then bends the whole layer by its own geometry"
          onClick={() => send('fx-lattice', { ...c, which: 'drop' })}>Drop</button>
      </div>
      <span style={{ ...wbStyles.readout, paddingLeft: 2 }}
        title="Point handles move the grid; dragging an edge splits that edge across the whole lattice (quads only)">{row.hint}</span>
    </div>
  );
};

// ---- 曲线那一格 ----
// 折线是页面按 curveValueAt 采好交过来的那串点（64 段），这里只连点：那条三次 Hermite 插值只有一个
// 作者，两边各画一次形状迟早会漂开。手势量的还是归一化坐标，夹 x / 范围外不加 / 首末点删不得那三条
// 闸都住在页面（fx/curves.js），所以 `settle` 不带标签 —— 那句话说的是这一次手势，页面自己记得。
const CurveRow = ({ step, row, send }: Of<'curve'>) => {
  const c = coordOf(step);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ op: 'point' | 'input'; index: number; which?: 'black' | 'white' } | null>(null);
  const [picked, setPicked] = useState(-1);

  // 落点 → 0..1：先按 SIZE 空间量（这一格可能被压窄），再减掉那一圈内边距。
  const norm = (clientX: number, clientY: number): [number, number] => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || !box.width) return [0, 0];
    const k = box.width / CURVE_SIZE;
    return [clamp01(((clientX - box.left) / k - CURVE_PAD) / CURVE_INNER),
      clamp01(1 - ((clientY - box.top) / k - CURVE_PAD) / CURVE_INNER)];
  };
  const px = (x: number, y: number) => [CURVE_PAD + x * CURVE_INNER, CURVE_PAD + (1 - y) * CURVE_INNER];
  const nearest = (x: number, y: number) => {
    let best = -1, bd = 0.07 * 0.07;
    row.points.forEach((p, i) => {
      const dx = p[0] - x, dy = p[1] - y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };

  const down = (ev: React.PointerEvent<SVGSVGElement>) => {
    ev.preventDefault();
    const [x, y] = norm(ev.clientX, ev.clientY);
    const i = nearest(x, y);
    if (i >= 0 && ev.altKey) {
      if (i > 0 && i < row.points.length - 1) { setPicked(-1); send('fx-curve', { ...c, op: 'remove', index: i }); }
      return;
    }
    ev.currentTarget.setPointerCapture(ev.pointerId);
    if (i < 0) {
      // 点空白处就在那儿加一个控制点，落点 y 就是它的输出电平；范围外那一死区由页面那道闸回绝。
      // 新点的下标要等页面插完才知道，所以拖动途中不再补 move —— 这一趟里它只是被放下了。
      send('fx-curve', { ...c, op: 'add', x, y });
      dragRef.current = { op: 'point', index: -1 };
      return;
    }
    setPicked(i);
    dragRef.current = { op: 'point', index: i };
    send('fx-curve', { ...c, op: 'move', index: i, x, y });
  };
  const move = (ev: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const [x, y] = norm(ev.clientX, ev.clientY);
    if (d.op === 'input') { send('fx-curve', { ...c, op: 'input', which: d.which, x }); return; }
    if (d.index < 0) return;
    send('fx-curve', { ...c, op: 'move', index: d.index, x, y });
  };
  const up = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    send('fx-curve', { ...c, op: 'settle' });
  };
  // 底边两枚三角 = 首末点的 x，也就是输入黑/白点：纵向不动，拖的就是输入电平。
  const triDown = (which: 'black' | 'white') => (ev: React.PointerEvent<SVGPolygonElement>) => {
    ev.preventDefault();
    ev.stopPropagation();
    const i = which === 'black' ? 0 : row.points.length - 1;
    setPicked(i);
    dragRef.current = { op: 'input', index: i, which };
    svgRef.current?.setPointerCapture(ev.pointerId);
  };
  const triPts = (x: number) => {
    const X = CURVE_PAD + x * CURVE_INNER, B = CURVE_PAD + CURVE_INNER;
    return `${X - 6},${B + 7} ${X + 6},${B + 7} ${X},${B - 1}`;
  };

  const sel = picked >= 0 && picked < row.points.length ? row.points[picked] : null;
  const grid = [1, 2, 3].map(i => CURVE_PAD + (CURVE_INNER * i) / 4);
  const first = row.points[0] || [0, 0];
  const lastPt = row.points[row.points.length - 1] || [1, 1];
  const line = row.lut.map(q => px(q[0], q[1]).join(',')).join(' ');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={wbStyles.row}>
        <label style={{ ...wbStyles.ctrlLabel, width: 'auto' }} title={row.tip || undefined}>{row.label}</label>
        <div className="mini-group" style={{ justifyContent: 'flex-start' }}>
          {row.channels.map(ch => (
            <button key={ch.value} type="button" className="mini-btn" style={ch.value === row.channel ? wbStyles.btnOn : undefined}
              title={`Editing the ${ch.label} curve — this only moves the panel focus, it does not touch the pixels`}
              onClick={() => send('fx-curve', { ...c, op: 'focus', channel: ch.value })}>{ch.label}</button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
        <svg ref={svgRef} className="fx-curve-svg" viewBox={`0 0 ${CURVE_SIZE} ${CURVE_SIZE}`}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <rect x={CURVE_PAD} y={CURVE_PAD} width={CURVE_INNER} height={CURVE_INNER} fill="#0e0e11" />
          {grid.map(g => (
            <React.Fragment key={g}>
              <line x1={CURVE_PAD} y1={g} x2={CURVE_PAD + CURVE_INNER} y2={g} stroke="rgba(255,255,255,0.09)" />
              <line x1={g} y1={CURVE_PAD} x2={g} y2={CURVE_PAD + CURVE_INNER} stroke="rgba(255,255,255,0.09)" />
            </React.Fragment>
          ))}
          <line x1={CURVE_PAD} y1={CURVE_PAD + CURVE_INNER} x2={CURVE_PAD + CURVE_INNER} y2={CURVE_PAD}
            stroke="rgba(255,255,255,0.22)" strokeDasharray="3 3" />
          <polyline points={line} fill="none" stroke="#6f8cff" strokeWidth={1.8} />
          {row.points.map((q, i) => {
            const [X, Y] = px(q[0], q[1]);
            const r = i === picked ? 3.6 : 2.8;
            return <rect key={i} x={X - r} y={Y - r} width={r * 2} height={r * 2}
              fill={i === picked ? '#fff' : '#0e0e11'} stroke="#6f8cff" strokeWidth={1.4} />;
          })}
          <polygon points={triPts(first[0])} fill="#6f8cff" opacity={0.85} onPointerDown={triDown('black')} />
          <polygon points={triPts(lastPt[0])} fill="#6f8cff" opacity={0.85} onPointerDown={triDown('white')} />
        </svg>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 10.5, color: 'rgba(255,255,255,0.5)' }}>
          <span>Input <b style={{ color: 'rgba(255,255,255,0.8)' }}>{sel ? Math.round(sel[0] * 255) : '—'}</b></span>
          <span>Output <b style={{ color: 'rgba(255,255,255,0.8)' }}>{sel ? Math.round(sel[1] * 255) : '—'}</b></span>
          <button type="button" className="mini-btn ico-btn" title="Reset all channel curves"
            onClick={() => { setPicked(-1); send('fx-curve', { ...c, op: 'reset' }); }}><ResetGlyph /></button>
        </div>
      </div>
      <span style={{ ...wbStyles.readout, paddingLeft: 2 }}>click add · drag shape · alt-click remove</span>
    </div>
  );
};

const FoldHead = ({ step, row, send }: Of<'fold'>) => (
  <button type="button" className="fx-fold-head" title={row.tip || undefined}
    onClick={() => send('fx-fold-toggle', { ...coordOf(step), key: row.key })}>
    <Chevron open={row.open} />
    <span>{row.label}</span>
  </button>
);

const FxRow = ({ step, row, send }: Base & { row: BlendFxRow }) => {
  switch (row.kind) {
    case 'fold': return <FoldHead step={step} row={row} send={send} />;
    case 'range': return <RangeRow step={step} row={row} send={send} />;
    case 'check': return <CheckRow step={step} row={row} send={send} />;
    case 'flag': return <FlagRow step={step} row={row} send={send} />;
    case 'color': return <ColorRow step={step} row={row} send={send} />;
    case 'enum': return <EnumRow step={step} row={row} send={send} />;
    case 'map': return <MapRow step={step} row={row} send={send} />;
    case 'dir': return <DirRow step={step} row={row} send={send} />;
    case 'lattice': return <LatticeRow step={step} row={row} send={send} />;
    default: return <CurveRow step={step} row={row} send={send} />;
  }
};

const FxParamsBody: React.FC<WorkbenchUnitProps> = ({ send }) => {
  const ui = useBlendUi();
  const step = ui.fx.open;
  if (!step) {
    return (
      <div style={{ padding: 4 }}>
        <div className="layer-empty">No effect step is open — click a step in a chain to edit its parameters</div>
      </div>
    );
  }
  return (
    <div className="fx-params dark-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 4, minWidth: 0 }}>
      <div style={wbStyles.row} title={`This step draws: ${step.readout || 'no readout'}`}>
        <span className="fx-name">{step.label}</span>
        <span style={{ ...wbStyles.readout, flex: 1, textAlign: 'right' }}>{step.readout}</span>
      </div>
      {step.rows.map(row => <FxRow key={row.key} step={step} row={row} send={send} />)}
    </div>
  );
};

export const fxParamsUnit: WorkbenchUnit = {
  id: 'fxparams',
  title: 'Effect Parameters',
  hint: 'The knobs of the one effect step you opened: click a step in a chain and its parameters land here. '
    + 'Every row comes from the effect registry, so a mode row hides the knobs that no longer mean anything.',
  Body: FxParamsBody,
};
