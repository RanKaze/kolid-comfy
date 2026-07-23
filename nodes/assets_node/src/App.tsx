import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Tldraw, createTLStore, defaultShapeUtils, Editor, AssetRecordType, TLVideoShape, TLAsset, DefaultContextMenu, useEditor, BaseBoxShapeUtil, HTMLContainer, T, TLBaseShape } from '@tldraw/tldraw';
import type { TLComponents } from '@tldraw/tldraw';
import '@tldraw/tldraw/tldraw.css';
import Panel, { PanelHandle, ImageInfo, VideoInfo, AudioInfo } from './components/Panel';

// ── Custom audio shape ──────────────────────────────────────────────
type AudioShape = TLBaseShape<'audio', { w: number; h: number; src: string; name: string }>;

class AudioShapeUtil extends BaseBoxShapeUtil<AudioShape> {
  static override type = 'audio' as const;
  static override props = {
    w: T.number,
    h: T.number,
    src: T.string,
    name: T.string,
  };
  override getDefaultProps() {
    return { w: 320, h: 80, src: '', name: 'audio' };
  }
  override component(shape: AudioShape) {
    return (
      <HTMLContainer
        style={{
          width: shape.props.w,
          height: shape.props.h,
          display: 'flex',
          flexDirection: 'column',
          background: '#fff',
          border: '1px solid #d0d0d0',
          borderRadius: 8,
          overflow: 'hidden',
          pointerEvents: 'all',
          padding: '6px 8px 4px',
          gap: 4,
        }}
      >
        <div
          style={{
            fontSize: 12,
            color: '#333',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            paddingLeft: 4,
          }}
        >
          🎵 {shape.props.name}
        </div>
        <audio
          src={shape.props.src}
          controls
          preload="metadata"
          style={{ width: '100%', height: 32, minWidth: 0 }}
        />
      </HTMLContainer>
    );
  }
  override indicator(shape: AudioShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} ry={8} />;
  }
}

// Module-level ref to PanelHandle so CustomContextMenu can trigger capture
let _panelHandle: PanelHandle | null = null;

