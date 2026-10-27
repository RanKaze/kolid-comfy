import React, { useEffect, useRef, useState } from 'react';
import { type AgentCtx, type AgentConfig, runAgentTool } from './tools';

// ── Agent dock 窗 ────────────────────────────────────────────────────────────────────────────
// 聊天栏 + 工具执行回路。LLM 循环住在后端(agent_backend.py):这里 POST /api/agent/send 开一条
// run,然后长轮询 /api/agent/poll 收事件(text / tool_call / tool_result / error);收到 tool_call
// 就在页面里执行(runAgentTool),把结果 POST /api/agent/tool 交回去,LLM 接着走下一步。
// 会话历史存 localStorage(sampler.agentChat.v1),随消息带回去 —— 后端不落盘对话。
// LLM 端点配置不住这里:Settings 页 ▸ Agent 屏是它的家,这里只读一份做状态提示。

type ToolPart = {
  kind: 'tool'; callId: string; name: string; args: string;
  status: 'run' | 'ok' | 'err'; result?: string;
};
type Part = { kind: 'text'; text: string } | ToolPart;
type Msg = { id: string; role: 'user' | 'assistant'; parts: Part[]; error?: string };

type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call_id: string; name: string; args: unknown }
  | { type: 'tool_result'; call_id: string; name: string; ok: boolean; content: string }
  | { type: 'error'; message: string };

type Phase = 'idle' | 'thinking' | 'acting';

const CHAT_STORE = 'sampler.agentChat.v1';
const MODE_STORE = 'sampler.agentMode';

// DeepSeek Harness sidecar(agent_dsh.py)的状态镜像。url 是 dsh 启动时打印的带 token 完整
// 地址 —— 无 token 的裸端口是 401,iframe 必须用它。
type DshStatus = {
  ok: boolean; mode: 'stopped' | 'starting' | 'running' | 'stopped_external';
  pid?: number; port?: number; error?: string; url?: string; log?: string[];
};
const json = (v: unknown, max = 400): string => {
  let s: string;
  try { s = typeof v === 'string' ? v : JSON.stringify(v, null, 1); } catch { s = String(v); }
  return s.length > max ? s.slice(0, max) + '…' : s;
};

// /api/agent/* 的应答必须是 JSON。拿到 HTML(DOCTYPE…)= 打到了没有 agent 路由的旧后端 ——
// 把它翻成人话,而不是丢一句 "Unexpected token '<'" 让人猜。
const readJson = async (r: Response): Promise<any> => {
  const text = await r.text();
  try { return JSON.parse(text); } catch {
    throw new Error('Agent backend did not answer with JSON — restart ComfyUI so the /api/agent routes load.');
  }
};

const loadChat = (): Msg[] => {
  try {
    const raw = localStorage.getItem(CHAT_STORE);
    const arr = raw ? JSON.parse(raw) : null;
    return Array.isArray(arr) ? arr.filter((m: Msg) => m && m.role && Array.isArray(m.parts)) : [];
  } catch { return []; }
};
const saveChat = (msgs: Msg[]) => {
  try {
    const trimmed = msgs.slice(-80).map(m => ({
      ...m,
      parts: m.parts.map(p => p.kind === 'tool' && p.result && p.result.length > 500
        ? { ...p, result: p.result.slice(0, 500) + '…' } : p),
    }));
    localStorage.setItem(CHAT_STORE, JSON.stringify(trimmed));
  } catch { /* 配额满就算了 */ }
};

const PHASE_TEXT: Record<Phase, string> = { idle: 'Idle', thinking: 'Thinking…', acting: 'Working…' };
const PHASE_COLOR: Record<Phase, string> = { idle: '#5a5a63', thinking: '#f5a623', acting: '#30d158' };

