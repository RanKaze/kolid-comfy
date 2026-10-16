import React from 'react';
import { wbStyles } from './skin';
import { useBlendUi } from './store';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';

// 3D 那一格：选中层那枚 3D 记录的跳转与状态。完整编辑（fly、inspector、Render to Layer）仍在场景 tab
// 的 #scenePanel —— 它是另一个视口，不是一排参数。这里只有三句话：哪枚记录、烘了没有、进去。
// 页面原来靠"选中带 3D 步骤的层"整节点亮（.active-tool），搬进 dock 以后正文自己上那一层底色。

const Scene3dBody: React.FC<WorkbenchUnitProps> = ({ send }) => {
  const ui = useBlendUi();
  const s = ui.scene3d;
  return (
    <div style={{ ...wbStyles.stack, padding: 4, ...(s.on ? wbStyles.armed : null) }}>
      <div style={wbStyles.ctrl}>
        <label style={wbStyles.ctrlLabel}>Scene</label>
        <button type="button" style={{ ...wbStyles.btn, ...(s.canOpen ? null : wbStyles.btnOff) }}
          disabled={!s.canOpen}
          title={'Open the 3D scene behind the selected layer\'s 3D step as a tab — fly it, then Render to Layer '
            + 'bakes the frame onto that step'}
          onClick={() => send('scene3d-open')}>Open Scene</button>
      </div>
      <div style={wbStyles.note} title={s.note}>{s.note}</div>
    </div>
  );
};

export const scene3dUnit: WorkbenchUnit = {
  id: 'scene3d',
  title: '3D',
  hint: '3D — the scene behind the selected layer’s 3D step. Open the scene as a tab, fly it, then Render to '
    + 'Layer bakes the frame onto that step of the strip.',
  Body: Scene3dBody,
};
