import React, { useEffect, useRef, useState } from 'react';
import { type AgentCtx, type AgentConfig, runAgentTool } from './tools';
import { useDockWindow } from '../dock/docScope';

// ── Agent dock 窗 = dsh(DeepSeek Harness)sidecar 的 Web UI ──────────────────────────────────
// 这里只框 dsh:它跑在本地 sidecar 里(agent_dsh.py),这个窗负责起停它、把当前 cud 目录
// 经 postMessage 钉成它的工作区。工作台工具不经这个窗转发 —— dsh 的 agent 通过两个 MCP
// (kolid-ui-probe 读现场 / kolid-workbench 改工程)或 tools/wb_agent.py 那条 CLI 桥操作活页面。
//
// 页面这侧仍然要挂 window.__wbAgentTool:MCP 最终落到 /api/agent/direct_tool,它经探针 eval
// 回到这个全局执行(runAgentTool)。窗口没挂载时工具桥也不存在,所以这条是窗口的职责。

// DeepSeek Harness sidecar(agent_dsh.py)的状态镜像。url 是 dsh 启动时打印的带 token 完整
// 地址 —— 无 token 的裸端口是 401,iframe 必须用它。
type DshStatus = {
  ok: boolean; mode: 'stopped' | 'starting' | 'running' | 'stopped_external';
  pid?: number; port?: number; error?: string; url?: string; bind?: string; log?: string[];
};

// /api/agent/*、/api/agent_dsh/* 的应答必须是 JSON。拿到 HTML(DOCTYPE…)= 打到了没有这些
// 路由的后端 —— 把它翻成人话,而不是丢一句 "Unexpected token '<'" 让人猜。
const readJson = async (r: Response): Promise<any> => {
  const text = await r.text();
  try { return JSON.parse(text); } catch {
    throw new Error('Workbench backend did not answer with JSON — restart ComfyUI so the agent routes load.');
  }
};

// 头部图标(SVG,与全应用同一口径 —— 字符字形在 WebView 字体下不稳,项目里踩过这坑)。
const IcStop: React.FC<{ size?: number }> = ({ size = 11 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" stroke="none" style={{ display: 'block' }}>
    <rect x="3.2" y="3.2" width="9.6" height="9.6" rx="1.8" />
  </svg>
);
const IcPlay: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" stroke="none" style={{ display: 'block' }}>
    <path d="M4.4 2.8l8.2 5.2-8.2 5.2z" />
  </svg>
);
const IcExternal: React.FC<{ size?: number }> = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
    <path d="M6.5 3H3.4A1.4 1.4 0 0 0 2 4.4v8.2A1.4 1.4 0 0 0 3.4 14h8.2a1.4 1.4 0 0 0 1.4-1.4V9.5" />
    <path d="M9.5 2h4.5v4.5" />
    <path d="M13.6 2.4L7.8 8.2" />
  </svg>
);

const S = {
  // flex 那一行是必需的:宿主给小窗/块的是"高度由 flex 分配"的父层,只写 height:100% 在小窗里
  // 解析成 auto,iframe 的 flex-basis:0 就只剩 0 —— 正文塌成一条。
  root: { flex: '1 1 auto', height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: '#141416', color: '#c8c8cf', fontSize: 12 } as React.CSSProperties,
  head: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderBottom: '1px solid #26262a', flexShrink: 0 } as React.CSSProperties,
  headBtn: { background: 'none', border: 'none', color: '#9a9aa3', cursor: 'pointer', padding: '2px 4px', fontSize: 13, lineHeight: 1, borderRadius: 4, display: 'flex' } as React.CSSProperties,
  frame: { flex: '1 1 0', minHeight: 0, width: '100%', border: 'none', display: 'block', background: '#0d0d0f' } as React.CSSProperties,
  empty: { margin: 'auto', textAlign: 'center', color: '#6f6f78', lineHeight: 1.8, padding: 20 } as React.CSSProperties,
  primary: { flexShrink: 0, background: '#274a33', color: '#7ee2a0', border: '1px solid #336043', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 } as React.CSSProperties,
};

