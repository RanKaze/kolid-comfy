import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Tldraw, createTLStore, defaultShapeUtils, Editor, AssetRecordType } from '@tldraw/tldraw';
import '@tldraw/tldraw/tldraw.css';
import Panel, { PanelHandle, ImageInfo } from './components/Panel';

export interface VideoInfo {
  id: string;
  name: string;
  dataUrl: string;
  assetId: string;
  shapeId: string;
}

const App: React.FC = () => {
  const [inputData, setInputData] = useState('');
  const editorRef = useRef<Editor | null>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  const [pendingSnapshot, setPendingSnapshot] = useState<string | null>(null);
  const [enableImageStrength, setEnableImageStrength] = useState(false);
  const [enablePrompt, setEnablePrompt] = useState(false);
  const [enableImage, setEnableImage] = useState(true);  // Image area enabled by default
  const [enableVideo, setEnableVideo] = useState(true);  // Video area enabled by default
  const [strengthDefs, setStrengthDefs] = useState<{ name: string; default: number }[]>([]);
  const [enableSlot, setEnableSlot] = useState(false);
  const [slotDefs, setSlotDefs] = useState<{ type: string; name: string }[]>([]);
  const panelHandleRef = useRef<PanelHandle>(null);

  useEffect(() => {
    fetch('/input_data')
      .then((res) => res.json())
      .then((data) => {
        setInputData(data.input_data || '');

        // Set node input flags
        setEnableImageStrength(data.enable_image_strength || false);
        setEnablePrompt(data.enable_prompt || false);
        setEnableImage(data.enable_image !== undefined ? data.enable_image : true);
        setEnableVideo(data.enable_video !== undefined ? data.enable_video : true);
        setStrengthDefs(data.strength_defs || []);
        setEnableSlot(data.enable_slot || false);
        setSlotDefs(data.slot_defs || []);

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

      // Restore panel selected images and videos
      if (parsed.panelImages && Array.isArray(parsed.panelImages)) {
        panelHandleRef.current?.setImages(parsed.panelImages);
      }
      if (parsed.panelVideos && Array.isArray(parsed.panelVideos)) {
        panelHandleRef.current?.setVideos?.(parsed.panelVideos);
      }
      if (parsed.panelSlots && Array.isArray(parsed.panelSlots)) {
        panelHandleRef.current?.setSlots?.(parsed.panelSlots);
      }

      // Note: enableImageStrength and enablePrompt are controlled by node inputs, not snapshot

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

  const addMedia = useCallback(async (file: File, x: number, y: number) => {
    const isGif = file.type === 'image/gif';
    const isImage = file.type.startsWith('image/') && !isGif;
    const isVideo = file.type.startsWith('video/') || isGif;
    if (!isImage && !isVideo) return;

    const editor = editorRef.current;
    if (!editor) return;

    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const assetId = AssetRecordType.createId();
    const assetType = isVideo ? 'video' : 'image';
    
    editor.createAssets([
      {
        id: assetId,
        typeName: 'asset',
        type: assetType as any,
        meta: {},
        props: {
          name: file.name,
          src: dataUrl,
          w: 300,
          h: isVideo ? 200 : 300,
          mimeType: file.type,
          isAnimated: false,
        },
      } as any,
    ]);

    const shapeId = `shape:${Date.now()}_${Math.random().toString(36).substr(2, 9)}` as any;
    editor.createShape({
      id: shapeId,
      type: assetType,
      x,
      y,
      props: {
        w: 300,
        h: isVideo ? 200 : 300,
        assetId,
      },
    } as any);

    // Do NOT add to images/videos list automatically - user must click + button
  }, []);

  const handleConfirm = useCallback(async ({ images, videos, enableImageStrength, prompt, slots }: { images: ImageInfo[]; videos: VideoInfo[]; enableImageStrength: boolean; prompt: string; slots: ({ type: string; data: any })[] }) => {
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

    // Save panel selected videos info
    const panelVideos = videos.map((vid) => ({
      id: vid.id,
      name: vid.name,
      dataUrl: vid.dataUrl,
      assetId: vid.assetId,
      shapeId: vid.shapeId,
    }));

    // Save panel selected slots info
    const panelSlots = slots.map((slot) => {
      const item = slot.data;
      if (!item) return { type: slot.type, data: null };
      if (slot.type === 'Image') {
        return {
          type: 'Image',
          data: {
            id: item.id,
            name: item.name,
            dataUrl: item.dataUrl,
            assetId: item.assetId,
            shapeId: item.shapeId,
          },
        };
      }
      return {
        type: 'Video',
        data: {
          id: item.id,
          name: item.name,
          dataUrl: item.dataUrl,
          assetId: item.assetId,
          shapeId: item.shapeId,
        },
      };
    });

    // Save camera position and zoom
    const camera = editor.getCamera();

    const canvasState = {
      store: filteredStore,
      schema: snapshot.schema,
      panelImages: panelImages,
      panelVideos: panelVideos,
      panelSlots: panelSlots,
      enableImageStrength,
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
        strengths: enableImageStrength ? img.strengths : undefined,
      }));
      const selectedVideos = videos.map((vid) => ({
        video: vid.dataUrl,
      }));
      const selectedSlots = slots.map((slot) => {
        if (!slot.data) return { type: slot.type, data: null };
        if (slot.type === 'Image') {
          return { type: 'Image', data: { image: slot.data.dataUrl } };
        }
        return { type: 'Video', data: { video: slot.data.dataUrl } };
      });
      console.log('[App] handleConfirm sending prompt:', prompt);
      await fetch('/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: selectedImages,  // Selected images for output
          videos: selectedVideos,  // Selected videos for output
          slots: selectedSlots,  // Selected slots for output
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

      // Override uploadAsset: for videos, upload via server to avoid
      // base64-encoding huge files which freezes the browser.
      const origUpload = (editor as any).uploadAsset.bind(editor) as (
        asset: any, file: File, abortSignal?: AbortSignal
      ) => Promise<{ src: string }>;
      (editor as any).uploadAsset = async (asset: any, file: File, abortSignal?: AbortSignal) => {
        if (file.type.startsWith('video/') || file.type === 'image/gif') {
          const result = await uploadVideoToServer(file, abortSignal);
          return { src: result.url };
        }
        // For images, keep default base64 behavior
        return origUpload(asset, file, abortSignal);
      };

      // Also intercept the external content handler for video files.
      // tldraw's default handler calls getVideoSize(file) before uploadAsset,
      // which reads the entire 437MB file locally and hangs the browser.
      // By overriding the "files" handler, we bypass that entirely.
      // Note: registerExternalContentHandler returns `this` (editor), NOT the old handler.
      // We must read the old handler from editor.externalContentHandlers before replacing.
      const editorExt = editor as any;
      const defaultHandler = editorExt.externalContentHandlers?.['files'];
      const handleFile = async (content: any) => {
        const files: File[] = content?.files || [];
        const videoFile = files.find((f: File) => f.type?.startsWith('video/') || f.type === 'image/gif');
        
        if (videoFile && files.length === 1) {
          // Handle single video: upload to server, get actual dimensions, create asset
          console.log('[SnapshotAssets] Intercepted video drop, uploading via server...');
          try {
            const result = await uploadVideoToServer(videoFile);
            // Get actual video dimensions from URL (metadata, not the local file)
            console.log('[SnapshotAssets] Getting video dimensions from URL...');
            const { w, h } = await getVideoDim(result.url);
            console.log('[SnapshotAssets] Video dimensions:', w, 'x', h);
            const assetId = AssetRecordType.createId();
            editor.createAssets([{
              id: assetId, typeName: 'asset', type: 'video', meta: {},
              props: {
                name: videoFile.name, src: result.url,
                w, h, fileSize: videoFile.size,
                mimeType: videoFile.type, isAnimated: true,
              },
            } as any]);
            const shapeId = `shape:${Date.now()}_${Math.random().toString(36).substr(2, 9)}` as any;
            const point = content?.point;
            editor.createShape({
              id: shapeId, type: 'video',
              x: point?.x ?? 0, y: point?.y ?? 0,
              props: { w, h, assetId },
            } as any);
            console.log('[SnapshotAssets] Video shape created with URL:', result.url);
            return;
          } catch (err) {
            console.error('[SnapshotAssets] Video interception failed:', err);
            throw err;
          }
        }
        // For non-video files, delegate to the default handler
        if (defaultHandler) {
          return defaultHandler(content);
        }
      };
      editorExt.registerExternalContentHandler('files', handleFile);
    },
    [store]
  );

  // Helper: upload video file to server via raw binary POST
  async function uploadVideoToServer(file: File, abortSignal?: AbortSignal): Promise<{ url: string; name: string }> {
    console.log('[SnapshotAssets] Uploading video via server:', file.name, (file.size / 1024 / 1024).toFixed(1), 'MB');
    const resp = await fetch('/upload_asset', {
      method: 'POST',
      body: file,
      headers: { 'X-Filename': encodeURIComponent(file.name) },
      signal: abortSignal,
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('[SnapshotAssets] Upload failed, status:', resp.status, errText);
      throw new Error(`Upload failed: ${resp.status}`);
    }
    const result = await resp.json();
    console.log('[SnapshotAssets] Video uploaded, URL:', result.url);
    return result;
  }

  // Helper: get video dimensions from URL using metadata loading
  async function getVideoDim(url: string, timeoutMs = 5000): Promise<{ w: number; h: number }> {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      const timer = setTimeout(() => {
        video.src = '';
        resolve({ w: 640, h: 360 });
      }, timeoutMs);
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        const w = video.videoWidth || 640;
        const h = video.videoHeight || 360;
        video.src = '';
        resolve({ w, h });
      };
      video.onerror = () => {
        clearTimeout(timer);
        video.src = '';
        resolve({ w: 640, h: 360 });
      };
      video.src = url;
    });
  }

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
          maxAssetSize={Infinity}
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
        enableImageStrength={enableImageStrength}
        enablePrompt={enablePrompt}
        enableImage={enableImage}
        enableVideo={enableVideo}
        strengthDefs={strengthDefs}
        enableSlot={enableSlot}
        slotDefs={slotDefs}
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
export type { VideoInfo };