// 头部两颗小图标(SVG,与全应用同一口径 —— 字符字形在 WebView 字体下不稳,项目里踩过这坑)。
const IcTrash: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
    <path d="M2.5 4.4h11" />
    <path d="M5.6 4.4V3.1a1 1 0 0 1 1-1h2.8a1 1 0 0 1 1 1v1.3" />
    <path d="M4.1 4.4l.65 8.3a1.4 1.4 0 0 0 1.4 1.3h3.7a1.4 1.4 0 0 0 1.4-1.3l.65-8.3" />
    <path d="M6.6 7.1v3.9M9.4 7.1v3.9" opacity="0.65" />
  </svg>
);
const IcSend: React.FC<{ size?: number }> = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
    <path d="M2.6 8h10.2" />
    <path d="M8.6 3.6L13 8l-4.4 4.4" />
  </svg>
);
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
  dot: (c: string) => ({ width: 7, height: 7, borderRadius: '50%', background: c, flexShrink: 0 } as React.CSSProperties),
  headBtn: { background: 'none', border: 'none', color: '#9a9aa3', cursor: 'pointer', padding: '2px 4px', fontSize: 13, lineHeight: 1, borderRadius: 4, display: 'flex' } as React.CSSProperties,
  seg: { display: 'flex', gap: 2, padding: 2, borderRadius: 7, background: 'rgba(118,118,128,0.24)', flexShrink: 0 } as React.CSSProperties,
  segBtn: (on: boolean) => ({ border: 'none', borderRadius: 5, padding: '2px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer', background: on ? '#636366' : 'transparent', color: on ? '#fff' : 'rgba(255,255,255,0.62)' } as React.CSSProperties),
  frame: { flex: '1 1 0', minHeight: 0, width: '100%', border: 'none', display: 'block', background: '#0d0d0f' } as React.CSSProperties,
  list: { flex: '1 1 0', minHeight: 0, overflowY: 'auto', padding: '10px 10px 6px', display: 'flex', flexDirection: 'column', gap: 10 } as React.CSSProperties,
  empty: { margin: 'auto', textAlign: 'center', color: '#6f6f78', lineHeight: 1.8, padding: 20 } as React.CSSProperties,
  user: { alignSelf: 'flex-end', maxWidth: '88%', background: '#25314a', color: '#dfe3ea', borderRadius: '10px 10px 2px 10px', padding: '7px 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 } as React.CSSProperties,
  bot: { alignSelf: 'stretch', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } as React.CSSProperties,
  botText: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.55, color: '#c8c8cf' } as React.CSSProperties,
  botErr: { alignSelf: 'stretch', background: '#3a1d1d', border: '1px solid #5c2b2b', color: '#ff9b9b', borderRadius: 8, padding: '6px 9px', whiteSpace: 'pre-wrap', lineHeight: 1.5 } as React.CSSProperties,
  tool: { border: '1px solid #2c2c31', background: '#1b1b1f', borderRadius: 8, padding: '5px 8px', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11, cursor: 'pointer', minWidth: 0 } as React.CSSProperties,
  toolHead: { display: 'flex', alignItems: 'center', gap: 6, color: '#9a9aa3' } as React.CSSProperties,
  toolDot: (st: ToolPart['status']) => ({ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: st === 'run' ? '#f5a623' : st === 'ok' ? '#30d158' : '#ff453a' } as React.CSSProperties),
  toolBody: { marginTop: 5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#8f8f99', borderTop: '1px solid #2c2c31', paddingTop: 5 } as React.CSSProperties,
  errBar: { flexShrink: 0, margin: '0 10px 6px', background: '#3a1d1d', border: '1px solid #5c2b2b', color: '#ff9b9b', borderRadius: 8, padding: '6px 9px', whiteSpace: 'pre-wrap', cursor: 'pointer' } as React.CSSProperties,
  composer: { flexShrink: 0, borderTop: '1px solid #26262a', padding: 8, display: 'flex', gap: 6, alignItems: 'flex-end' } as React.CSSProperties,
  input: { flex: 1, resize: 'none', background: '#1b1b1f', border: '1px solid #2c2c31', borderRadius: 8, color: '#d8d8de', padding: '7px 9px', fontSize: 12, lineHeight: 1.45, maxHeight: 120, outline: 'none', fontFamily: 'inherit', minWidth: 0 } as React.CSSProperties,
  stop: { flexShrink: 0, background: '#4a2727', color: '#ff8f8f', border: '1px solid #5c2b2b', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 } as React.CSSProperties,
  send: { flexShrink: 0, background: '#274a33', color: '#7ee2a0', border: '1px solid #336043', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 } as React.CSSProperties,
};