// Custom context menu that extends tldraw's default with a "采样" option for video shapes
const CustomContextMenu: React.FC = () => {
  const editor = useEditor();
  const selectedShapes = editor.getSelectedShapes();
  const videoShape = selectedShapes.find((s): s is TLVideoShape => s.type === 'video');

  const handleSample = useCallback(() => {
    if (!videoShape || !_panelHandle) return;
    if (!videoShape.props.assetId) return;
    const asset = editor.getAsset(videoShape.props.assetId) as TLAsset | undefined;
    if (!asset) return;
    const src = (asset.props as any)?.src || '';
    const name = (asset.props as any)?.name || 'video';
    _panelHandle.startCapture({
      id: `vid_cm_${Date.now()}`,
      name,
      dataUrl: src,
      assetId: videoShape.props.assetId as string,
      shapeId: videoShape.id as string,
    });
  }, [editor, videoShape]);

  // Render tldraw's default context menu, plus "采样" for videos
  return (
    <>
      <DefaultContextMenu />
      {videoShape && (
        <button
          onClick={handleSample}
          className="tlui-button tlui-button__menu"
          style={{
            display: 'block',
            width: '100%',
            textAlign: 'left',
            padding: '6px 12px',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          📷 采样
        </button>
      )}
    </>
  );
};

const components: TLComponents = {
  ContextMenu: CustomContextMenu,
};

const App: React.FC = () => {
  const [inputData, setInputData] = useState('');
  const editorRef = useRef<Editor | null>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  const [pendingSnapshot, setPendingSnapshot] = useState<string | null>(null);
  const [enableImageConfig, setEnableImageConfig] = useState(false);
  const [enablePrompt, setEnablePrompt] = useState(false);
  const [enableImage, setEnableImage] = useState(true);  // Image area enabled by default
  const [enableVideo, setEnableVideo] = useState(true);  // Video area enabled by default
  const [enableAudio, setEnableAudio] = useState(true);  // Audio area enabled by default
  const [imageConfigDefs, setImageConfigDefs] = useState<{ name: string; type: string; default: any; min?: number; max?: number; step?: number }[]>([]);
  const [enableSlot, setEnableSlot] = useState(false);
  const [slotDefs, setSlotDefs] = useState<{ type: string; name: string }[]>([]);
  const [globalMode, setGlobalMode] = useState(false);  // Whether data is a name for disk persistence
  const panelHandleRef = useRef<PanelHandle>(null);

  // Sync panelHandle to module-level ref for CustomContextMenu access
  useEffect(() => {
    _panelHandle = panelHandleRef.current;
  });

  useEffect(() => {
    fetch('/input_data')
      .then((res) => res.json())
      .then((data) => {
        setInputData(data.input_data || '');

        // Set node input flags
        setEnableImageConfig(data.enable_image_config || false);
        setEnablePrompt(data.enable_prompt || false);
        setEnableImage(data.enable_image !== undefined ? data.enable_image : true);
        setEnableVideo(data.enable_video !== undefined ? data.enable_video : true);
        setEnableAudio(data.enable_audio !== undefined ? data.enable_audio : true);
        setImageConfigDefs(data.image_config_defs || []);
        setEnableSlot(data.enable_slot || false);
        setSlotDefs(data.slot_defs || []);
        setGlobalMode(data.global_mode || false);

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
      shapeUtils: [...defaultShapeUtils, AudioShapeUtil],
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
      if (parsed.panelAudios && Array.isArray(parsed.panelAudios)) {
        panelHandleRef.current?.setAudios?.(parsed.panelAudios);
      }
      if (parsed.panelSlots && Array.isArray(parsed.panelSlots)) {
        panelHandleRef.current?.setSlots?.(parsed.panelSlots);
      }

      // Note: enableImageConfig and enablePrompt are controlled by node inputs, not snapshot

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

  const handleConfirm = useCallback(async ({ images, videos, audios, enableImageConfig, prompt, slots }: { images: ImageInfo[]; videos: VideoInfo[]; audios: AudioInfo[]; enableImageConfig: boolean; prompt: string; slots: ({ type: string; data: any })[] }) => {
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
      image_infos: img.image_infos,
    }));

    // Save panel selected videos info
    const panelVideos = videos.map((vid) => ({
      id: vid.id,
      name: vid.name,
      dataUrl: vid.dataUrl,
      assetId: vid.assetId,
      shapeId: vid.shapeId,
    }));

    // Save panel selected audios info
    const panelAudios = audios.map((aud) => ({
      id: aud.id,
      name: aud.name,
      dataUrl: aud.dataUrl,
      assetId: aud.assetId,
      shapeId: aud.shapeId,
    }));

    // Save panel selected slots info
    const panelSlots = slots.map((slot) => {
      const item = slot.data;
      if (!item) return { type: slot.type, data: null };
      if (slot.type === 'Image') {
        return {
          type: 'Image',
          data: { id: item.id, name: item.name, dataUrl: item.dataUrl, assetId: item.assetId, shapeId: item.shapeId },
        };
      }
      if (slot.type === 'Audio') {
        return {
          type: 'Audio',
          data: { id: item.id, name: item.name, dataUrl: item.dataUrl, assetId: item.assetId, shapeId: item.shapeId },
        };
      }
      return {
        type: 'Video',
        data: { id: item.id, name: item.name, dataUrl: item.dataUrl, assetId: item.assetId, shapeId: item.shapeId },
      };
    });

    // Save camera position and zoom
    const camera = editor.getCamera();

    const canvasState = {
      store: filteredStore,
      schema: snapshot.schema,
      panelImages: panelImages,
      panelVideos: panelVideos,
      panelAudios: panelAudios,
      panelSlots: panelSlots,
      enableImageConfig,
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
        image_infos: enableImageConfig ? img.image_infos : undefined,
      }));
      const selectedVideos = videos.map((vid) => ({
        video: vid.dataUrl,
      }));
      const selectedAudios = audios.map((aud) => ({
        audio: aud.dataUrl,
      }));
      const selectedSlots = slots.map((slot) => {
        if (!slot.data) return { type: slot.type, data: null };
        if (slot.type === 'Image') {
          return { type: 'Image', data: { image: slot.data.dataUrl } };
        }
        if (slot.type === 'Audio') {
          return { type: 'Audio', data: { audio: slot.data.dataUrl } };
        }
        return { type: 'Video', data: { video: slot.data.dataUrl } };
      });
      console.log('[App] handleConfirm sending prompt:', prompt);
      await fetch('/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: selectedImages,
          videos: selectedVideos,
          audios: selectedAudios,
          slots: selectedSlots,
          prompt: prompt || '',
          canvas_snapshot: snapshotJson,
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
        if (file.type.startsWith('video/') || file.type === 'image/gif' || file.type.startsWith('audio/')) {
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
        const audioFile = files.find((f: File) => f.type?.startsWith('audio/'));
        const videoFile = files.find((f: File) => f.type?.startsWith('video/') || f.type === 'image/gif');
        
        // Handle single audio file: upload to server, create note shape with audioAssetId meta
        if (audioFile && files.length === 1) {
          console.log('[SnapshotAssets] Intercepted audio drop, uploading via server...');
          try {
            const result = await uploadVideoToServer(audioFile);
            const shapeId = `shape:${Date.now()}_${Math.random().toString(36).substr(2, 9)}` as any;
            const point = content?.point;
            editor.createShape({
              id: shapeId, type: 'audio',
              x: point?.x ?? 0, y: point?.y ?? 0,
              props: { w: 320, h: 60, src: result.url, name: audioFile.name },
            } as any);
            console.log('[SnapshotAssets] Audio shape created with URL:', result.url);
            return;
          } catch (err) {
            console.error('[SnapshotAssets] Audio interception failed:', err);
            throw err;
          }
        }
        
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
          shapeUtils={[...defaultShapeUtils, AudioShapeUtil]}
          onMount={handleMount}
          maxAssetSize={Infinity}
          components={components}
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
        enableImageConfig={enableImageConfig}
        enablePrompt={enablePrompt}
        enableImage={enableImage}
        enableVideo={enableVideo}
        enableAudio={enableAudio}
        imageConfigDefs={imageConfigDefs}
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
