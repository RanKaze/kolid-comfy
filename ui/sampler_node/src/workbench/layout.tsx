import React, { useEffect, useRef, useState } from 'react';
import { dockAllUnits, fitLayout, syncDocUnits, type Dock } from '../dock/model';
import {
  fetchLayouts, layoutsAction, readLocalLayouts, writeLocalLayouts,
  LAYOUT_MAX, type LayoutStore, type SavedLayout,
} from '../dock/layoutStore';
import { wbStyles } from './skin';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';

// Layout 这一格：把**窗的摆法**存成一份取名字的档案，再原样取回来。
//
// 存的不是"页面长什么样"，是那一棵 dock 树本身 —— 谁跟谁并成一列、哪一格是 tab 组、哪一扇收成
// 了 toolbar、哪一扇浮在外面、哪几块折叠着。存下来和读回去走的是同一套校验（`fitLayout`）。
//
// 档案住在**盘上**（后端 `/api/layouts` → data/sampler/dock_layouts.json），不是只住浏览器：
// 宿主端口是 8700..8799 里试出来的，换端口换 origin，localStorage 里那份当场看不见。
// 浏览器里那份现在只是缓存（先画出来，后端答了再对齐），读不到后端时列表也不会凭空清空。
const when = (at: number): string => {
  if (!at) return 'saved earlier';
  const d = Date.now() - at;
  if (d < 45_000) return 'just now';
  if (d < 3_600_000) return `${Math.max(1, Math.round(d / 60_000))} min ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} h ago`;
  const day = Math.round(d / 86_400_000);
  if (day < 8) return `${day} d ago`;
  return new Date(at).toLocaleDateString();
};
// 一份布局有多"大"：这是**用户唯一能凭它认出一份存档**的东西 —— 名字是他自己起的，数字是这份
// 布局自己说的（几扇窗、几扇浮在外面）。
const summary = (dock: Dock): string => {
  const n = dockAllUnits(dock).length;
  const f = dock.floats.length;
  return `${n} panel${n === 1 ? '' : 's'}${f ? ` · ${f} floating` : ''}`;
};

// 最后一句结果住在**模块**里，不在组件的 state 里：载入一份旧布局时，这一格自己也会被摆到别的
// 地方去（它就住在那份布局里），组件随之重挂载 —— 状态一重置，"装好了 / 有几格已经不存在"这句
// 话就当场消失了。页面刷新会重载模块，所以它也不会留到下一次访问。
let lastFlash: { bad?: boolean; text: string } | null = null;
// 浏览器这份缓存"已经往盘上播过种"的记号（只播一次，见下面那个 effect）。
const SEEDED_KEY = 'sampler.drawLayouts.seeded';
// 这一趟页面里有没有和后端对过一次账。Layout 那一格可能被载入的布局搬走、重挂载，重挂载之后
// 不必再对一次（也不必再把浏览器缓存推一次盘上）。
let syncedOnce = false;