let msgSeq = 0;
const newId = (): string => `m${Date.now().toString(36)}${(msgSeq++).toString(36)}`;

const ToolRow: React.FC<{ part: ToolPart; open: boolean; onToggle: () => void }> = ({ part, open, onToggle }) => (
  <div style={S.tool} onClick={e => { e.stopPropagation(); onToggle(); }}>
    <div style={S.toolHead}>
      <span style={S.toolDot(part.status)} />
      <span style={{ color: '#c9c9d1' }}>{part.name}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{part.args}</span>
      {part.status === 'run' && <span style={{ color: '#f5a623' }}>…</span>}
    </div>
    {open && (
      <div style={S.toolBody}>
        {part.result ? `→ ${part.result}` : '→ (running)'}
      </div>
    )}
  </div>
);

export const AgentPanel: React.FC<{ ctx: AgentCtx }> = ({ ctx }) => {
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const [msgs, setMsgs] = useState<Msg[]>(loadChat);
  const [phase, setPhase] = useState<Phase>('idle');
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [openTools, setOpenTools] = useState<Set<string>>(new Set());
  const [cfg, setCfg] = useState<AgentConfig | null>(null);

  const busyRef = useRef(false);
  const runIdRef = useRef('');
  const cancelRef = useRef(false);
  const turnRef = useRef('');
  const pollAbortRef = useRef<AbortController | null>(null);
  const msgsRef = useRef(msgs);
  msgsRef.current = msgs;
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // 卸载:掀掉在跑的回路(本地 abort;服务端 run 让它自然结束/超时)。
  useEffect(() => () => {
    cancelRef.current = true;
    pollAbortRef.current?.abort();
  }, []);

  // 存档(去抖)。
  useEffect(() => {
    const t = setTimeout(() => saveChat(msgs), 350);
    return () => clearTimeout(t);
  }, [msgs]);

  const refreshConfig = async () => {
    try {
      const d = await readJson(await fetch('/api/agent/config'));
      if (d.ok) setCfg(d.config);
    } catch { /* 宿主没起/没重启:留空,send 会报错 */ }
  };
  useEffect(() => { void refreshConfig(); }, []);

  // ── DSH sidecar(agent_dsh.py):Agent 窗的默认形态 = iframe 它的 Web UI ────────────────────
  const [mode, setMode] = useState<'dsh' | 'chat'>(() => {
    try { return localStorage.getItem(MODE_STORE) === 'chat' ? 'chat' : 'dsh'; } catch { return 'dsh'; }
  });
  const pickMode = (m: 'dsh' | 'chat') => {
    setMode(m);
    try { localStorage.setItem(MODE_STORE, m); } catch { /* ignore */ }
  };
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
    if (mode !== 'dsh') return;
    void dshRefresh();
    const t = window.setInterval(() => { void dshRefresh(); }, 4000);
    return () => window.clearInterval(t);
  }, [mode]);
  // 设置里开了 autostart 而 sidecar 停着:进 DSH 模式后补一枪(每次挂载只试一次)。
  const autoTried = useRef(false);
  useEffect(() => {
    if (mode !== 'dsh' || !cfg?.dsh_autostart || autoTried.current || !dsh) return;
    autoTried.current = true;
    if (dsh.mode === 'stopped') void dshStart();
  }, [mode, cfg?.dsh_autostart, dsh]);
  // 工具桥:终端侧 agent(dsh)→ /api/agent/direct_tool → 探针 eval → 这个全局。挂载即装,
  // Chat/DSH 两个模式都在 —— dsh 的 agent 哪种模式都调得动工作台。
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

  // ── 转写辅助 ───────────────────────────────────────────────────────────────────────────────
  const appendToTurn = (part: Part) => {
    if (!turnRef.current) {
      turnRef.current = newId();
      setMsgs(m => [...m, { id: turnRef.current, role: 'assistant', parts: [part] }]);
    } else {
      setMsgs(m => m.map(x => (x.id === turnRef.current ? { ...x, parts: [...x.parts, part] } : x)));
    }
  };
  const appendTurnError = (message: string) => {
    if (turnRef.current) {
      setMsgs(m => m.map(x => (x.id === turnRef.current ? { ...x, error: message } : x)));
    } else {
      turnRef.current = newId();
      setMsgs(m => [...m, { id: turnRef.current, role: 'assistant', parts: [], error: message }]);
    }
  };
  const updateToolPart = (callId: string, patch: Partial<ToolPart>) => {
    setMsgs(m => m.map(x => ({
      ...x,
      parts: x.parts.map(p => (p.kind === 'tool' && p.callId === callId ? { ...p, ...patch } : p)),
    })));
  };

  // ── run 回路 ───────────────────────────────────────────────────────────────────────────────
  const loop = async (runId: string) => {
    let cursor = 0;
    const pending = new Map<string, { name: string; args: string }>();
    try {
      while (true) {
        if (cancelRef.current) break;
        const ctl = new AbortController();
        pollAbortRef.current = ctl;
        const timer = setTimeout(() => ctl.abort(), 40000);
        let d: { ok: boolean; status?: string; events?: AgentEvent[]; cursor?: number; error?: string };
        try {
          const r = await fetch(`/api/agent/poll?run_id=${runId}&cursor=${cursor}&wait=1`, { signal: ctl.signal });
          d = await readJson(r);
        } finally { clearTimeout(timer); }
        if (!d.ok) throw new Error(d.error || 'poll failed');
        cursor = d.cursor ?? cursor;
        const events = d.events ?? [];
        for (const ev of events) {
          if (ev.type === 'text') {
            appendToTurn({ kind: 'text', text: ev.text });
          } else if (ev.type === 'tool_call') {
            const args = json(ev.args);
            pending.set(ev.call_id, { name: ev.name, args });
            appendToTurn({ kind: 'tool', callId: ev.call_id, name: ev.name, args, status: 'run' });
          } else if (ev.type === 'tool_result') {
            updateToolPart(ev.call_id, { status: ev.ok ? 'ok' : 'err', result: ev.content });
          } else if (ev.type === 'error') {
            appendTurnError(ev.message);
          }
        }
        setPhase(d.status === 'wait_tool' ? 'acting' : d.status === 'running' ? 'thinking' : 'idle');
        if (d.status === 'done' || d.status === 'error' || d.status === 'cancelled') break;
        if (d.status === 'wait_tool' && pending.size) {
          // 页面里执行(串行,保持顺序),再一起交回后端喂 LLM。
          const results: { call_id: string; name: string; ok: boolean; content: string }[] = [];
          for (const [callId, c] of [...pending]) {
            pending.delete(callId);
            let res: { ok: boolean; content: string };
            try {
              let parsed: unknown = c.args;
              try { parsed = JSON.parse(c.args); } catch { /* 字符串原样给 */ }
              res = await runAgentTool(c.name, parsed, ctxRef.current);
            } catch (e) {
              res = { ok: false, content: `tool crashed: ${String((e as Error)?.message || e)}` };
            }
            results.push({ call_id: callId, name: c.name, ok: res.ok, content: res.content });
            updateToolPart(callId, { status: res.ok ? 'ok' : 'err', result: res.content });
          }
          if (results.length) {
            await fetch('/api/agent/tool', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ run_id: runId, results }),
            });
          }
        }
      }
    } catch (e) {
      if (!cancelRef.current) appendTurnError(String((e as Error)?.message || e));
    } finally {
      turnRef.current = '';
      runIdRef.current = '';
      busyRef.current = false;
      setPhase('idle');
      pollAbortRef.current = null;
      // 卡在 wait_tool 的孤儿调用:兜底交回错误结果,别让后端挂满 600s。
      if (pending.size && runId) {
        void fetch('/api/agent/tool', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            run_id: runId,
            results: [...pending].map(([call_id, c]) => ({ call_id, name: c.name, ok: false, content: '(interrupted)' })),
          }),
        }).catch(() => {});
      }
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busyRef.current) return;
    busyRef.current = true;
    cancelRef.current = false;
    turnRef.current = '';
    setError(null);
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    stickRef.current = true;
    setMsgs(m => [...m, { id: newId(), role: 'user', parts: [{ kind: 'text', text }] }]);
    try {
      const history = msgsRef.current
        .filter(x => !x.error)
        .slice(-30)
        .map(x => ({ role: x.role, content: x.parts.filter(p => p.kind === 'text').map(p => (p as { text: string }).text).join('\n\n') }))
        .filter(x => x.content);
      const r = await fetch('/api/agent/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, history }),
      });
      const d = await readJson(r);
      if (!d.ok) throw new Error(d.error || 'send failed');
      runIdRef.current = d.run_id as string;
      void loop(d.run_id as string);
    } catch (e) {
      busyRef.current = false;
      setPhase('idle');
      setError(String((e as Error)?.message || e));
    }
  };

  const stop = () => {
    cancelRef.current = true;
    pollAbortRef.current?.abort();
    const rid = runIdRef.current;
    if (rid) void fetch('/api/agent/cancel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run_id: rid }),
    }).catch(() => {});
    busyRef.current = false;
    turnRef.current = '';
    setPhase('idle');
  };

  const clearChat = () => {
    if (busyRef.current) stop();
    setMsgs([]);
    turnRef.current = '';
    try { localStorage.removeItem(CHAT_STORE); } catch { /* ignore */ }
  };

  // 自动滚底:贴底才跟,用户往上翻就不打扰。
  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [msgs, phase]);
  const onListScroll = () => {
    const el = listRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const busy = phase === 'thinking' || phase === 'acting';
  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  return (
    <div style={S.root}>
      <div style={S.head}>
        <div style={S.seg}>
          <button style={S.segBtn(mode === 'dsh')} onClick={() => pickMode('dsh')}
            title="DeepSeek Harness sidecar — the official open-source coding agent, framed here">DSH</button>
          <button style={S.segBtn(mode === 'chat')} onClick={() => pickMode('chat')}
            title="Built-in chat agent (lightweight, no Node needed)">Chat</button>
        </div>
        {mode === 'chat' ? (
          <>
            <span style={S.dot(PHASE_COLOR[phase])} />
            <span style={{ color: '#9a9aa3', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {PHASE_TEXT[phase]}{cfg?.model ? ` — ${cfg.model}` : ''}
              {cfg && !cfg.api_key ? ' — no API key (Settings ▸ Agent)' : ''}
            </span>
            <button style={S.headBtn} title="Clear conversation" onClick={clearChat}><IcTrash /></button>
          </>
        ) : (
          <>
            <span style={{ color: '#9a9aa3', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {dshLabel}
            </span>
            <button style={S.headBtn} title="Open the harness UI standalone"
              onClick={() => window.open(dshUrl, '_blank')}><IcExternal /></button>
            {dsh && (dsh.mode === 'running' || dsh.mode === 'stopped_external')
              ? <button style={S.headBtn} title="Stop the harness sidecar" onClick={() => { void dshStop(); }}><IcStop /></button>
              : <button style={S.headBtn} title="Start the harness sidecar" onClick={() => { void dshStart(); }}><IcPlay /></button>}
          </>
        )}
      </div>

      {mode === 'dsh' && (
        dsh && dsh.mode === 'running' && dsh.url
          ? <iframe key={dsh.url} style={S.frame} src={dshUrl} title="DeepSeek Harness" />
          : (
            <div style={S.empty}>
              <div style={{ fontSize: 13, color: '#c8c8cf', marginBottom: 8 }}>DeepSeek Harness</div>
              <div style={{ fontSize: 11.5, lineHeight: 1.8, maxWidth: 360 }}>
                The official open-source coding agent (<code style={{ color: '#9a9aa3' }}>dsh</code>) runs as a
                local sidecar and its Web UI is framed here. It drives the workbench through the{' '}
                <code style={{ color: '#9a9aa3' }}>wb</code> bridge (tools/wb_agent.py) — keep this page open.
                First start downloads the package and needs Node.js.
              </div>
              {dsh?.mode === 'starting'
                ? <div style={{ color: '#f5a623', marginTop: 12 }}>Starting… first run downloads the package</div>
                : dsh?.mode === 'stopped_external'
                  ? <div style={{ color: '#9a9aa3', marginTop: 12, maxWidth: 360 }}>
                      A harness is already listening on port {dshPort}, but it was not started here (no embed
                      token — framing it would 401). Open it standalone, or stop it and start ours.
                    </div>
                  : <button style={{ ...S.send, marginTop: 12 }} onClick={() => { void dshStart(); }}>Start harness</button>}
              {dsh?.error && <div style={{ color: '#ff8f8f', marginTop: 10, maxWidth: 360 }}>{dsh.error}</div>}
              {dsh?.mode !== 'starting' && !!dsh?.log?.length && (
                <div style={{ marginTop: 10, maxWidth: 360, color: '#7a7a83', fontFamily: 'ui-monospace, Consolas, monospace',
                  fontSize: 10.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {dsh.log.slice(-3).join('\n')}
                </div>
              )}
              <div style={{ marginTop: 12, color: '#6f6f78', fontSize: 11 }}>
                Command / port / API key live in Settings ▸ Agent.
              </div>
            </div>
          )
      )}
      {mode === 'chat' && (<>
      <div style={S.list} ref={listRef} onScroll={onListScroll}>
        {msgs.length === 0 && !busy && (
          <div style={S.empty}>
            Ask the agent to operate the workbench.<br />
            <span style={{ fontSize: 11 }}>
              “look at the timeline and tighten the cuts around 4s” · “put this asset on a layer” · “run the second preset”
            </span>
          </div>
        )}
        {msgs.map(m => (
          <React.Fragment key={m.id}>
            {m.role === 'user'
              ? <div style={S.user}>{m.parts[0].kind === 'text' ? m.parts[0].text : ''}</div>
              : (
                <div style={S.bot}>
                  {m.parts.map((p, i) => p.kind === 'text'
                    ? <div key={i} style={S.botText}>{p.text}</div>
                    : <ToolRow key={p.callId} part={p} open={openTools.has(p.callId)}
                        onToggle={() => setOpenTools(prev => {
                          const next = new Set(prev);
                          if (next.has(p.callId)) next.delete(p.callId); else next.add(p.callId);
                          return next;
                        })} />)}
                  {m.error && <div style={S.botErr}>{m.error}</div>}
                </div>
              )}
          </React.Fragment>
        ))}
      </div>

      {error && <div style={S.errBar} onClick={() => setError(null)}>{error}</div>}

      <div style={S.composer}>
        <textarea ref={inputRef} style={S.input} rows={1} value={input}
          placeholder={cfg && !cfg.api_key ? 'No API key yet — set it in Settings ▸ Agent' : 'Tell the agent what to do…'}
          onChange={e => { setInput(e.target.value); grow(e.target); }}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
          }} />
        {busy
          ? <button style={S.stop} onClick={stop}><IcStop />Stop</button>
          : <button style={{ ...S.send, opacity: input.trim() ? 1 : 0.45 }} onClick={() => { void send(); }}>Send<IcSend /></button>}
      </div>
      </>)}
    </div>
  );
};
