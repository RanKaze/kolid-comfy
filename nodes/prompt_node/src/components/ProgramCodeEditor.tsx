import { useRef } from 'react';
import Editor from '@monaco-editor/react';
// Import as raw string — Vite inlines the file content at build time
// This is the single source of truth for program context types
import ctxTypes from '../program-ctx-types.d.ts?raw';

interface ProgramCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
}

const CTX_VARS = ['tag_groups', 'loras', 'prefabs', 'custom_prompts', 'prompts_data', 'all_tags'];

export function ProgramCodeEditor({ value, onChange }: ProgramCodeEditorProps) {
  const editorRef = useRef<any>(null);
  const decorationsRef = useRef<string[]>([]);

  const applyCtxHighlights = (editor: any, monaco: any) => {
    const model = editor.getModel();
    if (!model) return;
    const text = model.getValue();
    const decorations: any[] = [];
    const regex = new RegExp(`\\b(${CTX_VARS.join('|')})\\b`, 'g');
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const startPos = model.getPositionAt(match.index);
      const endPos = model.getPositionAt(match.index + match[0].length);
      decorations.push({
        range: new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column),
        options: { inlineClassName: 'ctx-var-highlight' },
      });
    }
    decorationsRef.current = editor.deltaDecorations(decorationsRef.current, decorations);
  };

  return (
    <div style={{ width: '100%', flex: 1, minHeight: 0, border: '1px solid #38383a', borderRadius: 10, overflow: 'visible', marginTop: 8 }}>
      <style>{`
        .ctx-var-highlight { color: #4fc3f7 !important; font-weight: bold; }
        .monaco-editor .mtk7 { color: #dcdcaa !important; }
        .monaco-editor .scrollbar .slider { border-radius: 4px; }
      `}</style>
      <div style={{ minHeight: 500, overflow: 'visible', borderRadius: 10 }}>
      <Editor
        height={500}
        defaultLanguage="javascript"
        theme="vs-dark"
        value={value}
        onChange={(v) => {
          onChange(v || '');
          if (editorRef.current) {
            applyCtxHighlights(editorRef.current, (editorRef.current as any)._monaco);
          }
        }}
        onMount={(editor, monaco) => {
          editorRef.current = editor;
          (editor as any)._monaco = monaco;

          // Inject type definitions from .d.ts file (single source of truth)
          monaco.languages.typescript.javascriptDefaults.addExtraLib(ctxTypes, 'file:///program-ctx-types.d.ts');
          monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
            target: monaco.languages.typescript.ScriptTarget.ESNext,
            allowNonTsExtensions: true,
            moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
            module: monaco.languages.typescript.ModuleKind.ESNext,
            noEmit: true,
            esModuleInterop: true,
            allowJs: true,
          });
          monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
            noSemanticValidation: false,
            noSyntaxValidation: false,
          });

          monaco.editor.defineTheme('kolid-dark', {
            base: 'vs-dark',
            inherit: true,
            rules: [
              { token: 'identifier', foreground: '9cdcfe' },
              { token: 'delimiter', foreground: 'd4d4d4' },
              { token: 'delimiter.parenthesis', foreground: 'd4d4d4' },
              { token: 'delimiter.square', foreground: 'd4d4d4' },
              { token: 'delimiter.bracket', foreground: 'd4d4d4' },
              { token: 'keyword', foreground: 'c586c0' },
              { token: 'string', foreground: 'ce9178' },
              { token: 'number', foreground: 'b5cea8' },
              { token: 'comment', foreground: '6a9955', fontStyle: 'italic' },
              { token: 'regexp', foreground: 'd16969' },
              { token: 'type', foreground: '4ec9b0' },
              { token: 'type.identifier', foreground: '4ec9b0' },
              { token: 'identifier.js', foreground: '9cdcfe' },
            ],
            colors: { 'editor.background': '#1c1c1e' },
          });
          monaco.editor.setTheme('kolid-dark');

          applyCtxHighlights(editor, monaco);
        }}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily: 'Consolas, Monaco, "Courier New", monospace',
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          tabSize: 2,
          automaticLayout: true,
          quickSuggestions: true,
          suggestOnTriggerCharacters: true,
          formatOnPaste: true,
          padding: { top: 10, bottom: 10 },
          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        }}
        loading={
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#8e8e93', fontSize: 13 }}>
            Loading editor...
          </div>
        }
      />
      </div>
    </div>
  );
}