import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { StagingItem } from '../types';
import { wbStyles } from './skin';
import { useBlendUi } from './store';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';

// Staging 那一格：画布底部原来那条工作区整条搬进宿主 —— Extra Prompt（文字与 <image_id:…> 图片 chip
// 混排的 contenteditable）+ Blend/Tag 两颗动作钮 + 那根进度条与浮出的 Cancel + 图池条（含最左两张钉死
// 的 Context / Guidance 卡片）。页面只存 Extra Prompt 的**序列化字符串**（.cud / run payload 都读它），
// 编辑的每一下经 `staging-prompt` 回去；图池条目、上传、删除一律不过页面 —— 工作区权威本就在宿主
// （App.staging 从 /api/staging 拉）。
//
// 编辑器是**命令式**的：React 不碰它的子树，内容由下面这几个纯 DOM 函数按快照重建；只在输入框没被
// 聚焦时重建，免得每帧回声把光标打回开头（同跨 iframe 那批 input 的教训）。chip 的缩略图取自图池。

// 与页面 / layerRow.tsx 同一组拖拽类型字符串：图池条目拖到画布/图层列表 = 以智能图层加入；图层行拖到
// 图池条 = 把这一层的合成结果导出进图池。两边不会走散。
const STAGING_LAYER_TYPE = 'application/x-blend-layer';
const STAGING_ITEM_TYPE = 'application/x-blend-staging';
const GUIDANCE_ID = 'staging_guidance';
const ZWSP = '\u200B';
const IMAGE_ID_TOKEN = /<image_id:([^>\s]+)>/g;
const IMAGE_ID_ONE = /^<image_id:([^>\s]+)>$/;

type SrcFor = (id: string) => string;

function makeChip(id: string, src: string): HTMLElement {
  const chip = document.createElement('span');
  chip.contentEditable = 'false';                    // 原子：退格整块删，光标进不去内部
  chip.dataset.imageId = id;
  chip.title = `<image_id:${id}>`;
  // 页面 #extraPrompt .prompt-chip 那几条 CSS 搬到内联 —— 这一格不往 <head> 灌全局样式。
  const st = chip.style;
  st.display = 'inline-flex'; st.alignItems = 'center'; st.verticalAlign = '-14px';
  st.height = '44px'; st.maxWidth = '264px'; st.padding = '0 3px'; st.margin = '0 2px';
  st.borderRadius = '8px'; st.background = 'rgba(10,132,255,0.22)';
  st.border = '0.5px solid rgba(10,132,255,0.65)'; st.overflow = 'hidden';
  st.userSelect = 'none'; st.cursor = 'default';
  if (src) {
    const im = document.createElement('img');
    im.src = src; im.alt = id; im.draggable = false;
    im.style.height = '36px'; im.style.width = 'auto'; im.style.display = 'block'; im.style.borderRadius = '5px';
    chip.appendChild(im);
  } else {
    // 引用失效（图已从工作区移除）→ 退回可读文本，而不是一个空洞的方块。
    st.fontSize = '10px'; st.color = '#ff9f0a'; st.padding = '0 5px';
    chip.textContent = `<image_id:${id}>`;
  }
  return chip;
}

// DOM → 文本：零宽锚点不算内容，chip 序列化成 <image_id:…>。
function serializeEditor(el: HTMLElement): string {
  let out = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) { out += (node.nodeValue || '').replace(/\u200B/g, ''); continue; }
    if (node.nodeType !== 1) continue;
    const e = node as HTMLElement;
    const id = e.dataset && e.dataset.imageId;
    if (id) { out += `<image_id:${id}>`; continue; }
    if (e.tagName === 'BR') { out += '\n'; continue; }
    out += (e.textContent || '').replace(/\u200B/g, '');
  }
  return out;
}

// 文本 → DOM：<image_id:…> 认成一张 chip，其余是文字。
function renderEditor(el: HTMLElement, text: string, srcFor: SrcFor): void {
  el.textContent = '';
  IMAGE_ID_TOKEN.lastIndex = 0;
  let last = 0, m: RegExpExecArray | null;
  while ((m = IMAGE_ID_TOKEN.exec(text || ''))) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    el.appendChild(makeChip(m[1], srcFor(m[1])));
    last = IMAGE_ID_TOKEN.lastIndex;
  }
  if (last < (text || '').length) el.appendChild(document.createTextNode(text.slice(last)));
}

