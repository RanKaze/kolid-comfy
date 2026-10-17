import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  probeSnapshot, probeSend, probeCopy, probeDownload, probeSummary, probeReport, probeProblems,
  subscribeProbe, probeRegistered, traceClear,
  type ProbeProblem, type ProbeSnapshot,
} from './probe';
import { probePanelOpen, setProbePanelOpen, subscribePanel } from './install';

/**
 * 探针面板 —— 探针的"脸"。它只做一件事：**把结论摆在数字旁边。**
 *
 * 三块内容，按排查时的实际读取顺序排：
 *   1. 问题（按级别排序）—— 每条都带数字，因为它就是结论的证据；
 *   2. 布局事实表 —— 声明 / 显示 / flex / 可拖区间逐节点并排，一眼看出是哪一对数字在打架；
 *   3. 轨迹 —— 刚才那几下拖拽读到的 a/b/floor/lo/hi/want，以及投放的 fit。
 *
 * 顶部四颗按钮是出口：**发送**（落到后端、我可以直接读文件）、**复制摘要**（没有后端时的退路，
 * 一段人能读的短报告）、**复制 JSON**、**下载**。前两颗是主路，后两颗是保险。
 */

const C = {
  bg: '#1c1c1e', panel: '#2c2c2e', line: 'rgba(255,255,255,0.09)', text: '#f2f2f7',
  dim: '#98989d', err: '#ff453a', warn: '#ff9f0a', info: '#64d2ff', ok: '#30d158', accent: '#0a84ff',
};
const LEVEL: Record<ProbeProblem['level'], { c: string; label: string }> = {
  error: { c: C.err, label: '错误' },
  warn: { c: C.warn, label: '警告' },
  info: { c: C.info, label: '提示' },
};

const chip = (color: string): React.CSSProperties => ({
  display: 'inline-block', padding: '1px 6px', marginRight: 6, borderRadius: 4, fontSize: 10,
  fontFamily: 'ui-monospace, monospace', color, border: `1px solid ${color}55`, background: `${color}18`,
});
const btn: React.CSSProperties = {
  padding: '5px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer', color: C.text,
  background: C.panel, border: `1px solid ${C.line}`, fontFamily: 'inherit',
};

const Section: React.FC<{ title: string; right?: React.ReactNode; children: React.ReactNode }> = ({ title, right, children }) => (
  <div style={{ marginBottom: 10 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 5px' }}>
      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.4, color: C.dim, textTransform: 'uppercase' }}>{title}</span>
      <span style={{ flex: 1, height: 1, background: C.line }} />
      {right}
    </div>
    {children}
  </div>
);

