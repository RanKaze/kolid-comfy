import React, { useEffect, useRef, useState } from 'react';
import type { BlendDoc } from '../types';
import { useDockWindow } from './docScope';
import { detachToChild, registerChild } from './docEngine';

// 文档窗弹进 owned 子窗口之后的正文：**子窗口里新起一台 workbench**（iframe 从零加载），
// 主引擎那份文档在交接完成后被卸下。搬主页面那台 iframe 会重载（跨 document），所有打开的
// 工程会一起没，所以这里只搬字节（见 dock/docEngine.ts）。
//
// 交接完成前先盖一层"正在准备文档"；失败就交给调用方泊回（主引擎里已用同一份字节重开）。
export const DetachedDocBody: React.FC<{
  doc: BlendDoc;
  onDetached: (doc: BlendDoc) => void;
  onFail: (doc: BlendDoc, err: unknown) => void;
}> = ({ doc, onDetached, onFail }) => {
  const win = useDockWindow();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const cbRef = useRef({ onDetached, onFail });
  cbRef.current = { onDetached, onFail };

  useEffect(() => {
    const iframe = frameRef.current;
    if (!iframe) return;
    if (win === window) return;   // 只在弹窗文档里工作；主页面里出现的这条是占位
    let alive = true;
    // 先登记：子引擎 boot 时发出的 blend-docs / 请求要有人接。
    registerChild(doc.uid, win, iframe);
    // 先把它记成 detached：主引擎卸下文档时会发一份"没有它"的 blend-docs，宿主若还没这条
    // 记录，会把整扇窗从 dock 里剪掉 —— 子窗口也跟着塌，交接就断在半路。失败再撤这条记录。
    cbRef.current.onDetached(doc);
    void detachToChild(doc.uid, win, iframe)
      .then(() => {
        if (!alive) return;
        setPhase('ready');
      })
      .catch(e => {
        if (!alive) return;
        setError(String((e as Error)?.message || e));
        setPhase('error');
        cbRef.current.onFail(doc, e);
      });
    return () => { alive = false; };
  }, [doc.uid, win]);

  return (
    <div style={{ position: 'relative', flex: '1 1 auto', minHeight: 0, minWidth: 0, background: '#0d0d0d' }}>
      <iframe
        ref={frameRef}
        src="/blend_node.html"
        title={'Workbench — ' + doc.name}
        allow="clipboard-write"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, background: '#0d0d0d' }}
      />
      {phase !== 'ready' && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: phase === 'error' ? undefined : 'none', background: 'rgba(13,13,13,0.72)',
          color: 'rgba(255,255,255,0.72)', fontSize: 12, textAlign: 'center', padding: 20,
        }}>
          {phase === 'loading'
            ? 'Preparing the document in this window…'
            : <span style={{ color: '#ff9f9a' }}>The canvas could not move here — {error}</span>}
        </div>
      )}
    </div>
  );
};