// 只换 chip 内部的缩略图（图池一变就调）：不重建节点，光标停在正文里时不会被打断。
function refreshChipImages(el: HTMLElement, srcFor: SrcFor): void {
  for (const chip of Array.from(el.querySelectorAll<HTMLElement>('[data-image-id]'))) {
    const id = chip.dataset.imageId;
    if (!id) continue;
    const src = srcFor(id);
    const im = chip.querySelector('img');
    if (src) {
      if (im) { if (im.getAttribute('src') !== src) im.src = src; }
      else {
        chip.textContent = '';
        chip.style.fontSize = ''; chip.style.color = ''; chip.style.padding = '';
        const n = document.createElement('img');
        n.src = src; n.alt = id; n.draggable = false;
        n.style.height = '36px'; n.style.width = 'auto'; n.style.display = 'block'; n.style.borderRadius = '5px';
        chip.appendChild(n);
      }
    } else if (im || !chip.style.fontSize) {
      chip.textContent = `<image_id:${id}>`;
      chip.style.fontSize = '10px';
      chip.style.color = '#ff9f0a';
      chip.style.padding = '0 5px';
    }
  }
}

function caretIn(el: HTMLElement): Range | null {
  const sel = window.getSelection && window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  return el.contains(r.startContainer) ? r : null;
}

// 退格 / Delete 落在 chip 旁边时它才该整块消失 —— 否则只会吃掉零宽锚点。
function chipBeside(el: HTMLElement, r: Range, back: boolean): HTMLElement | null {
  const c = r.startContainer;
  let node: Node | null = null;
  if (c.nodeType === 3) {
    const before = (c.nodeValue || '').slice(0, r.startOffset).replace(/\u200B/g, '');
    const after = (c.nodeValue || '').slice(r.startOffset).replace(/\u200B/g, '');
    if (back && before === '') node = c.previousSibling;
    else if (!back && after === '') node = c.nextSibling;
  } else if (c === el) {
    node = back ? c.childNodes[r.startOffset - 1] : c.childNodes[r.startOffset];
  }
  const e = node as HTMLElement | null;
  return e && e.nodeType === 1 && e.dataset && e.dataset.imageId ? e : null;
}

function dropHasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.prototype.indexOf.call(dt.types || [], 'Files') >= 0;
}
function dragHasType(e: React.DragEvent | DragEvent, t: string): boolean {
  const dt = e.dataTransfer;
  return !!dt && Array.prototype.indexOf.call(dt.types || [], t) >= 0;
}

