import React from 'react';

// 一个 dock 单元的正文此刻住在哪个 document 里。
//
// 默认是主页面；被弹进 Kolid Desktop 的 owned 子窗口之后，React portal 把正文画在
// 弹窗自己的文档里 —— 那时组件自己的 `document.body` 浮层（菜单、popover）和全局
// 监听必须跟着宿主走，否则菜单会开在主窗口、点外面也关不掉。所有会渲染到单元正文
// 里的组件都从这里取 document，而不是直接摸全局 document。
export const DockDocumentContext = React.createContext<Document | null>(null);

export const useDockDocument = (): Document => React.useContext(DockDocumentContext) ?? document;
export const useDockWindow = (): Window => useDockDocument().defaultView ?? window;
