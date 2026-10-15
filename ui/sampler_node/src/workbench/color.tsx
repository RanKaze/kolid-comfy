import React, { useEffect, useRef, useState } from 'react';
import { wbStyles } from './skin';
import { useBlendUi } from './store';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';
import type { BlendUi, BlendUiAction } from '../types';
import {
  RGBA_WHEEL, PAINT_MODES, drawRgbaFields, hexOf, hsvToRgb, paintModeValues, parseHex, rgbToHsv,
} from './colour';

// 调色盘那一格：一对 PS 式色块（前景压在背景上）+ 它下面那块常驻的盘。盘调的、笔刷用的都是**前景**；
// 背景只是停在那儿的另一色，点它或按 X 把它换到前台。
// 盘式不是第二份状态，只是同一份状态的两副手势与读数：paintMode 决定第一格画 SV 方块还是 HSB 圆盘、
// 第二格是色相条还是明度条、下面三格读 R/G/B 还是 H/S/B。每一次改动仍旧只落回页面那五个变量，
// 所以 Alt+click 拾色、.cud 工具回读、手输、交换、切盘式全都会自动把色块、盘、拇指、读数同步过来。

type Paint = BlendUi['color'];

const CHECKER = {
  backgroundColor: 'transparent',
  backgroundImage: 'linear-gradient(45deg, rgba(255,255,255,0.18) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.18) 75%),'
    + ' linear-gradient(45deg, rgba(255,255,255,0.18) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.18) 75%)',
  backgroundSize: '8px 8px', backgroundPosition: '0 0, 4px 4px',
};

/** 一个格子的按下-拖动-松手：按下即定位、按住拖动连续改，抓走指针所以拖出格子也继续跟手。 */
function useFieldGesture(apply: (x: number, y: number) => void) {
  const [grab, setGrab] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const at = (ev: React.PointerEvent) => {
    const box = boxRef.current; if (!box) return;
    const r = box.getBoundingClientRect();
    apply(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)),
      Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)));
  };
  const props = {
    ref: boxRef,
    onPointerDown: (ev: React.PointerEvent) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.currentTarget.setPointerCapture(ev.pointerId);
      setGrab(true); at(ev);
    },
    onPointerMove: (ev: React.PointerEvent) => { if (grab) at(ev); },
    onPointerUp: () => setGrab(false),
    onPointerCancel: () => setGrab(false),
  };
  return { props, grab };
}