const LayoutBody: React.FC<WorkbenchUnitProps> = ({ host }) => {
  const { dock, rules, openDocs, apply, setVisible } = host.layout;
  const [store, setStore] = useState<LayoutStore>(readLocalLayouts);
  const [name, setName] = useState('');
  const [flash, setFlashState] = useState(lastFlash);
  const setFlash = (f: { bad?: boolean; text: string } | null) => { lastFlash = f; setFlashState(f); };
  const busy = useRef(false);

  const commit = (next: LayoutStore) => { setStore(next); writeLocalLayouts(next); };

  // 和后端对账：盘上那份是真相。**开天辟地那一次**把浏览器里存的老档案（那时候还没有盘上这一份）
  // 推上去 —— 否则那些布局会随着下一次换端口一起消失。
  //
  // 只推这一次（`seeded` 记号落在浏览器里）：后来在别的 origin 上删掉的档案，不该被这台浏览器里
  // 过期的缓存又推回盘上去 —— 那会变成"删了又自己长回来"。
  useEffect(() => {
    if (syncedOnce) return;
    syncedOnce = true;
    let alive = true;
    (async () => {
      const remote = await fetchLayouts();
      if (!alive || !remote) return;
      const seeded = (() => { try { return localStorage.getItem(SEEDED_KEY) === '1'; } catch { return true; } })();
      const local = readLocalLayouts();
      if (!seeded && remote.items.length === 0 && local.items.length) {
        let last: LayoutStore | null = remote;
        for (const it of local.items) {
          const res = await layoutsAction('save', { name: it.name, dock: it.dock });
          if (res) last = res;
        }
        try { localStorage.setItem(SEEDED_KEY, '1'); } catch { /* 记不住就下次再试 */ }
        if (!alive) return;
        if (last) commit(last);
        return;
      }
      try { localStorage.setItem(SEEDED_KEY, '1'); } catch { /* 同上 */ }
      commit(remote);
    })();
    return () => { alive = false; };
  }, []);

  // 存：同名的直接换掉（"Save"两次就是同一个槽位更新），新的排在最前 —— 最近用的在最上面。
  const save = async () => {
    if (busy.current) return;
    busy.current = true;
    const label = (name.trim() || `Layout ${store.items.length + 1}`).slice(0, 48);
    const next: LayoutStore = {
      default: store.default,
      items: [{ name: label, at: Date.now(), dock }, ...store.items.filter(i => i.name !== label)]
        .slice(0, LAYOUT_MAX),
      current: store.current,
    };
    commit(next);           // 先画出来：按钮按下去要立刻有反应，盘上那一趟在后台走
    setName('');
    setFlash({ text: `Saved “${label}” — ${summary(dock)}` });
    const remote = await layoutsAction('save', { name: label, dock });
    busy.current = false;
    if (remote) commit(remote);
    else setFlash({ bad: true, text: `“${label}” is only in this browser — the server did not take it.` });
  };

  // 读：先过 `fitLayout` 那一道关（旧面板剪掉、缺的补进来），再把文档窗口按**现在开着的**那几份
  // 收一遍。后者不能省：存档是在别的会话里存的，里面的 `doc:*` 有的是关掉的那几份、有的已经不在
  // 这个工作台里了 —— 不收拾就会凭空多出几扇空窗，或者缺一扇画布。
  //
  // 第三个参数 `keepSlots`：一份也没有打开时（页面本来就不自带工程），存档里的画布格不是"关掉了的
  // 文档"，而是"待会儿要接文档的那个位置"。剪掉它，等用户真开一份工程，画布就只能落到工作区末尾。
  // 有空出来的旧格也不要紧 —— 它渲染成空洞（`dead`），文档一到位就原地接上。
  const load = (item: SavedLayout) => {
    const fit = fitLayout(rules, item.dock);
    if (!fit) { setFlash({ bad: true, text: 'That entry holds no layout — its tree is missing.' }); return; }
    apply(syncDocUnits(fit.dock, openDocs, true));
    const bits: string[] = [];
    if (fit.dropped.length) {
      bits.push(`${fit.dropped.length} panel${fit.dropped.length === 1 ? '' : 's'} in it no longer exist`);
    }
    if (fit.added.length) {
      bits.push(`${fit.added.length} newer panel${fit.added.length === 1 ? '' : 's'} placed`);
    }
    setFlash({ text: `Loaded “${item.name}”${bits.length ? ' · ' + bits.join(' · ') : ''}` });
  };

  const remove = async (item: SavedLayout) => {
    const next: LayoutStore = {
      default: store.default === item.name ? null : store.default,
      items: store.items.filter(i => i.name !== item.name),
      current: store.current,
    };
    commit(next);
    setFlash({ text: `Deleted “${item.name}”` });
    const remote = await layoutsAction('delete', { name: item.name });
    if (remote) commit(remote);
  };

  // 「设为默认」：★ 是**一片空白页面**的起手式 —— 页面打开时用的是"上一次的摆法"（实时存在盘上的
  // `current`），只有在还没有任何"上一次"的时候才退到这颗星。它不是"停在这个布局"，也不覆盖
  // 你已经摆好的样子；想让页面从这一份开始（而不是从上次那样子），按 Load。
  const makeDefault = async (item: SavedLayout | null) => {
    const target = item ? item.name : '';
    const next: LayoutStore = { default: target || null, items: store.items, current: store.current };
    commit(next);
    setFlash({ text: item ? `“${item.name}” is the layout a fresh page starts from.` : 'Default layout cleared.' });
    const remote = await layoutsAction('default', { name: target });
    if (remote) commit(remote);
  };

  const def = store.default;
  // 窗口清单：固定面板 + 此刻开着的文档窗。隐藏的仍然留在布局里（可见性），眼睛只是不画它。
  const hidden = new Set(dock.hidden ?? []);
  const units = [...rules.panels, ...openDocs.filter(id => !rules.panels.includes(id))];

  return (
    <div style={{ ...wbStyles.stack, gap: 6 }}>
      <div style={wbStyles.row}>
        <input style={wbStyles.input} value={name} spellCheck={false}
          placeholder={`Layout ${store.items.length + 1}`}
          title="A name for the layout you are about to save. Saving again under the same name replaces it."
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); save(); } }} />
        <button style={wbStyles.btn} onClick={save} data-layout-save
          title={'Save the arrangement on screen as it is right now — every column, tab group, toolbar strip, ' +
            'floating window and folded window. This is a named slot: it does not touch the layout the page ' +
            'remembers between visits, so you can always come back to this one.'}>
          Save
        </button>
      </div>
      {/* 两句话，两件事，别混：页面**打开时**用的是上一段的摆法（实时存盘，读档就在第一帧，
          不闪）；★ 只负责"还没有上一次"的那一片空白页面。 */}
      <div style={{ ...wbStyles.readout, display: 'flex', alignItems: 'center', gap: 5 }}
        data-layout-last="1" title="Every change you make to the windows is written to disk as you go — closing the page and opening it again puts you back here.">
        <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          Opens where you left it — saved as you arrange
        </span>
      </div>
      {def ? (
        <div style={{ ...wbStyles.readout, display: 'flex', alignItems: 'center', gap: 4 }} data-layout-default-note={def}>
          <Star on />
          <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            A fresh page starts from “{def}”
          </span>
          <button style={wbStyles.iconBtn} data-layout-default-clear title="Clear the fallback layout"
            onClick={() => makeDefault(null)}><Cross /></button>
        </div>
      ) : null}
      {flash ? (
        <div style={{ ...wbStyles.readout, color: flash.bad ? '#ff453a' : 'rgba(255,255,255,0.55)' }}>{flash.text}</div>
      ) : null}
      {store.items.length === 0 ? (
        <div style={wbStyles.note}>
          No saved layouts yet. Arrange the page the way you like it, type a name and press Save —
          loading it later puts every window back where it sits now.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }} data-layout-list>
          {store.items.map(it => {
            const on = it.name === def;
            return (
              <div key={`${it.name}@${it.at}`}
                style={{ ...rowStyle, ...(on ? rowDefaultStyle : null) }} data-layout-row={it.name}
                data-layout-is-default={on ? '1' : '0'}>
                <div style={{ flex: '1 1 0', minWidth: 0 }}>
                  <div style={nameStyle} title={it.name}>{it.name}</div>
                  <div style={metaStyle}>{when(it.at)} · {summary(it.dock)}</div>
                </div>
                <button style={{ ...wbStyles.iconBtn, color: on ? '#ffd60a' : undefined }}
                  data-layout-default={it.name} data-layout-is-default={on ? '1' : '0'}
                  onClick={() => makeDefault(on ? null : it)}
                  title={on ? `“${it.name}” is the fallback — click to clear it`
                    : `Make “${it.name}” the fallback: a page with no history of its own (fresh browser, `
                      + `cleared storage) starts out like this. A page that has been used opens where you left it.`}>
                  <Star on={on} />
                </button>
                <button style={wbStyles.btn} data-layout-load={it.name} onClick={() => load(it)}
                  title={`Put every window back the way “${it.name}” had it. Windows of documents you no longer ` +
                    'have open are dropped; documents you do have open are given a window.'}>
                  Load
                </button>
                <button style={wbStyles.iconBtn} data-layout-drop={it.name} onClick={() => remove(it)}
                  title={`Delete “${it.name}”. The layout on screen is not touched.`}>
                  <Cross />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ ...wbStyles.groupHead, marginTop: 4 }}
        title="Every dock window on this page. Hidden windows keep their place in the layout — the eye brings them back where they were.">
        Windows
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }} data-layout-windows>
        {units.map(id => {
          const isHidden = hidden.has(id);
          const canHide = rules.canHide?.(id) !== false;
          const label = rules.title(id) || id;
          const color = rules.titleColor?.(id);
          return (
            <div key={id} data-layout-unit={id} data-layout-visible={isHidden ? '0' : '1'}
              style={{ ...unitRow, opacity: isHidden ? 0.55 : 1 }}>
              <span style={{ display: 'flex', flexShrink: 0 }}>{rules.icon(id)}</span>
              <span style={{ ...nameStyle, flex: '1 1 0', color }} title={label}>{label}</span>
              {canHide ? (
                <button style={wbStyles.iconBtn} data-layout-eye={id} data-hidden={isHidden ? '1' : '0'}
                  title={isHidden ? `Show “${label}”` : `Hide “${label}”`}
                  onClick={() => setVisible(id, isHidden)}>
                  <Eye off={isHidden} />
                </button>
              ) : (
                <span style={{ ...wbStyles.iconBtn, opacity: 0.35, cursor: 'default' }}
                  title="Always shown — the Layout window cannot be hidden">
                  <Eye />
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const unitRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, padding: '2px 3px', borderRadius: 6,
};

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 4, padding: '4px 5px', borderRadius: 7,
  background: 'rgba(255,255,255,0.045)', border: '0.5px solid rgba(255,255,255,0.09)', minWidth: 0,
};
// 默认那一行自己站起来一点：它不是"又一个槽位"，它是页面打开时的那一个。
const rowDefaultStyle: React.CSSProperties = {
  background: 'rgba(255,214,10,0.10)', border: '0.5px solid rgba(255,214,10,0.34)',
};
const nameStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.86)',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const metaStyle: React.CSSProperties = {
  fontSize: 9.5, color: 'rgba(255,255,255,0.34)', lineHeight: 1.4,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

// 窗口清单的眼睛：开着 = 看得见，划一道 = 隐藏。画法照 icons 那条 16 格栅格。
const Eye: React.FC<{ off?: boolean }> = ({ off }) => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"
    strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
    <path d="M1.7 8s2.3-4 6.3-4 6.3 4 6.3 4-2.3 4-6.3 4S1.7 8 1.7 8Z" />
    <circle cx="8" cy="8" r="1.8" />
    {off && <path d="M2.4 2.4 13.6 13.6" />}
  </svg>
);

// 默认那颗星：实心 = 现在就是默认，空心 = 可以点成默认。10px，照无字按钮的墨色。
const Star: React.FC<{ on?: boolean }> = ({ on }) => (
  <svg width="11" height="11" viewBox="0 0 12 12" fill={on ? 'currentColor' : 'none'} stroke="currentColor"
    strokeWidth="1.2" strokeLinejoin="round" style={{ display: 'block' }}>
    <path d="M6 1.4l1.42 2.9 3.2.46-2.32 2.26.55 3.18L6 8.7 3.15 10.2l.55-3.18L1.38 4.76l3.2-.46z" />
  </svg>
);

// 删除那一颗：和眼睛同一套无字按钮的墨色，画法照 icons 那条 16 格栅格，只是小一号。
const Cross: React.FC = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" style={{ display: 'block' }}>
    <path d="M2.2 2.2 7.8 7.8M7.8 2.2 2.2 7.8" />
  </svg>
);

export const layoutUnit: WorkbenchUnit = {
  id: 'layout',
  title: 'Layout',
  hint: 'Named copies of the window arrangement, kept on disk (so they survive a restart and a new port). '
    + 'The arrangement on screen is saved by itself — the page opens where you left it. Save a named copy to '
    + 'come back to it later; the ★ is only what a page with no history of its own starts from. '
    + 'The Windows list shows or hides every dock window; hidden windows keep their place, and this Layout window itself is always shown.',
  Body: LayoutBody,
};