const StagingBody: React.FC<WorkbenchUnitProps> = ({ send, host }) => {
  const ui = useBlendUi();
  const s = ui.staging;
  const editorRef = useRef<HTMLDivElement | null>(null);
  const caretRef = useRef<Range | null>(null);
  const sigRef = useRef<string>('');
  const [focused, setFocused] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [hover, setHover] = useState<{ src: string; x: number; y: number } | null>(null);

  const staging = host.staging;
  const contextSrc = host.blendPreview?.image || '';
  const guidanceSrc = staging.find(x => x.id === GUIDANCE_ID)?.src || '';
  const items = staging.filter(x => x.id !== GUIDANCE_ID);

  const srcFor = useCallback<SrcFor>((id) => {
    if (id === 'context') return contextSrc;
    if (id === GUIDANCE_ID) return guidanceSrc;
    const it = staging.find(x => x.id === id);
    return it ? it.src : '';
  }, [staging, contextSrc, guidanceSrc]);

  // 最新的出口 / 源解析 / 真值串都放 ref 里 —— 挂在编辑器上的那几个原生监听只装一次。
  const cbs = useRef({ send, srcFor, prompt: s.prompt });
  cbs.current = { send, srcFor, prompt: s.prompt };

  // 编辑器内容只在"没聚焦"时按快照重建；聚焦时只换 chip 缩略图，不然每帧回声都会把光标打回去。
  const sig = [
    s.prompt, contextSrc, guidanceSrc,
    items.map(i => `${i.id}\u0000${i.src ? 1 : 0}`).join('\u0001'),
  ].join('\u0002');
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (sigRef.current === sig) return;
    sigRef.current = sig;
    if (document.activeElement === el) refreshChipImages(el, srcFor);
    else renderEditor(el, s.prompt, srcFor);
  }, [sig, s.prompt, srcFor]);

  // 编辑器上的原生手势：Enter 不进画布快捷键、chip 旁退格整块删、粘贴只吃纯文本、输入即回写。
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const remember = () => { const r = caretIn(el); if (r) caretRef.current = r.cloneRange(); };
    const currentRange = (): Range | null => {
      if (document.activeElement === el) { const r = caretIn(el); if (r) return r; }
      return caretRef.current;
    };
    const insertNode = (node: Node) => {
      el.focus();
      let range = currentRange();
      if (!range || !el.contains(range.startContainer)) {
        range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);            // 没有记忆光标 = 追加到末尾
      }
      range.deleteContents();
      range.insertNode(node);
      const anchor = document.createTextNode(ZWSP);   // chip 后补零宽锚点，否则光标停不到图后面
      node.parentNode!.insertBefore(anchor, node.nextSibling);
      const after = document.createRange();
      after.setStart(anchor, 1);
      after.collapse(true);
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(after); }
      caretRef.current = after.cloneRange();
      cbs.current.send('staging-prompt', serializeEditor(el));
    };
    (el as any).__insertNode = insertNode;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); return; }
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
      const back = e.key === 'Backspace';
      const chip = chipBeside(el, sel.getRangeAt(0), back);
      if (!chip) return;                    // 普通字符交给浏览器
      e.preventDefault();
      const prev = chip.previousSibling, next = chip.nextSibling;
      chip.remove();
      const anchor = back ? prev : next;    // 顺手吃掉紧邻的零宽锚点
      if (anchor && anchor.nodeType === 3 && (anchor.nodeValue || '').replace(/\u200B/g, '') === '') anchor.remove();
      if (sel) {
        const r = document.createRange();
        if (next && next.parentNode) r.setStartBefore(next);
        else if (prev && prev.parentNode) r.setStartAfter(prev);
        else { r.selectNodeContents(el); r.collapse(true); }
        r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
        caretRef.current = r.cloneRange();
      }
      cbs.current.send('staging-prompt', serializeEditor(el));
    };
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      const cb = e.clipboardData || (window as any).clipboardData;
      const text = cb ? cb.getData('text') : '';
      if (!text) return;
      const one = IMAGE_ID_ONE.exec(text);
      insertNode(one ? makeChip(one[1], cbs.current.srcFor(one[1])) : document.createTextNode(text));
    };
    const onInput = () => { cbs.current.send('staging-prompt', serializeEditor(el)); };
    const onBlur = () => {
      remember();
      setFocused(false);
      // 聚焦期间漏掉的那次外部改动（例如宿主补 ref image 追了一枚 chip）：松手时补上。
      if (el && serializeEditor(el) !== cbs.current.prompt) renderEditor(el, cbs.current.prompt, cbs.current.srcFor);
    };
    const onFocus = () => setFocused(true);

    for (const ev of ['keyup', 'click', 'select', 'input', 'mouseup']) el.addEventListener(ev, remember);
    el.addEventListener('focus', onFocus);
    el.addEventListener('keydown', onKey);
    el.addEventListener('paste', onPaste, true);
    el.addEventListener('input', onInput);
    el.addEventListener('blur', onBlur);
    return () => {
      for (const ev of ['keyup', 'click', 'select', 'input', 'mouseup']) el.removeEventListener(ev, remember);
      el.removeEventListener('focus', onFocus);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('paste', onPaste, true);
      el.removeEventListener('input', onInput);
      el.removeEventListener('blur', onBlur);
    };
  }, []);

  const insertToken = (id: string) => {
    const el = editorRef.current;
    if (!el) return;
    const fn = (el as any).__insertNode as ((n: Node) => void) | undefined;
    const chip = makeChip(id, srcFor(id));
    if (fn) fn(chip);
  };

  const stageFiles = (files: FileList | null) => {
    const imgs = Array.from(files || []).filter(f => f.type && f.type.startsWith('image/'));
    if (!imgs.length) return;
    void (async () => {
      const images: string[] = []; const names: string[] = [];
      for (const f of imgs) {
        const url = await new Promise<string | null>(res => {
          const r = new FileReader();
          r.onload = () => res(typeof r.result === 'string' ? r.result : null);
          r.onerror = () => res(null);
          r.readAsDataURL(f);
        });
        if (url) { images.push(url); names.push(f.name || 'Loaded'); }
      }
      if (images.length) host.stageUpload(images, names);
    })();
  };

  const onStripDragOver = (e: React.DragEvent) => {
    const hasFiles = dropHasFiles(e.dataTransfer);
    const hasLayer = dragHasType(e, STAGING_LAYER_TYPE);
    if (!hasFiles && !hasLayer) {
      if (dragHasType(e, STAGING_ITEM_TYPE)) { e.stopPropagation(); }   // 自家条目路过自己：别亮任何东西
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = hasFiles ? 'copy' : 'move';
    setDragOver(true);
  };
  const onStripDragLeave = (e: React.DragEvent) => {
    e.stopPropagation();
    if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) return;
    setDragOver(false);
  };
  const onStripDrop = (e: React.DragEvent) => {
    const hasFiles = dropHasFiles(e.dataTransfer);
    const hasLayer = dragHasType(e, STAGING_LAYER_TYPE);
    if (!hasFiles && !hasLayer) {
      if (dragHasType(e, STAGING_ITEM_TYPE)) e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (hasFiles) { stageFiles(e.dataTransfer.files); return; }
    try { send('stage-layer', { id: Number(e.dataTransfer.getData(STAGING_LAYER_TYPE)) }); } catch { /* ignore */ }
  };

  const busy = s.busy;
  const canTag = !busy && s.hasTagger;
  const empty = s.prompt.trim() === '';

  return (
    <div style={{ ...wbStyles.stack, gap: 6 }}>
      {/* Extra Prompt：文字与图片 chip 混排。占位句在空着时盖在编辑器上方（contenteditable 没有
          placeholder 属性，又不能往 <head> 灌全局 ::before 规则）。 */}
      <div style={{ position: 'relative', minWidth: 0 }}>
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          spellCheck={false}
          title={s.hasTagger ? undefined : (s.placeholder || undefined)}
          style={{
            minHeight: 36, maxHeight: 180, overflowY: 'auto',
            background: 'rgba(255,255,255,0.07)',
            border: `0.5px solid ${focused ? '#0a84ff' : 'rgba(255,255,255,0.12)'}`,
            borderRadius: 9, padding: '8px 11px', color: '#fff', fontSize: 12.5,
            lineHeight: 1.35, outline: 'none', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            colorScheme: 'dark', cursor: 'text',
          }}
        />
        {empty && (
          <div style={{
            position: 'absolute', inset: 0, padding: '8px 11px', pointerEvents: 'none',
            color: 'rgba(255,255,255,0.32)', fontSize: 12.5, lineHeight: 1.35,
            overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{s.placeholder}</div>
        )}
      </div>

      {/* Blend / Tag 两颗动作钮。原来那三颗按钮的禁用判据一个都没少（busy / hasTagger）。 */}
      <div style={{ ...wbStyles.row, justifyContent: 'flex-end', gap: 6 }}>
        <button type="button" disabled={busy}
          title="Composite the layers into a NEW smart layer on top (self-contained pixels — non-destructive). The workspace only ever holds images you drag in yourself."
          onClick={() => send('staging-blend')} style={tbBtn(busy)}>
          <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.7}
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="9" cy="12" r="6" opacity={0.45} /><circle cx="15" cy="12" r="6" />
          </svg>
        </button>
        <button type="button" disabled={!canTag}
          title="Tag the composite — pick which region the tagger reads. With an image layer selected you also get Layer tags (the composite over that layer, cut by its own mask), plus Clear Tag to wipe the tags from the prompt stage."
          onClick={() => send('staging-tag')} style={tbBtn(!canTag)}>
          <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.7}
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12.72 2.23l7.05 7.05a2.5 2.5 0 010 3.54l-6.36 6.36a2.5 2.5 0 01-3.54 0l-6.36-6.36a2.5 2.5 0 010-3.54l7.05-7.05a1.5 1.5 0 012.16 0z" />
            <circle cx="9.5" cy="9.5" r="1.4" fill="currentColor" stroke="none" />
          </svg>
        </button>
      </div>

      {/* 进度条：run 在飞才出现（原来 #toolbarProgress 那条）。progress < 0 = 未知，画成一段不定进度。 */}
      {busy && (
        <div style={{ height: 3, borderRadius: 2, overflow: 'hidden', background: 'rgba(255,255,255,0.08)' }}>
          <div style={{
            height: '100%', background: '#0a84ff', transition: 'width 0.2s ease',
            width: s.progress < 0 ? '30%' : `${Math.max(0, Math.min(1, s.progress)) * 100}%`,
          }} />
        </div>
      )}

      {/* 运行中浮出的 Cancel（原来 #runCancelBtn：只有 detailer 那一趟才现）。 */}
      {s.cancelLive && (
        <button type="button"
          title="Cancel — interrupt the current run (works mid-block, mid-sampling or during Generate Text)"
          onClick={() => send('staging-cancel')}
          style={{
            border: 'none', borderRadius: 999, padding: '6px 16px', fontSize: 12, fontWeight: 700,
            color: '#fff', background: 'rgba(255,69,58,0.92)', cursor: 'pointer',
          }}>Cancel</button>
      )}

      {/* 图池条：两张钉死卡片恒在最左（Context / Guidance），其后是图池条目。拖文件进来上传；
          点条目 = 在 Extra Prompt 光标处插 <image_id:…>；✕ 移除；条目拖出去 = 以智能图层加入。 */}
      <div
        onDragOver={onStripDragOver}
        onDragLeave={onStripDragLeave}
        onDrop={onStripDrop}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          minHeight: 66, padding: '6px 0', overflowX: 'auto', overflowY: 'hidden',
          borderTop: '0.5px solid rgba(255,255,255,0.08)',
          outline: dragOver ? '1.5px dashed #0a84ff' : 'none', outlineOffset: -3,
          background: dragOver ? 'rgba(10,132,255,0.08)' : 'transparent',
        }}
      >
        <PinnedCard label="Context" preview={contextSrc}
          title="Context image — always <image 1> when Enable Edit is on (it is a reference even without being inserted here). Click to insert <image_id:context> at the cursor."
          onInsert={() => insertToken('context')} onHover={setHover} />
        <PinnedCard label="Guidance" preview={guidanceSrc}
          title="Guidance — the Layers composite with the whole Guidances stack painted over it. Always in the workspace as <image_id:staging_guidance>; with an empty Guidances stack it is the composite alone."
          onInsert={() => insertToken(GUIDANCE_ID)} onHover={setHover} />
        {items.map(it => (
          <StagingTile key={it.id} item={it}
            onInsert={() => insertToken(it.id)} onRemove={() => host.stageRemove(it.id)} onHover={setHover} />
        ))}
        {!items.length && (
          <span style={{ color: 'rgba(255,255,255,0.28)', fontSize: 11, whiteSpace: 'nowrap', paddingLeft: 2, pointerEvents: 'none' }}>
            Staging — drop image files here, then click an item to insert &lt;image_id:...&gt; into the extra prompt
          </span>
        )}
      </div>

      {/* Alt+悬浮放大预览：跟随指针的浮层，不吃任何指针事件。 */}
      {hover && (
        <div style={{
          position: 'fixed', left: hover.x, top: hover.y, zIndex: 300,
          padding: 6, borderRadius: 10, background: 'rgba(28,28,30,0.92)',
          border: '0.5px solid rgba(255,255,255,0.18)', boxShadow: '0 10px 32px rgba(0,0,0,0.5)',
          pointerEvents: 'none',
        }}>
          <img src={hover.src} alt="" style={{ display: 'block', maxWidth: 300, maxHeight: 300, borderRadius: 6 }} />
        </div>
      )}
    </div>
  );
};

