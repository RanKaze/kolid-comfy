

## Codely Structured Memories

### User

### Feedback
- [2026-07-23 08:42:31] When modifying existing architecture modules, the user prefers directly replacing the old implementation rather than creating a parallel new one. Don't invent new names (e.g. "Krea2Edit") when the existing name ("Krea2") suffices — replace in-place.
- [2026-07-24 01:02:55] tldraw custom shape types (BaseBoxShapeUtil) work fine in this project — the earlier "Error" was caused by two bugs: (1) calling `useEditor()` inside the `component()` method, and (2) wrong method signature `component({ shape }: { shape: AudioShape })` — the correct signature is `component(shape: AudioShape)` (receives shape directly, not destructured from an object). **How to apply:** Use `component(shape: MyShape)` and `indicator(shape: MyShape)`. Store all data in shape props via `static props = { ... }` + `getDefaultProps()`. Never call `useEditor()` or rely on `editor` inside `component()`. Register the shape util via `shapeUtils: [...defaultShapeUtils, MyShapeUtil]` on BOTH `createTLStore()` and `<Tldraw>`.



### Project

### Reference
- [2026-07-23 23:40:11] [reference] tldraw assets_node frontend source lives at nodes/assets_node/src/ with Panel.tsx and App.tsx as main files. Build via `npm run build` in nodes/assets_node/ — output goes to nodes/web/assets_node.html (vite + vite-plugin-singlefile, inlines all JS/CSS). The vite config renames index.html → assets_node.html.
