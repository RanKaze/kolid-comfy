// 由 tools/gen_keymap.cjs 从 nodes/web/js/keymap.js 生成 —— **不要手改**。
//
// 那颗文件是键位表的唯一真源：画布页面 `<script src="js/keymap.js">` 直接加载它，宿主在这里
// 拿一份打好类型的副本。改了键位表就重新构建（`npm run build -w sampler_node` 第一步就是重跑
// 生成器），`tests/keymap.py` 会检查这份是否落后。

/** 命令在哪儿有效。冲突检测按它分组：同一 scope 里两条命令占同一个键才叫真冲突。 */
export type KeyScope = 'app' | 'canvas' | 'timeline' | 'keyframes' | 'assets';

export type KeyDef = {
  /** `group.command`，页面与宿主都用它认命令（`KB.hit(e, id)` / `hit(e, id)`）。 */
  id: string;
  /** Key Bindings 屏里的分组标题。 */
  group: string;
  /** 那一行显示的名字。 */
  label: string;
  scope: KeyScope;
  /** 默认键。空数组 = 默认不绑，等用户自己绑。 */
  keys: readonly string[];
  /** Shift 是这条命令的**参数**而非绑定的一部分（方向键微调：Shift 走大步）。 */
  shiftAsParam?: boolean;
  /** 给屏幕下方那行小字用的说明（可无）。 */
  note?: string;
};

export const KEYMAP = [
  { id: "file.save", group: "File", label: "Save document", scope: "app", keys: ["Ctrl+S"], note: "Saves the .cud in place. Above the text-field guard on purpose: typing a prompt and pressing it must save." },
  { id: "edit.undo", group: "Edit", label: "Undo", scope: "app", keys: ["Ctrl+Z"] },
  { id: "edit.redo", group: "Edit", label: "Redo", scope: "app", keys: ["Ctrl+Shift+Z", "Ctrl+Y"] },
  { id: "edit.copy", group: "Edit", label: "Copy selection", scope: "canvas", keys: ["Ctrl+C"] },
  { id: "edit.paste", group: "Edit", label: "Paste", scope: "canvas", keys: ["Ctrl+V"] },
  { id: "edit.select-all", group: "Edit", label: "Select all layers", scope: "canvas", keys: ["Ctrl+A"] },
  { id: "edit.deselect", group: "Edit", label: "Deselect", scope: "canvas", keys: ["Ctrl+D"] },
  { id: "layer.transform", group: "Layers", label: "Transform box", scope: "canvas", keys: ["T", "Ctrl+T"] },
  { id: "layer.text-box", group: "Layers", label: "Draw a new text layer", scope: "canvas", keys: ["Alt+T"] },
  { id: "layer.confirm", group: "Layers", label: "Apply / edit text", scope: "canvas", keys: ["Enter"] },
  { id: "layer.delete", group: "Layers", label: "Delete layers", scope: "canvas", keys: ["Delete", "Backspace"] },
  { id: "layer.nudge-left", group: "Layers", label: "Nudge left", scope: "canvas", keys: ["ArrowLeft"], shiftAsParam: true },
  { id: "layer.nudge-right", group: "Layers", label: "Nudge right", scope: "canvas", keys: ["ArrowRight"], shiftAsParam: true },
  { id: "layer.nudge-up", group: "Layers", label: "Nudge up", scope: "canvas", keys: ["ArrowUp"], shiftAsParam: true },
  { id: "layer.nudge-down", group: "Layers", label: "Nudge down", scope: "canvas", keys: ["ArrowDown"], shiftAsParam: true },
  { id: "tool.zoom", group: "Tools", label: "Zoom tool", scope: "canvas", keys: ["Z"] },
  { id: "tool.pan", group: "Tools", label: "Pan tool", scope: "canvas", keys: ["H"] },
  { id: "tool.rotate", group: "Tools", label: "Rotate tool", scope: "canvas", keys: ["R"] },
  { id: "tool.brush", group: "Tools", label: "Brush", scope: "canvas", keys: ["B"] },
  { id: "tool.eraser", group: "Tools", label: "Eraser", scope: "canvas", keys: ["E"] },
  { id: "tool.bucket", group: "Tools", label: "Fill", scope: "canvas", keys: ["G"] },
  { id: "tool.marquee", group: "Tools", label: "Rectangle marquee", scope: "canvas", keys: ["M"] },
  { id: "tool.lasso", group: "Tools", label: "Lasso", scope: "canvas", keys: ["L"] },
  { id: "paint.swap-colors", group: "Paint", label: "Swap foreground / background", scope: "canvas", keys: ["X"] },
  { id: "paint.decal", group: "Paint", label: "Paint target — last Image step", scope: "canvas", keys: ["Tab"] },
  { id: "paint.mask", group: "Paint", label: "Paint target — last Mask step", scope: "canvas", keys: ["`"] },
  { id: "view.cancel", group: "View", label: "Cancel / reset view", scope: "canvas", keys: ["Escape"] },
  { id: "view.flip", group: "View", label: "Flip view", scope: "canvas", keys: ["Ctrl+F"] },
  { id: "view.hold-pan", group: "View", label: "Hold to pan", scope: "canvas", keys: ["Space"], note: "Held, not tapped — press and drag pans the canvas, middle-drag does the same without a key." },
  { id: "panel.geometry", group: "Panels", label: "Show Geometry panel", scope: "canvas", keys: ["D"] },
  { id: "panel.pose", group: "Panels", label: "Show Pose panel", scope: "canvas", keys: ["P"] },
  { id: "timeline.copy", group: "Timeline", label: "Copy segments", scope: "timeline", keys: ["Ctrl+C"] },
  { id: "timeline.paste", group: "Timeline", label: "Paste segments", scope: "timeline", keys: ["Ctrl+V"] },
  { id: "timeline.blade", group: "Timeline", label: "Blade (hold)", scope: "timeline", keys: ["C"] },
  { id: "timeline.delete", group: "Timeline", label: "Delete segments", scope: "timeline", keys: ["Delete", "Backspace"] },
  { id: "keyframes.add", group: "Keyframes", label: "Add keyframe at playhead", scope: "keyframes", keys: ["K"] },
  { id: "keyframes.fit", group: "Keyframes", label: "Fit keys in view", scope: "keyframes", keys: ["F"] },
  { id: "keyframes.delete", group: "Keyframes", label: "Delete selected keys", scope: "keyframes", keys: ["Delete", "Backspace"] },
  { id: "assets.select-all", group: "Assets", label: "Select all assets", scope: "assets", keys: ["Ctrl+A"] },
  { id: "assets.delete", group: "Assets", label: "Delete / remove asset", scope: "assets", keys: ["Delete"] },
  { id: "app.dock-edit", group: "App", label: "Toggle dock edit mode", scope: "app", keys: ["Alt+P"] },
] as const satisfies readonly KeyDef[];

/** 全部合法命令 id（拼错的 id 在 `KB.hit` / `hit` 里一律 false，这里给出集合好让 UI 与测试对账）。 */
export type KeyCommandId = (typeof KEYMAP)[number]['id'];

export const KEY_COMMAND_IDS: readonly string[] = KEYMAP.map(d => d.id);
export const KEY_SCOPES: readonly KeyScope[] = ["app","canvas","timeline","keyframes","assets"];
