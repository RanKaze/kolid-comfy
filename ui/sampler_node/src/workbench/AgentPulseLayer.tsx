/**
 * Agent 脉冲的**画框**：一扇窗被 MCP 碰到时，在它外沿画一圈淡淡的绿色，1.6 秒淡出。
 *
 * 为什么是浮层而不是给窗加 className：dock 的卡片有三种形态（分块成员 / 浮窗 / 单格块），
 * 每种的包裹元素不一样，而且拖拽/折叠会重建它们 —— 给三种都加 className 要动布局代码，
 * 还得保证动画不参与布局。浮层只读 DOM 的 `getBoundingClientRect`，DockView 那边只需要
 * 在窗根上加一个 `data-dock-win` 属性，改布局的风险为零。
 *
 * 位置每帧跟着读：拖分隔条、滚列表、缩窗口的时候框都贴着窗走。代价是每帧一次
 * `querySelector`（同一时刻通常只有一两个脉冲），换来的是不用订阅任何布局事件。
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AGENT_PULSE_MS, useAgentHits, type AgentHit } from './agentPulse';

/** 0→1 淡入 140ms，停 900ms，最后 500ms 淡出。曲线在 JS 里算，不引 keyframes。 */
const fade = (ms: number): number => {
  if (ms < 0) return 0;
  if (ms < 140) return ms / 140;
  if (ms < 1050) return 1;
  return Math.max(0, 1 - (ms - 1050) / (AGENT_PULSE_MS - 1050));
};

// "不是很亮的那种"：1px 半透明绿边 + 一圈更淡的外晕 + 几乎看不见的底色。
// 绿是 agent 窗自己的标识色（EditPhase 的 UNIT_COLORS.agent），所以"这扇窗被动过"读起来是
// 一致的，不需要再加图例。
const BOX: React.CSSProperties = {
  position: 'fixed',
  left: 0,
  top: 0,
  pointerEvents: 'none',
  zIndex: 66,
  borderRadius: 9,
  boxShadow: '0 0 0 1px rgba(48,209,88,0.48), 0 0 0 5px rgba(48,209,88,0.09)',
  background: 'rgba(48,209,88,0.035)',
  visibility: 'hidden',
  willChange: 'transform, opacity, width, height',
};

const Frame: React.FC<{ hit: AgentHit }> = ({ hit }) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const box = ref.current;
      if (box) {
        const el = document.querySelector<HTMLElement>(`[data-dock-win="${hit.unit}"]`);
        // 面板被关掉/折进 tab：找不到宿主就不画。静默是刻意的 —— 提示缺席不算失败。
        if (el && el.isConnected) {
          const r = el.getBoundingClientRect();
          const a = fade(performance.now() - hit.at);
          box.style.visibility = a > 0.002 ? 'visible' : 'hidden';
          box.style.opacity = String(a);
          box.style.transform = `translate3d(${r.left}px, ${r.top}px, 0)`;
          box.style.width = `${r.width}px`;
          box.style.height = `${r.height}px`;
        } else {
          box.style.visibility = 'hidden';
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hit.unit, hit.at]);

  return <div ref={ref} data-agent-pulse={hit.unit} title={hit.label} style={BOX} />;
};

/** 挂在 dock 根节点里调用，但**画到 body 上**：`overflow: hidden` 的那层外框裁不到 portal，
 *  将来谁给某个祖先加了 transform 也不会把 `position: fixed` 变成"相对那个祖先"。 */
export const AgentPulseLayer: React.FC = () => {
  const hits = useAgentHits();
  if (!hits.length) return null;
  return createPortal(
    <>{hits.map(h => <Frame key={`${h.unit}@${h.at}`} hit={h} />)}</>,
    document.body,
  );
};