const PanelBody: React.FC = () => {
  const [open, setOpen] = useState(probePanelOpen());
  const [snap, setSnap] = useState<ProbeSnapshot | null>(null);
  const [flash, setFlash] = useState('');
  const [showAll, setShowAll] = useState(false);
  // 后端在收下快照时会顺手比一下"这一页的产物是不是比源码旧"。只提示两秒是不够的 ——
  // 它是排查的第一个问题，猜错的代价是整轮方向都错，所以它常驻在标题条上，直到确实同步。
  const [stale, setStale] = useState<{ at?: string | null; src?: string } | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => subscribePanel(() => setOpen(probePanelOpen())), []);

  const refresh = useCallback(() => setSnap(probeSnapshot()), []);

  // 打开时抓一份；打开期间 dock 一变就重抓（去抖），于是拖拽时表里的数字是活的 ——
  // "一边拖一边看着声明与显示怎么分叉"比事后任何一次快照都好用。
  useEffect(() => {
    if (!open) return;
    refresh();
    const off = subscribeProbe(() => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(refresh, 220);
    });
    return () => { off(); if (timer.current) window.clearTimeout(timer.current); };
  }, [open, refresh]);

  const say = (m: string): void => { setFlash(m); window.setTimeout(() => setFlash(''), 2600); };

  const doSend = async (): Promise<void> => {
    const r = await probeSend('manual');
    refresh();
    if (!r.ok) { say(`后端不可用（${r.error}）——已放进"复制摘要"这条路`); return; }
    const b = r.build || {};
    setStale(b.stale ? { at: b.bundleAt, src: b.newestSrc } : null);
    say(`已发送 → ${r.file || '后端'}（${Math.round((r.bytes || 0) / 1024)}KB）`);
  };
  const doCopyReport = async (): Promise<void> => {
    const s = probeSnapshot('manual');
    setSnap(s);
    const ok = await navigator.clipboard.writeText(probeReport(s)).catch(() => false);
    say(ok ? '摘要已复制' : '剪贴板不可用，改用下载');
    if (!ok) probeDownload('manual');
  };
  const doCopyJson = async (): Promise<void> => {
    const ok = await probeCopy('manual');
    refresh();
    say(ok ? 'JSON 已复制' : '剪贴板不可用，改用下载');
    if (!ok) probeDownload('manual');
  };

  const rows = snap?.dock?.rows ?? [];
  const shown = useMemo(() => (showAll ? rows : rows.filter(r => r.kind === 'b')), [rows, showAll]);

  if (!open) return null;

  return (
    <div style={{
      position: 'fixed', right: 10, top: 10, bottom: 10, width: 'min(620px, 46vw)', zIndex: 99999,
      background: C.bg, color: C.text, border: `1px solid ${C.line}`, borderRadius: 10,
      boxShadow: '0 10px 40px rgba(0,0,0,0.6)', display: 'flex', flexDirection: 'column',
      font: '12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      {/* 标题条 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: `1px solid ${C.line}` }}>
        <span style={{ fontWeight: 600 }}>界面探针</span>
        <span style={{ ...chip(C.accent) }}>{snap?.build?.slice(-14) || 'dev'}</span>
        {snap && <span style={{ color: snap.problems.some(p => p.level === 'error') ? C.err : snap.problems.length ? C.warn : C.ok }}>
          {probeSummary(snap)}
        </span>}
        {!probeRegistered() && <span style={{ color: C.err }}>未登记 dock</span>}
        {stale && (
          <span style={{ ...chip(C.err) }} title={`产物 ${stale.at} 早于源码 ${stale.src} —— 现在看到的界面不是当前代码画出来的`}>
            这一页比源码旧
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button style={btn} onClick={refresh} title="重新抓取">刷新</button>
        <button style={btn} onClick={() => setProbePanelOpen(false)}>关闭</button>
      </div>

      {/* 出口 */}
      <div style={{ display: 'flex', gap: 6, padding: '8px 10px', borderBottom: `1px solid ${C.line}`, flexWrap: 'wrap' }}>
        <button style={{ ...btn, background: C.accent, borderColor: C.accent }} onClick={doSend}>发送到后端</button>
        <button style={btn} onClick={doCopyReport}>复制摘要</button>
        <button style={btn} onClick={doCopyJson}>复制 JSON</button>
        <button style={btn} onClick={() => { probeDownload('manual'); refresh(); }}>下载</button>
        <button style={btn} onClick={() => { traceClear(); refresh(); say('轨迹已清空'); }}>清轨迹</button>
        <span style={{ marginLeft: 'auto', color: flash ? C.ok : C.dim, alignSelf: 'center' }}>{flash || `视口 ${snap?.page.viewport.w ?? '?'}×${snap?.page.viewport.h ?? '?'} · 树 ${rows.length} 节点`}</span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 10px 16px' }}>
        {/* 1. 问题 */}
        <Section title={`问题 ${snap ? snap.problems.length : 0}`}>
          {snap && snap.problems.length === 0 && <div style={{ color: C.ok }}>没有违反任何不变量。</div>}
          {(snap?.problems ?? []).map((p, i) => (
            <div key={i} style={{ borderLeft: `2px solid ${LEVEL[p.level].c}`, padding: '5px 8px', marginBottom: 5, background: 'rgba(255,255,255,0.025)', borderRadius: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                <span style={chip(LEVEL[p.level].c)}>{p.code}</span>
                <span style={{ color: C.dim, fontSize: 11 }}>{p.where}</span>
              </div>
              <div>{p.message}</div>
              {p.numbers && (
                <div style={{ marginTop: 3, fontFamily: 'ui-monospace, monospace', fontSize: 11, color: C.dim }}>
                  {Object.entries(p.numbers).map(([k, v]) => <span key={k} style={{ marginRight: 10 }}>{k}={String(v)}</span>)}
                </div>
              )}
            </div>
          ))}
        </Section>

        {/* 2. 布局事实 */}
        <Section title="布局事实" right={
          <span style={{ display: 'flex', gap: 6 }}>
            <button style={{ ...btn, padding: '2px 6px', fontSize: 11 }} onClick={() => setShowAll(v => !v)}>
              {showAll ? '只看 block' : '含 split'}
            </button>
          </span>}>
          {snap && <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: C.dim, marginBottom: 5, wordBreak: 'break-all' }}>{snap.outline}</div>}
          <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 58px 58px 56px 1fr', gap: 4, color: C.dim, borderBottom: `1px solid ${C.line}`, paddingBottom: 3 }}>
              <span>节点</span><span>声明</span><span>显示</span><span>flex</span><span>可拖 lo–hi / 备注</span>
            </div>
            {shown.map(r => {
              const off = r.declared !== null && r.rendered !== null && Math.abs(r.declared - r.rendered) > 2;
              const frozen = !!r.travel && r.travel.hi - r.travel.lo < 1;
              return (
                <div key={r.path.join('.') || 'root'} style={{
                  display: 'grid', gridTemplateColumns: '1.5fr 58px 58px 56px 1fr', gap: 4, padding: '2px 0',
                  borderBottom: '1px solid rgba(255,255,255,0.04)',
                }}>
                  <span style={{ paddingLeft: r.depth * 10, color: r.dead ? C.dim : C.text }}>
                    {r.kind === 'b' ? r.block : `${r.dir}[${r.path.join('.') || '/'}]`}
                    {r.work ? ' ·work' : ''}{r.dead ? ' ·dead' : ''}
                    {r.kind === 'b' && r.mode !== 'default' ? ` ·${r.mode}` : ''}
                  </span>
                  <span style={{ color: r.declared === null ? C.dim : C.text }}>{r.declared ?? 'free'}</span>
                  <span style={{ color: off ? C.warn : C.text }}>{r.rendered ?? '—'}</span>
                  <span style={{ color: C.dim }}>{r.flex ?? '—'}</span>
                  <span style={{ color: frozen ? C.warn : C.dim }}>
                    {r.travel ? `${Math.round(r.travel.lo)}–${Math.round(r.travel.hi)}` : '—'}
                    {frozen ? ' ⚠冻结' : ''}
                    {r.scroll && (r.scroll.w > r.scroll.cw + 2 || r.scroll.h > r.scroll.ch + 2) ? ' ·溢出' : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </Section>

        {/* 3. 轨迹 */}
        <Section title={`轨迹 ${snap?.trace.length ?? 0}`}>
          <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, maxHeight: 200, overflowY: 'auto' }}>
            {(snap?.trace ?? []).slice(-40).reverse().map((e, i) => (
              <div key={i} style={{ padding: '1px 0', color: e.mark ? C.info : C.dim }}>
                <span style={{ color: C.text }}>{e.kind}</span>
                {' '}
                {Object.entries(e).filter(([k]) => k !== 'kind' && k !== 't' && k !== 'n').map(([k, v]) => (
                  <span key={k} style={{ marginRight: 8 }}>{k}={typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                ))}
              </div>
            ))}
            {!snap?.trace.length && <span style={{ color: C.dim }}>（空 —— 拖一下把手、投一个窗口，这里就会有记录）</span>}
          </div>
        </Section>

        {/* 4. 组件树 */}
        <Section title={`组件树 ${snap?.components.length ?? 0}`}>
          <details>
            <summary style={{ cursor: 'pointer', color: C.dim, fontSize: 11 }}>展开（props 只留形状）</summary>
            <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, marginTop: 4 }}>
              {(snap?.components ?? []).filter(c => !c.host).slice(0, 200).map((c, i) => (
                <div key={i} style={{ paddingLeft: c.depth * 10, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {c.name}{c.key ? ` key=${c.key}` : ''}
                  {c.props ? <span style={{ color: C.dim }}> {c.props}</span> : null}
                </div>
              ))}
            </div>
          </details>
        </Section>
      </div>
    </div>
  );
};

const ProbeBadge: React.FC = () => {
  const [bad, setBad] = useState(0);
  const [warn, setWarn] = useState(0);
  const [open, setOpen] = useState(probePanelOpen());
  useEffect(() => subscribePanel(() => setOpen(probePanelOpen())), []);
  useEffect(() => {
    const tick = () => {
      const ps = probeProblems();
      setBad(ps.filter(p => p.level === 'error').length);
      setWarn(ps.filter(p => p.level === 'warn').length);
    };
    tick();
    const iv = window.setInterval(tick, 2500);
    const off = subscribeProbe(tick);
    return () => { window.clearInterval(iv); off(); };
  }, []);
  if (open) return null;
  const color = bad ? C.err : warn ? C.warn : C.ok;
  return (
    <button
      onClick={() => setProbePanelOpen(true)}
      title="界面探针：Alt+D 打开面板，Alt+Shift+D 直接抓一份存档"
      style={{
        position: 'fixed', left: 10, bottom: 10, zIndex: 99998, display: 'flex', alignItems: 'center', gap: 6,
        padding: '3px 8px', borderRadius: 20, fontSize: 11, cursor: 'pointer', color,
        background: 'rgba(28,28,30,0.86)', border: `1px solid ${color}66`, backdropFilter: 'blur(8px)',
        opacity: 0.72, font: '11px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
      onMouseEnter={e => { e.currentTarget.style.opacity = '1'; }}
      onMouseLeave={e => { e.currentTarget.style.opacity = '0.72'; }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
      探针 {bad ? `${bad} 错误` : warn ? `${warn} 警告` : '正常'}
    </button>
  );
};

const Probe: React.FC = () => (
  <>
    <ProbeBadge />
    <PanelBody />
  </>
);

export default Probe;

