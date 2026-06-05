import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Tldraw, createTLStore, defaultShapeUtils, Editor, AssetRecordType } from '@tldraw/tldraw';
import '@tldraw/tldraw/tldraw.css';
import Panel, { PanelHandle, ImageInfo } from './components/Panel';

const App: React.FC = () => {
  const [inputData, setInputData] = useState('');
  const editorRef = useRef<Editor | null>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  const [pendingSnapshot, setPendingSnapshot] = useState<string | null>(null);
  const [enableStrength, setEnableStrength] = useState(false);
  const [enablePrompt, setEnablePrompt] = useState(false);
  const [strengthDefs, setStrengthDefs] = useState<{ name: string; default: number }[]>([]);
  const panelHandleRef = useRef<PanelHandle>(null);

  useEffect(() => {
    fetch('/input_data')
      .then((res) => res.json())
      .then((data) => {
        setInputData(data.input_data || '');

        // Set node input flags
        setEnableStrength(data.enable_strength || false);
        setEnablePrompt(data.enable_prompt || false);
        setStrengthDefs(data.strength_defs || []);

        // Restore canvas snapshot if available
        const snapshot = data.canvas_snapshot;
        if (snapshot) {
          console.log('[SnapshotAssets] Received snapshot from server');
          setPendingSnapshot(snapshot);
        }
      })
      .catch((err) => console.error('Failed to load input data:', err));
  }, []);

  const store = useRef(
    createTLStore({
      shapeUtils: defaultShapeUtils,
    })
  ).current;

  const restoreSnapshot = useCallback((snapshot: string) => {
    const editor = editorRef.current;
    if (!editor) return;

    try {
      const parsed = JSON.parse(snapshot);
      console.log('[SnapshotAssets] Restoring snapshot...', parsed);

      // Restore document records (shapes, assets, pages, document)
      if (parsed.store) {
        const records = Object.values(parsed.store) as any[];
        editor.store.put(records);
      }

      // Restore panel selected images
      if (parsed.panelImages && Array.isArray(parsed.panelImages)) {
        panelHandleRef.current?.setImages(parsed.panelImages);
      }

      // Note: enableStrength and enablePrompt are controlled by node inputs, not snapshot

      // Restore prompt text
      if (typeof parsed.prompt === 'string') {
        panelHandleRef.current?.setPrompt?.(parsed.prompt);
      }

      // Restore camera position and zoom
      if (parsed.camera) {
        editor.setCamera({
          x: parsed.camera.x,
          y: parsed.camera.y,
          z: parsed.camera.z,
        });
      }

      console.log('[SnapshotAssets] Snapshot restored successfully');
    } catch (err) {
      console.error('Failed to restore snapshot:', err);
    }
  }, []);

  const addImage = useCallback(async (file: File, x: number, y: number) => {
    if (!file.type.startsWith('image/')) return;

    const editor = editorRef.current;
    if (!editor) return;

    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const assetId = AssetRecordType.createId();
    editor.createAssets([
      {
        id: assetId,
        typeName: 'asset',
        type: 'image',
        meta: {},
        props: {
          name: file.name,
          src: dataUrl,
          w: 300,
          h: 300,
          mimeType: file.type,
          isAnimated: false,
        },
      },
    ]);

    const shapeId = `shape:${Date.now()}_${Math.random().toString(36).substr(2, 9)}` as any;
    editor.createShape({
      id: shapeId,
      type: 'image',
      x,
      y,
      props: {
        w: 300,
        h: 300,
        assetId,
      },
    });

    // Do NOT add to images list automatically - user must click + button
  }, []);

  const handleConfirm = useCallback(async ({ images, enableStrength, prompt }: { images: ImageInfo[]; enableStrength: boolean; prompt: string }) => {
    const editor = editorRef.current;
    if (!editor) return;

    // Get tldraw snapshot - structure is { store: {...}, schema: {...} }
    const snapshot = editor.store.getSnapshot();

    // Filter out instance state records (camera, instance, etc.) to avoid UI issues
    const filteredStore: Record<string, any> = {};
    for (const [key, value] of Object.entries(snapshot.store)) {
      const record = value as any;
      // Keep document, page, shape, asset records; skip instance state
      if (record.typeName === 'instance' || record.typeName === 'instance_page_state' ||
          record.typeName === 'camera' || record.typeName === 'pointer') {
        continue;
      }
      filteredStore[key] = record;
    }

    // Save panel selected images info (include strengths)
    const panelImages = images.map((img) => ({
      id: img.id,
      name: img.name,
      dataUrl: img.dataUrl,
      assetId: img.assetId,
      shapeId: img.shapeId,
      strengths: img.strengths,
    }));

    // Save camera position and zoom
    const camera = editor.getCamera();

    const canvasState = {
      store: filteredStore,
      schema: snapshot.schema,
      panelImages: panelImages,
      enableStrength,
      prompt,
      camera: {
        x: camera.x,
        y: camera.y,
        z: camera.z,
      },
    };

    const snapshotJson = JSON.stringify(canvasState);

    try {
      const selectedImages = images.map((img) => ({
        image: img.dataUrl,
        strengths: enableStrength ? img.strengths : undefined,
      }));
      console.log('[App] handleConfirm sending prompt:', prompt);
      await fetch('/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: selectedImages,  // Selected images for output
          prompt: prompt || '',  // User prompt text (ensure string)
          canvas_snapshot: snapshotJson  // Full canvas state for persistence
        }),
      });
    } catch (err) {
      console.error('Confirm failed:', err);
    }
    window.close();
  }, []);

  useEffect(() => {
    const onBeforeUnload = () => {
      fetch('/window_closed', { method: 'POST', body: '{}' });
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const handleMount = useCallback(
    (editor: Editor) => {
      console.log('[SnapshotAssets] Editor mounted');
      editorRef.current = editor;
      editor.updateInstanceState({ isDebugMode: false });

      // Enable dot grid background that moves with camera
      editor.user.updateUserPreferences({
        colorScheme: 'light',
      });

      // Enable grid mode to show dot grid
      editor.updateInstanceState({ isGridMode: true });
    },
    [store]
  );

  // Restore snapshot when both editor and snapshot are ready
  useEffect(() => {
    if (editorRef.current && pendingSnapshot) {
      console.log('[SnapshotAssets] Restoring pending snapshot...');
      restoreSnapshot(pendingSnapshot);
    }
  }, [pendingSnapshot, restoreSnapshot]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
        background: '#fafafa',
      }}
    >
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <Tldraw
          store={store}
          onMount={handleMount}
        />
        <style>{`
          .tlui-toolbar-container {
            bottom: ${panelHeight}px !important;
          }
          .tlui-toolbar__tools {
            bottom: ${panelHeight}px !important;
          }
          /* Change selection outline color to green */
          .tl-selection-outline {
            stroke: #4ade80 !important;
          }
          .tl-selection-background {
            fill: #4ade80 !important;
          }
        `}</style>
      </div>

      <Panel
        ref={panelHandleRef}
        editor={editorRef}
        onHeightChange={setPanelHeight}
        onConfirm={handleConfirm}
        enableStrength={enableStrength}
        enablePrompt={enablePrompt}
        strengthDefs={strengthDefs}
      />

      {inputData && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: 8,
            background: 'rgba(0,0,0,0.6)',
            color: '#aaa',
            padding: '4px 8px',
            borderRadius: 4,
            fontSize: 12,
            pointerEvents: 'none',
            zIndex: 100,
            maxWidth: 300,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={inputData}
        >
          Input: {inputData}
        </div>
      )}
    </div>
  );
};

export default App;