export const AgentPanel: React.FC<{ ctx: AgentCtx }> = ({ ctx }) => {
  const hostWin = useDockWindow();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const [error, setError] = useState<string | null>(null);
  const [cfg, setCfg] = useState<AgentConfig | null>(null);

  const refreshConfig = async () => {
    try {
      const d = await readJson(await fetch('/api/agent/config'));
      if (d.ok) setCfg(d.config);
    } catch { /* 宿主没起/没重启:留空,端口回退 3080 */ }
  };
  useEffect(() => { void refreshConfig(); }, []);

  // ── DSH sidecar(agent_dsh.py)────────────────────────────────────────────────────────────
  const [dsh, setDsh] = useState<DshStatus | null>(null);
  const dshRefresh = async () => {
    try {
      const d = await readJson(await fetch('/api/agent_dsh/status'));
      setDsh(d);
    } catch (e) {
      // 网络层失败(页面 ↔ 后端失联)与"非 JSON 应答"(旧代码)要分开说 —— 吞成一句通用的
      // unreachable 会把"重开页面"和"重启 ComfyUI"两种修法搅在一起。
      const msg = String((e as Error)?.message || e);
      setDsh({
        ok: false, mode: 'stopped',
        error: /JSON/.test(msg) ? msg
          : 'Workbench server unreachable — this page has lost its backend. Re-run the sampler node so the '
          + 'workbench reopens (a restart may have moved the port); do not reuse an old tab.',
      });
    }
  };
  const dshStart = async () => {
    setError(null);
    try {
      const d = await readJson(await fetch('/api/agent_dsh/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      }));
      setDsh(d);
    } catch (e) { setError(String((e as Error)?.message || e)); }
  };
  const dshStop = async () => {
    try {
      const d = await readJson(await fetch('/api/agent_dsh/stop', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      }));
      setDsh(d);
    } catch { /* ignore */ }
  };
  useEffect(() => {
    void dshRefresh();
    const t = window.setInterval(() => { void dshRefresh(); }, 4000);
    return () => window.clearInterval(t);
  }, []);
  // 设置里开了 autostart 而 sidecar 停着:挂载后补一枪(每次挂载只试一次)。
  const autoTried = useRef(false);
  useEffect(() => {
    if (!cfg?.dsh_autostart || autoTried.current || !dsh) return;
    autoTried.current = true;
    if (dsh.mode === 'stopped') void dshStart();
  }, [cfg?.dsh_autostart, dsh]);
  // 工具桥:MCP / CLI → /api/agent/direct_tool → 探针 eval → 这个全局。挂载即装。
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__wbAgentTool = async (name: string, args: unknown) =>
      runAgentTool(name, args, ctxRef.current);
    return () => { delete (window as unknown as Record<string, unknown>).__wbAgentTool; };
  }, []);
  const dshPort = dsh?.port || cfg?.dsh_port || 3080;
  const dshUrl = dsh?.url || `http://127.0.0.1:${dshPort}/`;
  const dshLabel = dsh == null ? 'Harness —'
    : dsh.mode === 'running' ? `Harness running :${dshPort}`
    : dsh.mode === 'starting' ? 'Harness starting…'
    : dsh.mode === 'stopped_external' ? `Harness on :${dshPort} (external)`
    : 'Harness stopped';

  // ── 工作区绑定 ─────────────────────────────────────────────────────────────────────────────
  // dsh 的工作区只能由它自己的页面去选(跨域 iframe 摸不到 DOM)。所以这里只做两件能说话的事:
  // ① 把当前 cud 的目录报给后端 —— 下一次启动的 cwd(落盘的文件在内);
  // ② 页面已经挂着的那份 dsh,用 postMessage 通知(kolid-dsh-bind 插件在等它)。
  // "换到哪个工作区、别的地方怎么锁"全部由插件在 dsh 页面里完成。
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const dshOrigin = (() => { try { return new URL(dshUrl).origin; } catch { return ''; } })();
  const pushBind = (path: string | null) => {
    const win = frameRef.current?.contentWindow;
    if (win && path != null && dshOrigin) win.postMessage({ type: 'kolid-dsh-bind', path }, dshOrigin);
  };
  useEffect(() => {
    const path = ctx.cudDir;
    if (path == null) return;  // 工作台还没播报过文档,别抢
    void fetch('/api/agent_dsh/bind', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }).catch(() => { /* 后端不在时由状态行报 */ });
    pushBind(path);
  }, [ctx.cudDir, dshOrigin]);
  // 插件每次(重新)挂上都会打招呼:那时把当前目录再说一遍 —— iframe 重载、dsh 重启后
  // postMessage 是唯一能把"现在该在哪个工作区"送进去的通道。
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!dshOrigin || e.origin !== dshOrigin) return;
      if ((e.data as { type?: string } | null)?.type === 'kolid-dsh-bind-ready') pushBind(ctxRef.current.cudDir);
    };
    hostWin.addEventListener('message', onMsg);
    return () => hostWin.removeEventListener('message', onMsg);
  }, [dshOrigin]);

  return (
    <div style={S.root}>
      <div style={S.head}>
        <span title={dsh?.bind ? `Workspace — ${dsh.bind}` : undefined}
          style={{ color: '#9a9aa3', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {dshLabel}
        </span>
        <button style={S.headBtn} title="Open the harness UI standalone"
          onClick={() => window.open(dshUrl, '_blank')}><IcExternal /></button>
        {dsh && (dsh.mode === 'running' || dsh.mode === 'stopped_external')
          ? <button style={S.headBtn} title="Stop the harness sidecar" onClick={() => { void dshStop(); }}><IcStop /></button>
          : <button style={S.headBtn} title="Start the harness sidecar" onClick={() => { void dshStart(); }}><IcPlay /></button>}
      </div>

      {dsh && dsh.mode === 'running' && dsh.url
        ? <iframe key={dsh.url} ref={frameRef} style={S.frame} src={dshUrl} title="DeepSeek Harness"
            onLoad={() => pushBind(ctxRef.current.cudDir)} />
        : (
          <div style={S.empty}>
            <div style={{ fontSize: 13, color: '#c8c8cf', marginBottom: 8 }}>DeepSeek Harness</div>
            <div style={{ fontSize: 11.5, lineHeight: 1.8, maxWidth: 360 }}>
              The official open-source coding agent (<code style={{ color: '#9a9aa3' }}>dsh</code>) runs as a
              local sidecar and its Web UI is framed here. It reads and edits this workbench through the{' '}
              <code style={{ color: '#9a9aa3' }}>kolid-workbench</code> MCP tools — keep this page open.
              First start downloads the package and needs Node.js.
            </div>
            {dsh?.mode === 'starting'
              ? <div style={{ color: '#f5a623', marginTop: 12 }}>Starting… first run downloads the package</div>
              : dsh?.mode === 'stopped_external'
                ? <div style={{ color: '#9a9aa3', marginTop: 12, maxWidth: 360 }}>
                    A harness is already listening on port {dshPort}, but it was not started here (no embed
                    token — framing it would 401). Open it standalone, or stop it and start ours.
                  </div>
                : <button style={{ ...S.primary, marginTop: 12 }} onClick={() => { void dshStart(); }}>Start harness</button>}
            {error && <div style={{ color: '#ff8f8f', marginTop: 10, maxWidth: 360 }}>{error}</div>}
            {dsh?.error && <div style={{ color: '#ff8f8f', marginTop: 10, maxWidth: 360 }}>{dsh.error}</div>}
            {dsh?.mode !== 'starting' && !!dsh?.log?.length && (
              <div style={{ marginTop: 10, maxWidth: 360, color: '#7a7a83', fontFamily: 'ui-monospace, Consolas, monospace',
                fontSize: 10.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {dsh.log.slice(-3).join('\n')}
              </div>
            )}
            <div style={{ marginTop: 12, color: '#6f6f78', fontSize: 11 }}>
              Listens on 127.0.0.1:{dshPort}; the sidecar command lives in data/sampler/agent_settings.json.
            </div>
          </div>
        )}
    </div>
  );
};