// 那两颗动作钮的皮：页面 .tb-btn 照搬（accent 蓝、圆角、禁用降透明度）。
const tbBtn = (off: boolean): React.CSSProperties => ({
  border: 'none', borderRadius: 9, padding: '8px 9px', cursor: off ? 'default' : 'pointer', color: '#fff',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(10,132,255,0.9)', opacity: off ? 0.4 : 1,
});

// 悬浮预览只在按住 Alt 时给（与页面 hpWire 同一读法）：src 为空（Context 还没画布）就不给。
const hoverProps = (
  src: string,
  setHover: (h: { src: string; x: number; y: number } | null) => void,
): Pick<React.HTMLAttributes<HTMLElement>, 'onMouseMove' | 'onMouseLeave'> => ({
  onMouseMove: (e) => {
    if (e.altKey && src) setHover({ src, x: e.clientX + 16, y: e.clientY + 16 });
    else setHover(null);
  },
  onMouseLeave: () => setHover(null),
});

const PinnedCard: React.FC<{
  label: string; preview: string; title: string;
  onInsert: () => void; onHover: (h: { src: string; x: number; y: number } | null) => void;
}> = ({ label, preview, title, onInsert, onHover }) => (
  <div title={title} onClick={onInsert}
    style={{
      position: 'relative', flex: '0 0 auto', width: 54, height: 54, borderRadius: 8, overflow: 'hidden',
      background: 'rgba(10,132,255,0.14)', border: '0.5px dashed rgba(10,132,255,0.6)',
      color: 'rgba(255,255,255,0.9)', fontSize: 10, fontWeight: 700, letterSpacing: 0.2,
      textAlign: 'center', lineHeight: 1.2, cursor: 'pointer', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
    }}
    {...hoverProps(preview, onHover)}>
    {preview && <img src={preview} alt={`${label} preview`} draggable={false}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />}
    <span style={{
      position: 'absolute', left: 0, right: 0, bottom: 0, padding: '1px 0 2px',
      background: 'rgba(0,0,0,0.58)', fontSize: 9, fontWeight: 700, letterSpacing: 0.2, lineHeight: 1.2,
    }}>{label}</span>
  </div>
);

