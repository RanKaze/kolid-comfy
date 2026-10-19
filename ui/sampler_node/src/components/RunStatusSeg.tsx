import React from 'react';
import { useBlendUi } from '../workbench/store';

// 运行状态 seg：进度条 + Cancel，钉在文档窗标题条右上、Image/Video 切换的**左边**。
// 原来住在 Staging 格正文里（staging.tsx），用户要它跟着"跑"这件事走 —— 那扇工程画布大窗
// 才是每一趟 run 的主角窗。数据是 blend-ui 快照的 staging 段（busy / cancelLive / progress），
// 真值源与口径一字未动：busy = 有一趟 run 在飞；cancelLive = 这趟可中断（detailer、以及
// Processor 的离线执行 —— 图像路由 blend-run-status 汇回页面、视频路由宿主直接写快照）；
// progress < 0 = 未知，画成一段不定进度。
//
// 订阅只在这颗小组件里 —— 快照在 run 期间每帧都推，别让整个 EditPhase 跟着重渲。
// 闲时返回 null：标题条上只在该有东西的时候出现东西。

const RunStatusSeg: React.FC<{ onCancel: () => void }> = ({ onCancel }) => {
  const s = useBlendUi().staging;
  if (!s.busy && !s.cancelLive) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
      {s.busy && (
        <div title="Run progress" style={{
          width: 72, height: 5, borderRadius: 999, overflow: 'hidden',
          background: 'rgba(255,255,255,0.14)',
        }}>
          <div style={{
            height: '100%', borderRadius: 999, background: '#0a84ff',
            transition: 'width 0.2s ease',
            width: s.progress < 0 ? '30%' : `${Math.max(0.04, Math.min(1, s.progress)) * 100}%`,
          }} />
        </div>
      )}
      {s.cancelLive && (
        <button type="button"
          title="Cancel — interrupt the current run (works mid-block, mid-sampling or during Generate Text)"
          onClick={onCancel}
          style={{
            border: 'none', borderRadius: 999, padding: '2px 11px', fontSize: 10.5,
            fontWeight: 700, lineHeight: 1.5, cursor: 'pointer', flexShrink: 0,
            color: '#fff', background: 'rgba(255,69,58,0.92)',
          }}>Cancel</button>
      )}
    </div>
  );
};

export default RunStatusSeg;
