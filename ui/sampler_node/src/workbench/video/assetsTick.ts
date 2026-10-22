// 资产仓库"外面又写了一件"的信号。仓库没有推送通道（/api/global_assets 是拉的），而 Assets 窗
// 攥着自己的那份清单 —— 别人（Processor 的 Assets 落位、宿主的导入、.cud 读档）写完之后敲一下
// 这里，订阅者自己重拉、自己重渲，不值得惊动整页 state。
let n = 0;
const subs = new Set<() => void>();

export const bumpAssets = (): void => { n++; subs.forEach(fn => fn()); };

export const assetsTick = (): number => n;

export const subscribeAssets = (fn: () => void): (() => void) => {
  subs.add(fn);
  return () => { subs.delete(fn); };
};