const ColorBody: React.FC<WorkbenchUnitProps> = ({ send }) => {
  const ui = useBlendUi();
  const snap = ui.color;
  // 手指这一帧就要看到盘子跟着动，所以正文持一份乐观值：算出来的下一个颜色和页面 setter 会落下的
  // 那一个用同一份算术推出来，快照回来时若与预测不同（页面夹过、或颜色是从画布上拾来的）就 adopt。
  const [local, setLocal] = useState<Paint>(snap);
  const key = JSON.stringify(snap);
  useEffect(() => { setLocal(JSON.stringify(snap) === JSON.stringify(local) ? local : snap); }, [key]);

  const plateCv = useRef<HTMLCanvasElement | null>(null);
  const rampCv = useRef<HTMLCanvasElement | null>(null);
  const alphaCv = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (plateCv.current && rampCv.current && alphaCv.current) {
      drawRgbaFields(plateCv.current, rampCv.current, alphaCv.current, local.mode, local.fg, local.hue);
    }
  }, [local.mode, local.fg, local.hue]);

  /** 落一次改动：hue 只有在页面自己不会从新颜色反解出方向时才需要单独发（chroma 太小的那一下）。 */
  const commit = (fg: string | null, hue: number | null) => {
    const next: Paint = { ...local };
    if (hue !== null) next.hue = Math.max(0, Math.min(1, hue));
    if (fg !== null) {
      const h = rgbToHsv(parseHex(fg));
      next.fg = fg;
      if (h[1] > 0.004) next.hue = h[0];
    }
    if (fg === null || rgbToHsv(parseHex(fg))[1] <= 0.004) { if (hue !== null) send('paint-hue', hue); }
    if (fg !== null) send('paint-color', fg);
    setLocal(next);
  };
  const commitAlpha = (a: number) => {
    const v = Math.max(0, Math.min(1, Number.isFinite(a) ? a : 1));
    send('paint-alpha', v); setLocal({ ...local, fgAlpha: v });
  };
  const act = (a: BlendUiAction, v?: number | boolean | string) => send(a, v);

  const rgb = parseHex(local.fg);
  const hsv = rgbToHsv(rgb);
  const back = parseHex(local.bg);
  const spec = PAINT_MODES[local.mode] || PAINT_MODES.rgba;
  const vals = paintModeValues(local.mode, rgb, hsv, local.hue);

  // ── 三格手势（算式与页面那三段 bindRgbaField 一字不差）────────────────────────
  const plate = useFieldGesture((x, y) => {
    const cur = rgbToHsv(parseHex(local.fg));
    if (local.mode === 'hsb') {
      // 圆盘: 角度 = 色相, 半径 = 饱和度, 明度保持现在这一份。正圆心那一下方向无意义 (半径 0),
      // 就留住原来的朝向, 免得拖到中心颜色突然跳到红。
      const dx = x * 2 - 1, dy = 1 - y * 2, len = Math.hypot(dx, dy);
      const h = len === 0 || len <= 0.0001 ? local.hue : (Math.atan2(dy, dx) / (Math.PI * 2) + 1) % 1;
      commit(hexOf(hsvToRgb(h, Math.min(1, len), cur[2])), h);
      return;
    }
    commit(hexOf(hsvToRgb(local.hue, x, 1 - y)), null);
  });
  // 两条竖直的条只看手指的高度，横坐标没有意义（色相条、明度条、Alpha 条都是 16px 宽的一根）。
  const ramp = useFieldGesture((_x, y) => {
    const cur = rgbToHsv(parseHex(local.fg));
    if (local.mode === 'hsb') {
      commit(hexOf(hsvToRgb(local.hue, cur[1], 1 - y)), null);
      return;
    }
    // 有色就跟着新色相重算颜色; 灰阶 (s=0) 只挪色相条, 颜色本来就不该变。
    if (cur[1] > 0.004) commit(hexOf(hsvToRgb(y, cur[1], cur[2])), null);
    else commit(null, y);
  });
  const alpha = useFieldGesture((_x, y) => commitAlpha(1 - y));

  // ── 手输三格：空着或写歪的那格回落到现值，夹到本 mode 的上限后一次落地 ──────────
  const [draft, setDraft] = useState<string[] | null>(null);
  const shown = draft || vals.map(String);
  const typeCell = (i: number, raw: string) => {
    const next = (draft || vals.map(String)).slice();
    next[i] = raw;
    const cur = paintModeValues(local.mode, parseHex(local.fg), rgbToHsv(parseHex(local.fg)), local.hue);
    const v = next.map((t, k) => {
      const s = String(t).trim(), n = Number(s);
      const x = s !== '' && Number.isFinite(n) ? n : cur[k];
      return Math.max(0, Math.min(spec.max[k], x));
    });
    setDraft(next);
    if (local.mode === 'hsb') {
      const h = v[0] / 360;
      commit(hexOf(hsvToRgb(h, v[1] / 100, v[2] / 100)), h);
    } else {
      commit(hexOf(v.map(k => Math.round(k))), null);
    }
  };
  const [alphaDraft, setAlphaDraft] = useState<string | null>(null);
  const alphaShown = alphaDraft ?? String(Math.round(local.fgAlpha * 100));

  const fieldStyle = (grab: boolean, w: React.CSSProperties): React.CSSProperties => ({
    position: 'relative', cursor: grab ? 'none' : 'crosshair', touchAction: 'none', ...w,
  });
  const flexPlate: React.CSSProperties = local.mode === 'hsb'
    ? { flex: '0 0 auto', width: RGBA_WHEEL, height: RGBA_WHEEL }
    : { flex: '1 1 auto', minWidth: 0, height: 116 };
  const strip: React.CSSProperties = { flex: '0 0 16px', height: 116 };
  const cvStyle: React.CSSProperties = { display: 'block', width: '100%', height: '100%', borderRadius: 6 };
  const thumbStyle: React.CSSProperties = {
    position: 'absolute', width: 12, height: 12, margin: '-6px 0 0 -6px', borderRadius: '50%',
    border: '2px solid #fff', boxShadow: '0 0 0 1px rgba(0,0,0,0.6)', pointerEvents: 'none',
  };
  const barStyle: React.CSSProperties = {
    position: 'absolute', left: -1, right: -1, height: 3, marginTop: -1.5, borderRadius: 2,
    background: '#fff', boxShadow: '0 0 0 1px rgba(0,0,0,0.6)', pointerEvents: 'none',
  };
  const chip: React.CSSProperties = {
    position: 'absolute', padding: 0, overflow: 'hidden', border: '0.5px solid rgba(255,255,255,0.28)',
    borderRadius: 6, cursor: 'pointer', ...CHECKER,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 4, minWidth: 0 }}>
      <div style={wbStyles.row}>
        <span style={{ ...wbStyles.key }} title="Swap the two colours (X)">X</span>
        <span style={{ position: 'relative', width: 48, height: 28, flexShrink: 0 }}>
          <span style={{ ...chip, left: 0, top: 0, width: 27, height: 22, zIndex: 1 }}
            title={'Foreground — the colour you paint with. On a decal it paints translucent strokes; '
              + 'on a mask that same Alpha IS the coverage you pour (0 = nothing, 1 = full). '
              + 'Alt+click on the canvas picks into it. The panel below edits this one.'}>
            <span style={{ position: 'absolute', inset: 2, borderRadius: 4, display: 'block',
              background: `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${local.fgAlpha})` }} />
          </span>
          <button type="button" style={{ ...chip, left: 21, top: 6, width: 25, height: 20 }}
            title="Background — the parked colour. Click to bring it forward, same as X."
            onClick={() => act('paint-swap')}>
            <span style={{ position: 'absolute', inset: 2, borderRadius: 4, display: 'block',
              background: `rgba(${back[0]}, ${back[1]}, ${back[2]}, ${local.bgAlpha})` }} />
          </button>
        </span>
        <span style={{ ...wbStyles.row, marginLeft: 'auto' }}>
          {(['rgba', 'hsb'] as const).map(m => (
            <button key={m} style={{ ...wbStyles.btn, padding: '4px 6px', fontSize: 10,
              ...(local.mode === m ? wbStyles.btnOn : null) }}
              title={m === 'rgba'
                ? 'RGBA — the plate is Saturation × Brightness at the hue on the bar next to it; the four fields below read Red / Green / Blue (0..255) and Alpha %.'
                : 'HSBA — a colour wheel: angle is Hue, radius is Saturation, and the bar beside it dims the whole wheel to Brightness. The fields read Hue (0..360) / Saturation / Brightness (0..100) and Alpha %.'}
              onClick={() => { act('paint-mode', m); setLocal({ ...local, mode: m }); }}>{m === 'rgba' ? 'RGBA' : 'HSBA'}</button>
          ))}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 6, height: 116, minWidth: 0,
        ...(local.mode === 'hsb' ? { justifyContent: 'space-between' } : null) }}>
        <div {...plate.props} style={fieldStyle(plate.grab, flexPlate)}>
          <canvas ref={plateCv} style={cvStyle} />
          <span style={{ ...thumbStyle,
            left: (local.mode === 'hsb'
              ? 50 + Math.cos(local.hue * Math.PI * 2) * (hsv[1] * 50) : hsv[1] * 100).toFixed(2) + '%',
            top: (local.mode === 'hsb'
              ? 50 - Math.sin(local.hue * Math.PI * 2) * (hsv[1] * 50) : (1 - hsv[2]) * 100).toFixed(2) + '%' }} />
        </div>
        <div {...ramp.props} style={fieldStyle(ramp.grab, strip)}>
          <canvas ref={rampCv} style={cvStyle} />
          <span style={{ ...barStyle, top: ((local.mode === 'hsb' ? 1 - hsv[2] : local.hue) * 100).toFixed(2) + '%' }} />
        </div>
        <div {...alpha.props} style={fieldStyle(alpha.grab, strip)}
          title="Alpha — strokes paint at this opacity; on a mask it is the coverage one pass pours.">
          <canvas ref={alphaCv} style={cvStyle} />
          <span style={{ ...barStyle, top: ((1 - local.fgAlpha) * 100).toFixed(2) + '%' }} />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11,
        color: 'rgba(255,255,255,0.62)', minWidth: 0 }}
        title="Type a channel value — R/G/B 0..255 in RGBA, H 0..360 with S/B 0..100 in HSBA. The two buttons above pick which three.">
        {spec.labels.map((text, i) => (
          <span key={text} style={{ display: 'flex', alignItems: 'center', gap: 4, flex: '1 1 0', minWidth: 0 }}>
            <label>{text}</label>
            <input type="number" min={0} max={spec.max[i]} step={1} value={shown[i]}
              style={{ flex: '1 1 0', minWidth: 0, background: '#1c1c1e', color: '#fff',
                border: '0.5px solid rgba(255,255,255,0.16)', borderRadius: 4, fontSize: 11, padding: '2px 3px',
                outline: 'none', appearance: 'textfield', WebkitAppearance: 'textfield' as never }}
              onChange={e => typeCell(i, e.target.value)}
              onBlur={() => setDraft(null)} />
          </span>
        ))}
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, flex: '1 1 0', minWidth: 0 }}>
          <label>A</label>
          <input type="number" min={0} max={100} step={1} value={alphaShown}
            title="Alpha as a percentage — strokes paint at this opacity; on a mask it is the coverage one pass pours"
            style={{ flex: '1 1 0', minWidth: 0, background: '#1c1c1e', color: '#fff',
              border: '0.5px solid rgba(255,255,255,0.16)', borderRadius: 4, fontSize: 11, padding: '2px 3px',
              outline: 'none', appearance: 'textfield', WebkitAppearance: 'textfield' as never }}
            onChange={e => {
              const raw = e.target.value; setAlphaDraft(raw);
              const n = Number(String(raw).trim());
              if (String(raw).trim() !== '' && Number.isFinite(n)) commitAlpha(n / 100);
            }}
            onBlur={() => setAlphaDraft(null)} />
          <span style={{ flexShrink: 0 }}>%</span>
        </span>
      </div>
    </div>
  );
};

export const colorUnit: WorkbenchUnit = {
  id: 'color',
  title: 'Color',
  hint: 'Color — the front chip is what this brush paints with; the back one is the parked colour, and '
    + 'clicking it (or X) brings it forward. The panel below always edits the front one, as a square or '
    + 'as a wheel.',
  Body: ColorBody,
};