const StagingTile: React.FC<{
  item: StagingItem; onInsert: () => void; onRemove: () => void;
  onHover: (h: { src: string; x: number; y: number } | null) => void;
}> = ({ item, onInsert, onRemove, onHover }) => (
  <div
    title={`${item.name} — click to insert <image_id:${item.id}> into the extra prompt at the cursor`}
    onClick={onInsert}
    draggable
    onDragStart={ev => {
      ev.dataTransfer.effectAllowed = 'copy';
      try { ev.dataTransfer.setData(STAGING_ITEM_TYPE, String(item.id)); } catch { /* 老宿主不认就当没有 */ }
    }}
    {...hoverProps(item.src, onHover)}
    style={{
      position: 'relative', flex: '0 0 auto', width: 54, height: 54, borderRadius: 8, overflow: 'hidden',
      background: '#1c1c1e', border: '0.5px solid rgba(255,255,255,0.16)', cursor: 'pointer',
    }}>
    <img src={item.src} alt={item.name} draggable={false}
      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
    <button type="button" title="Remove from staging"
      onClick={ev => { ev.stopPropagation(); onRemove(); }}
      style={{
        position: 'absolute', top: 0, right: 0, width: 16, height: 16, padding: 0, border: 'none',
        borderRadius: '0 0 0 6px', cursor: 'pointer', background: 'rgba(0,0,0,0.62)',
        color: 'rgba(255,255,255,0.85)', fontSize: 10, lineHeight: '16px', textAlign: 'center',
      }}>✕</button>
  </div>
);

export const stagingUnit: WorkbenchUnit = {
  id: 'staging',
  title: 'Staging',
  hint: 'Staging — the workspace pool with the Extra Prompt above it. Drop image files here to add them, '
    + 'click an item to insert <image_id:…> into the prompt (or drag it onto the canvas / a layer list to '
    + 'add it as a smart layer), ✕ to remove. Blend composites the layers, Tag reads the composite.',
  Body: StagingBody,
};
