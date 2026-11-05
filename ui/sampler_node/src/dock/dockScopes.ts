import { type Dock, type UnitId, scopeUnits, takeUnits } from './model';

// ── 一页 dock 的作用域 ────────────────────────────────────────────────────────────────────
// 主页面是一页，每一扇子窗口里的 Block 系统也是一页。拖拽可以**跨页**（从主窗口拖进子窗口、
// 从子窗口拖回主窗口、子窗口之间互拖），而 HTML5 的拖拽载荷只负责"手里拿着什么"，不负责
// "它原来住在哪一页"。这个注册表补的就是后者：落下时先把这些单元从**别的页**上拿走，再在
// 落点那一页里按平常的 dropUnits 摆好。
//
// 作用域只认"这一页自己直接管的单元"（scopeUnits：树 + 页面内浮窗），不钻进子窗口里的那一页 ——
// 否则主页面会把子窗口里的单元也当成自己的，两页同时删一次。
type Scope = { id: string; get: () => Dock; set: (next: Dock | ((prev: Dock) => Dock)) => void };
const scopes = new Map<string, Scope>();

export const registerDockScope = (scope: Scope): (() => void) => {
  scopes.set(scope.id, scope);
  return () => {
    if (scopes.get(scope.id) === scope) scopes.delete(scope.id);
  };
};

/** 这个单元此刻归哪一页管。没找到（还没挂上）就返回 null。 */
export const ownerScopeOf = (id: UnitId): string | null => {
  for (const [key, s] of scopes) {
    try { if (scopeUnits(s.get()).includes(id)) return key; } catch { /* the page is going away */ }
  }
  return null;
};

/**
 * 把 `ids` 从除 `except` 以外的每一页上拿走。落点那一页自己还拿着的单元不在这里处理 —— 那一页
 * 的 dropUnits 本来就会把它们先摘出来再放。
 */
export const takeUnitsFromOtherScopes = (ids: readonly UnitId[], except: string): void => {
  if (!ids.length) return;
  for (const [key, s] of [...scopes]) {
    if (key === except) continue;
    let owned: UnitId[] = [];
    try { owned = scopeUnits(s.get()).filter(u => ids.includes(u)); } catch { continue; }
    if (!owned.length) continue;
    s.set(prev => takeUnits(prev, owned));
  }
};