import React, { useCallback, useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import { createPortal } from 'react-dom';
import { Editor, TLImageShape, TLVideoShape, TLAsset, AssetRecordType } from '@tldraw/tldraw';
import ThumbnailList from './ThumbnailList';

export interface ImageInfo {
  id: string;
  name: string;
  dataUrl: string;
  assetId: string;
  shapeId: string;
  width?: number;
  height?: number;
  strengths?: Record<string, number>;
}

export interface VideoInfo {
  id: string;
  name: string;
  dataUrl: string;
  assetId: string;
  shapeId: string;
  aspectRatio?: number;
}

export interface SlotItem {
  type: string;  // 'Image' | 'Video'
  data: ImageInfo | VideoInfo | null;
}

export interface PanelHandle {
  setImages: (images: ImageInfo[]) => void;
  setVideos: (videos: VideoInfo[]) => void;
  setSlots: (slots: SlotItem[]) => void;
  setPrompt: (prompt: string) => void;
  startCapture: (vid: VideoInfo) => void;
}

interface PanelProps {
  editor: React.RefObject<Editor | null>;
  onHeightChange: (height: number) => void;
  onConfirm: (data: { images: ImageInfo[]; videos: VideoInfo[]; enableImageStrength: boolean; prompt: string; slots: SlotItem[] }) => void;
  enableImageStrength: boolean;
  enablePrompt: boolean;
  enableImage?: boolean;  // Show/hide image area (default true)
  enableVideo?: boolean;  // Show/hide video area (default true)
  strengthDefs?: { name: string; default: number }[];
  enableSlot?: boolean;
  slotDefs?: { type: string; name: string }[];
}

// Frame Capture Modal - allows capturing a frame from a video
// iOS-style Frame Capture Modal — frosted glass background, centered
const FrameCaptureModal: React.FC<{
  videoUrl: string;
  videoName: string;
  onCapture: (imageInfo: ImageInfo) => void;
  onClose: () => void;
}> = ({ videoUrl, videoName, onCapture, onClose }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [visible, setVisible] = useState(false);

  // Fade-in animation on mount
  useEffect(() => { requestAnimationFrame(() => setVisible(true)); }, []);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (video) setDuration(video.duration);
  }, []);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (video) setCurrentTime(video.currentTime);
  }, []);

  const handleCapture = useCallback(() => {
    console.log('[DEBUG:FrameCaptureModal] handleCapture START');
    const video = videoRef.current;
    const canvas = canvasRef.current;
    console.log('[DEBUG:FrameCaptureModal] video:', !!video, 'videoWidth:', video?.videoWidth, 'videoHeight:', video?.videoHeight);
    console.log('[DEBUG:FrameCaptureModal] canvas:', !!canvas);
    if (!video || !canvas) { console.warn('[DEBUG:FrameCaptureModal] Missing video or canvas, aborting'); return; }
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 360;
    console.log('[DEBUG:FrameCaptureModal] canvas set to:', canvas.width, 'x', canvas.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) { console.warn('[DEBUG:FrameCaptureModal] No 2d context'); return; }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');
    console.log('[DEBUG:FrameCaptureModal] dataUrl length:', dataUrl.length, 'prefix:', dataUrl.substring(0, 40));
    const imgInfo: ImageInfo = {
      id: `capture_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      name: `${videoName}_${formatTime(currentTime)}.png`,
      dataUrl,
      assetId: '',
      shapeId: '',
      width: canvas.width,
      height: canvas.height,
    };
    console.log('[DEBUG:FrameCaptureModal] imgInfo created:', { id: imgInfo.id, name: imgInfo.name, w: imgInfo.width, h: imgInfo.height });
    console.log('[DEBUG:FrameCaptureModal] calling onCapture... typeof onCapture:', typeof onCapture);
    onCapture(imgInfo);
    console.log('[DEBUG:FrameCaptureModal] onCapture returned');
  }, [videoName, currentTime, onCapture]);

  const formatTime = (t: number) => {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // iOS system blue
  const iosBlue = '#007AFF';

  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        zIndex: 2000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        // Frosted glass background — blur + semi-transparent dark
        background: 'rgba(0, 0, 0, 0.35)',
        backdropFilter: 'blur(24px) saturate(180%)',
        WebkitBackdropFilter: 'blur(24px) saturate(180%)',
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.25s ease-out',
      }}
      onClick={onClose}
    >
      {/* iOS card — white rounded with shadow */}
      <div
        style={{
          background: 'rgba(255, 255, 255, 0.95)',
          borderRadius: 20,
          padding: 0,
          width: 'min(92vw, 720px)',
          maxHeight: '90vh',
          overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 25px 60px rgba(0,0,0,0.3), 0 0 0 0.5px rgba(0,0,0,0.12)',
          transform: visible ? 'scale(1)' : 'scale(0.92)',
          transition: 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* iOS-style header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '18px 20px 12px',
          borderBottom: '1px solid rgba(0,0,0,0.08)',
        }}>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none',
              color: iosBlue, fontSize: 17, fontWeight: 400,
              cursor: 'pointer', padding: '4px 0',
              fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
            }}
          >取消</button>
          <span style={{
            fontSize: 16, fontWeight: 600,
            color: '#1c1c1e',
            fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif',
            letterSpacing: '-0.2px',
          }}>截取帧</span>
          <button
            onClick={handleCapture}
            style={{
              background: 'none', border: 'none',
              color: iosBlue, fontSize: 17, fontWeight: 600,
              cursor: 'pointer', padding: '4px 0',
              fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
            }}
          >截取</button>
        </div>

        {/* Video player card */}
        <div style={{ padding: '12px 16px' }}>
          <div style={{
            position: 'relative', background: '#000',
            borderRadius: 12, overflow: 'hidden',
            boxShadow: '0 2px 12px rgba(0,0,0,0.15)',
          }}>
            <video
              ref={videoRef} src={videoUrl}
              style={{ width: '100%', display: 'block', borderRadius: 12 }}
              controls={true}
              crossOrigin="anonymous"
              onLoadedMetadata={handleLoadedMetadata}
              onTimeUpdate={handleTimeUpdate}
              preload="auto"
            />
            <canvas ref={canvasRef} style={{ display: 'none' }} />
          </div>
        </div>

        {/* Video name subtitle */}
        <div style={{ padding: '0 20px 20px' }}>
          <div style={{
            fontSize: 13, color: '#8e8e93',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
          }}>
            {videoName}
          </div>
        </div>
      </div>
    </div>
  );
};

// Video Card Component with dynamic width based on aspect ratio
const VideoCard: React.FC<{
  vid: VideoInfo;
  onRemove: (id: string) => void;
  onCaptureFrame?: (vid: VideoInfo) => void;
}> = ({ vid, onRemove, onCaptureFrame }) => {
  const [aspectRatio, setAspectRatio] = useState<number>(16 / 9); // Default to 16:9
  const CARD_HEIGHT = 280; // Fixed height in pixels (increased for better viewing)

  // Load video metadata to get aspect ratio
  useEffect(() => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = vid.dataUrl;
    
    video.onloadedmetadata = () => {
      const ratio = video.videoWidth / video.videoHeight;
      setAspectRatio(ratio || 16 / 9);
    };
    
    return () => {
      video.src = '';
    };
  }, [vid.dataUrl]);

  // Calculate card width based on aspect ratio
  const cardWidth = Math.round(CARD_HEIGHT * aspectRatio);

  return (
    <div
      style={{
        position: 'relative',
        width: cardWidth,
        height: CARD_HEIGHT,
        borderRadius: 8,
        overflow: 'hidden',
        border: '1px solid #ddd',
        background: '#000',
        flexShrink: 0,
      }}
    >
      <video
        src={vid.dataUrl}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
        }}
        controls={true}
        preload="metadata"
      />
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove(vid.id);
        }}
        style={{
          position: 'absolute',
          top: 4,
          right: 4,
          width: 22,
          height: 22,
          borderRadius: '50%',
          border: 'none',
          background: 'rgba(0,0,0,0.7)',
          color: '#fff',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 16,
          lineHeight: 1,
          padding: 0,
          zIndex: 10,
          transition: 'background 0.2s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(255,0,0,0.8)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'rgba(0,0,0,0.7)';
        }}
        title="Remove video"
      >
        ×
      </button>
      {/* Frame capture button */}
      {onCaptureFrame && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onCaptureFrame(vid);
          }}
          style={{
            position: 'absolute',
            top: 4,
            right: 32,
            width: 22,
            height: 22,
            borderRadius: '50%',
            border: 'none',
            background: 'rgba(0,0,0,0.7)',
            color: '#fff',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 13,
            lineHeight: 1,
            padding: 0,
            zIndex: 10,
            transition: 'background 0.2s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(74,158,255,0.8)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(0,0,0,0.7)';
          }}
          title="Capture frame from video"
        >
          📷
        </button>
      )}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          padding: '4px 8px',
          fontSize: 11,
          color: '#fff',
          background: 'linear-gradient(transparent, rgba(0,0,0,0.8))',
          textShadow: '0 1px 2px rgba(0,0,0,0.8)',
          pointerEvents: 'none',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {vid.name}
      </div>
    </div>
  );
};

// Slot Card Component - shows a slot with type indicator
const SlotCard: React.FC<{
  slot: SlotItem;
  slotIndex: number;
  slotName: string;
  editorRef: React.RefObject<Editor | null>;
  onFill: (index: number, item: ImageInfo | VideoInfo) => void;
  onClear: (index: number) => void;
  onCaptureRequest?: (vid: VideoInfo, slotIndex: number) => void;  // Open frame capture when video selected for Image slot
}> = ({ slot, slotIndex, slotName, editorRef, onFill, onClear, onCaptureRequest }) => {
  const SLOT_HEIGHT = 280; // Aligned with VideoCard CARD_HEIGHT
  const [mediaAspect, setMediaAspect] = useState<number>(1); // Default 1:1 for image, 16:9 for video

  const handleAdd = useCallback(() => {
    console.log('[SlotCard] handleAdd START — slotIndex:', slotIndex, 'slot.type:', slot.type, 'slot.data:', slot.data);
    const editor = editorRef.current;
    if (!editor) {
      console.warn('[SlotCard] No editor! Returning.');
      return;
    }

    const selectedShapeIds = editor.getSelectedShapeIds();
    console.log('[SlotCard] selectedShapeIds count:', selectedShapeIds.length, 'ids:', selectedShapeIds);
    const targetType = slot.type.toLowerCase();
    console.log('[SlotCard] targetType:', targetType);
    
    // Log all selected shapes for debugging
    const allShapes = selectedShapeIds.map((id) => editor.getShape(id));
    console.log('[SlotCard] all selected shapes:', allShapes.map(s => ({ id: s?.id, type: s?.type })));
    
    const matchingShapes = allShapes.filter((shape) => shape?.type === targetType);
    console.log('[SlotCard] matchingShapes count:', matchingShapes.length);

    if (matchingShapes.length === 0) {
      // If this is an Image slot and a video is selected, offer frame capture
      if (slot.type === 'Image' && onCaptureRequest) {
        const selectedVideos = allShapes.filter((s) => s?.type === 'video');
        if (selectedVideos.length > 0) {
          const vShape = selectedVideos[0]!;
          const vAssetId = (vShape.props as any).assetId;
          if (vAssetId) {
            const vAsset = editor.getAsset(vAssetId) as any;
            if (vAsset && vAsset.type === 'video') {
              const vSrc = (vAsset.props as any).src as string;
              const vName = (vAsset.props as any).name as string || 'video';
              console.log('[SlotCard] opening frame capture for Image slot from video:', vName);
              onCaptureRequest({ id: `vid_${Date.now()}`, name: vName, dataUrl: vSrc, assetId: vAssetId as string, shapeId: vShape.id as string }, slotIndex);
              return;
            }
          }
        }
      }
      alert(`No ${slot.type} selected. Click on a ${slot.type.toLowerCase()} on the canvas to select it first.`);
      return;
    }

    // Take the first matching shape
    const shape = matchingShapes[0];
    if (!shape) {
      console.warn('[SlotCard] No matching shape found');
      return;
    }
    console.log('[SlotCard] shape:', shape);
    const assetId = (shape.props as any).assetId;
    console.log('[SlotCard] assetId:', assetId);
    if (!assetId) {
      console.warn('[SlotCard] No assetId on shape!');
      return;
    }

    const asset = editor.getAsset(assetId) as any;
    console.log('[SlotCard] asset:', asset, 'asset.type:', asset?.type);
    if (!asset || asset.type !== targetType) {
      console.warn('[SlotCard] Asset missing or type mismatch');
      return;
    }

    const src = (asset.props as any).src as string;
    const name = (asset.props as any).name as string || targetType;
    console.log('[SlotCard] Creating item with src:', src?.substring(0, 50), 'name:', name);

    const item: ImageInfo = {
      id: `slot_${slotIndex}_${Date.now()}`,
      name,
      dataUrl: src,
      assetId: assetId as string,
      shapeId: (shape as any).id as string,
    };
    console.log('[SlotCard] Calling onFill with item:', item);
    onFill(slotIndex, item);
    console.log('[SlotCard] onFill called successfully');
  }, [editorRef, slotIndex, slot.type, onFill]);

  const item = slot.data;
  const filled = item !== null;

  // Load media aspect ratio when slot is filled
  useEffect(() => {
    if (!item) {
      setMediaAspect(1);
      return;
    }
    if (slot.type === 'Video') {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.src = item.dataUrl;
      video.onloadedmetadata = () => {
        if (video.videoWidth && video.videoHeight) {
          setMediaAspect(video.videoWidth / video.videoHeight);
        } else {
          setMediaAspect(16 / 9);
        }
      };
      return () => { video.src = ''; };
    } else {
      const image = new Image();
      image.onload = () => {
        if (image.naturalWidth && image.naturalHeight) {
          setMediaAspect(image.naturalWidth / image.naturalHeight);
        }
      };
      image.src = item.dataUrl;
      return () => { image.src = ''; };
    }
  }, [item, slot.type]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        alignItems: 'center',
      }}
    >
      {/* Slot label */}
      <div
        style={{
          fontSize: 10,
          color: '#888',
          textAlign: 'center',
          maxWidth: 120,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontWeight: 600,
        }}
        title={`${slotName} (${slot.type})`}
      >
        {slotName}
      </div>

      {/* Slot body */}
      {filled ? (
        /* Filled: show preview */
        (() => {
          const isVideo = slot.type === 'Video';
          const slotWidth = Math.round(SLOT_HEIGHT * mediaAspect);
          const slotHeight = SLOT_HEIGHT;
          return (
        <div
          style={{
            position: 'relative',
            width: slotWidth,
            height: slotHeight,
            borderRadius: 6,
            overflow: 'hidden',
            border: `2px solid ${isVideo ? '#60a5fa' : '#4ade80'}`,
            background: isVideo ? '#000' : '#f0f0f0',
            flexShrink: 0,
          }}
        >
          {isVideo ? (
            <video
              src={item!.dataUrl}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain',
              }}
              controls
              preload="metadata"
              playsInline
              muted
            />
          ) : (
            <img
              src={item!.dataUrl}
              alt={item!.name}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                pointerEvents: 'none',
              }}
              draggable={false}
            />
          )}
          {/* Remove button */}
          <button
            onClick={() => onClear(slotIndex)}
            style={{
              position: 'absolute',
              top: 2,
              right: 2,
              width: 18,
              height: 18,
              borderRadius: '50%',
              border: 'none',
              background: 'rgba(0,0,0,0.7)',
              color: '#fff',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 12,
              lineHeight: 1,
              padding: 0,
              zIndex: 10,
              transition: 'background 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255,0,0,0.8)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(0,0,0,0.7)';
            }}
            title={`Remove from slot ${slotName}`}
          >
            ×
          </button>
          {/* File name */}
          <div
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              padding: '2px 4px',
              fontSize: 9,
              color: '#fff',
              background: 'linear-gradient(transparent, rgba(0,0,0,0.7))',
              pointerEvents: 'none',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {item!.name}
          </div>
        </div>
          );
        })()
      ) : (
        /* Empty: show + button */
        <button
          onClick={handleAdd}
          style={{
            width: 160,
            height: SLOT_HEIGHT,
            borderRadius: 6,
            border: '2px dashed #ccc',
            background: '#fafafa',
            cursor: 'pointer',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            fontSize: 36,
            color: '#aaa',
            transition: 'all 0.2s',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#f0f0f0';
            e.currentTarget.style.borderColor = '#999';
            e.currentTarget.style.color = '#666';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = '#fafafa';
            e.currentTarget.style.borderColor = '#ccc';
            e.currentTarget.style.color = '#aaa';
          }}
          title={`Add ${slot.type} to slot ${slotName}`}
        >
          <span>+</span>
          <span style={{ fontSize: 11, color: '#999' }}>{slot.type}</span>
        </button>
      )}
    </div>
  );
};

const Panel = forwardRef<PanelHandle, PanelProps>(({ editor: editorRef, onHeightChange, onConfirm, enableImageStrength, enablePrompt, enableImage = true, enableVideo = true, strengthDefs = [], enableSlot = false, slotDefs = [] }, ref) => {
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [videos, setVideos] = useState<VideoInfo[]>([]);
  const [slots, setSlots] = useState<SlotItem[]>(() =>
    enableSlot ? slotDefs.map((d) => ({ type: d.type, data: null })) : []
  );
  const [prompt, setPrompt] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);

  // Frame capture modal state — uses fillSlotRef to avoid TDZ issue (fillSlot defined later)
  const fillSlotRef = useRef<(index: number, item: ImageInfo | VideoInfo) => void>((index, item) => {
    // Placeholder — will be replaced when fillSlot is defined below
    console.warn('[Panel] fillSlotRef not set yet, ignoring slot fill');
  });
  const [captureTarget, setCaptureTarget] = useState<{ vid: VideoInfo; slotIndex?: number } | null>(null);
  const handleStartCapture = useCallback((vid: VideoInfo, slotIndex?: number) => {
    console.log('[DEBUG:handleStartCapture] Called with vid:', {
      id: vid.id, name: vid.name, shapeId: vid.shapeId, assetId: vid.assetId,
      dataUrlLen: vid.dataUrl?.length, slotIndex
    });
    setCaptureTarget({ vid, slotIndex });
    console.log('[DEBUG:handleStartCapture] captureTarget state set');
  }, []);
  const handleCaptureDone = useCallback((imgInfo: ImageInfo) => {
    console.log('[DEBUG:handleCaptureDone] ========== ENTER ==========');
    console.log('[DEBUG:handleCaptureDone] imgInfo:', {
      id: imgInfo.id, name: imgInfo.name,
      w: imgInfo.width, h: imgInfo.height,
      dataUrlLen: imgInfo.dataUrl?.length,
      dataUrlPrefix: imgInfo.dataUrl?.substring(0, 40),
    });
    console.log('[DEBUG:handleCaptureDone] captureTarget:', captureTarget ? {
      vidId: captureTarget.vid?.id,
      vidShapeId: captureTarget.vid?.shapeId,
      vidAssetId: captureTarget.vid?.assetId,
      slotIndex: captureTarget.slotIndex,
    } : 'NULL');

    const editor = editorRef.current;
    console.log('[DEBUG:handleCaptureDone] editor available:', !!editor);

    // Create a card (image shape) on the tldraw canvas
    if (editor) {
      try {
        console.log('[DEBUG:handleCaptureDone] Starting asset/shape creation...');
        const assetId = AssetRecordType.createId();
        const shapeId = `shape:${Date.now()}_${Math.random().toString(36).substr(2, 9)}` as any;
        console.log('[DEBUG:handleCaptureDone] Generated IDs — assetId:', assetId, 'shapeId:', shapeId);

        // Use actual captured frame dimensions, fallback to 300
        const imgW = imgInfo.width || 300;
        const imgH = imgInfo.height || 300;

        // Position the new card next to the source video shape, with offset
        const sourceVid = captureTarget?.vid;
        let x = 0;
        let y = 0;
        console.log('[DEBUG:handleCaptureDone] sourceVid shapeId:', sourceVid?.shapeId);
        if (sourceVid?.shapeId) {
          const vidShape = editor.getShape(sourceVid.shapeId as any);
          console.log('[DEBUG:handleCaptureDone] vidShape found:', !!vidShape, vidShape ? { x: vidShape.x, y: vidShape.y, w: (vidShape.props as any).w } : null);
          if (vidShape) {
            x = vidShape.x + ((vidShape.props as any).w || 300) + 40;
            y = vidShape.y;
          }
        }
        console.log('[DEBUG:handleCaptureDone] Position:', { x, y });

        // Check store state before creating
        const shapeCountBefore = editor.store.allRecords().filter((r: any) => r.typeName === 'shape').length;
        const assetCountBefore = editor.store.allRecords().filter((r: any) => r.typeName === 'asset').length;
        console.log('[DEBUG:handleCaptureDone] Store before — shapes:', shapeCountBefore, 'assets:', assetCountBefore);

        editor.createAssets([{
          id: assetId,
          typeName: 'asset',
          type: 'image' as any,
          meta: {},
          props: {
            name: imgInfo.name,
            src: imgInfo.dataUrl,
            w: imgW,
            h: imgH,
            mimeType: 'image/png',
            isAnimated: false,
          },
        } as any]);
        console.log('[DEBUG:handleCaptureDone] createAssets called');

        editor.createShape({
          id: shapeId,
          type: 'image',
          x,
          y,
          props: {
            w: imgW,
            h: imgH,
            assetId,
          },
        } as any);
        console.log('[DEBUG:handleCaptureDone] createShape called');

        // Verify the asset and shape were created
        const createdAsset = editor.getAsset(assetId as any);
        const createdShape = editor.getShape(shapeId as any);
        console.log('[DEBUG:handleCaptureDone] Verification — asset exists:', !!createdAsset, 'shape exists:', !!createdShape);
        if (createdShape) {
          console.log('[DEBUG:handleCaptureDone] Shape details:', {
            id: createdShape.id, type: createdShape.type,
            x: createdShape.x, y: createdShape.y,
            props: createdShape.props,
          });
        } else {
          console.error('[DEBUG:handleCaptureDone] SHAPE NOT FOUND after createShape!');
        }

        const shapeCountAfter = editor.store.allRecords().filter((r: any) => r.typeName === 'shape').length;
        const assetCountAfter = editor.store.allRecords().filter((r: any) => r.typeName === 'asset').length;
        console.log('[DEBUG:handleCaptureDone] Store after — shapes:', shapeCountAfter, 'assets:', assetCountAfter);

        // Update imgInfo with the new asset/shape IDs for tracking
        imgInfo.assetId = assetId as string;
        imgInfo.shapeId = shapeId as string;

        console.log('[DEBUG:handleCaptureDone] Frame capture card created OK');
      } catch (err) {
        console.error('[DEBUG:handleCaptureDone] FAILED to create capture card:', err);
        console.error('[DEBUG:handleCaptureDone] Error stack:', (err as Error).stack);
      }
    } else {
      console.warn('[DEBUG:handleCaptureDone] NO EDITOR available — cannot create canvas card!');
    }

    console.log('[DEBUG:handleCaptureDone] captureTarget.slotIndex:', captureTarget?.slotIndex);
    if (captureTarget?.slotIndex != null) {
      // From a slot → fill the slot via ref
      console.log('[DEBUG:handleCaptureDone] Filling slot index:', captureTarget.slotIndex);
      fillSlotRef.current(captureTarget.slotIndex, imgInfo);
    } else {
      // From image row / VideoCard → add to images list
      console.log('[DEBUG:handleCaptureDone] Adding to images list');
      setImages((prev) => {
        console.log('[DEBUG:handleCaptureDone] setImages — prev count:', prev.length, '→ new count:', prev.length + 1);
        return [...prev, imgInfo];
      });
    }
    console.log('[DEBUG:handleCaptureDone] Setting captureTarget to null (closing modal)');
    setCaptureTarget(null);
    console.log('[DEBUG:handleCaptureDone] ========== EXIT ==========');
  }, [captureTarget, editorRef]);
  const handleCaptureClose = useCallback(() => {
    setCaptureTarget(null);
  }, []);

  // Handle external setSlots (from snapshot restore via useImperativeHandle)
  const handleSetSlots = useCallback((newSlots: SlotItem[]) => {
    console.log('[Panel] External setSlots called with', newSlots.length, 'slots');
    if (newSlots.length > 0) {
      setSlots(newSlots);
      setSlotSyncCounter(c => c + 1);  // Trigger useEffect to check length
    }
  }, []);

  // Expose setImages, setVideos, setSlots, setPrompt, and startCapture to parent
  useImperativeHandle(ref, () => ({
    setImages: (newImages: ImageInfo[]) => setImages(newImages),
    setVideos: (newVideos: VideoInfo[]) => setVideos(newVideos),
    setSlots: handleSetSlots,
    setPrompt: (newPrompt: string) => setPrompt(newPrompt),
    startCapture: (vid: VideoInfo) => handleStartCapture(vid),
  }), [handleStartCapture, handleSetSlots]);

  // Slot initialization - syncs with slotDefs prop (which arrives asynchronously from fetch)
  // Uses a ref to track whether we've already initialized from slotDefs to avoid overwriting
  // externally set data (e.g., from snapshot restore)
  const slotsInitializedRef = useRef(false);
  // Counter to force re-sync after external setSlots
  const [slotSyncCounter, setSlotSyncCounter] = useState(0);
  
  useEffect(() => {
    if (enableSlot && slotDefs.length > 0) {
      // Always ensure slots array length matches slotDefs
      setSlots((prev) => {
        if (prev.length !== slotDefs.length) {
          console.log('[Panel] Syncing slots length, prev:', prev.length, 'new:', slotDefs.length);
          return slotDefs.map((d, i) => {
            if (i < prev.length && prev[i]?.type === d.type) {
              return prev[i];  // Preserve existing data for matching type+index
            }
            return { type: d.type, data: null };
          });
        }
        return prev;
      });
      slotsInitializedRef.current = true;
    } else if (!enableSlot) {
      slotsInitializedRef.current = false;
    }
  }, [enableSlot, slotDefs, slotSyncCounter]);

  // Measure panel height and report to parent
  useEffect(() => {
    if (!panelRef.current) return;

    const measurePanel = () => {
      const rect = panelRef.current?.getBoundingClientRect();
      if (rect) {
        const panelBottom = window.innerHeight - rect.top;
        onHeightChange(panelBottom + 12); // +12px gap
      }
    };

    measurePanel();

    window.addEventListener('resize', measurePanel);
    return () => window.removeEventListener('resize', measurePanel);
  }, [images, videos, onHeightChange]);

  const removeImage = useCallback(
    (id: string) => {
      const editor = editorRef.current;
      console.log('[Panel] removeImage called with id:', id);
      if (!editor) {
        console.log('[Panel] removeImage: no editor');
        return;
      }

      const info = images.find((img) => img.id === id);
      console.log('[Panel] removeImage found info:', info);
      if (!info) return;

      // Deselect this specific shape
      try {
        const currentSelectedIds = editor.getSelectedShapeIds();
        const newSelectedIds = currentSelectedIds.filter((sid) => sid !== info.shapeId);

        if (newSelectedIds.length !== currentSelectedIds.length) {
          (editor as any).selectShapes(newSelectedIds);
        }
      } catch (err) {
        console.error('[Panel] removeImage deselect error:', err);
      }

      // Remove from the selection list
      console.log('[Panel] removeImage calling setImages...');
      setImages((prev) => {
        const next = prev.filter((img) => img.id !== id);
        console.log('[Panel] removeImage setImages prev:', prev.length, 'next:', next.length);
        return next;
      });
    },
    [editorRef, images]
  );

  const removeVideo = useCallback(
    (id: string) => {
      const editor = editorRef.current;
      console.log('[Panel] removeVideo called with id:', id);
      if (!editor) {
        console.log('[Panel] removeVideo: no editor');
        return;
      }

      const info = videos.find((vid) => vid.id === id);
      console.log('[Panel] removeVideo found info:', info);
      if (!info) return;

      // Deselect this specific shape
      try {
        const currentSelectedIds = editor.getSelectedShapeIds();
        const newSelectedIds = currentSelectedIds.filter((sid) => sid !== info.shapeId);

        if (newSelectedIds.length !== currentSelectedIds.length) {
          (editor as any).selectShapes(newSelectedIds);
        }
      } catch (err) {
        console.error('[Panel] removeVideo deselect error:', err);
      }

      // Remove from the selection list
      console.log('[Panel] removeVideo calling setVideos...');
      setVideos((prev) => {
        const next = prev.filter((vid) => vid.id !== id);
        console.log('[Panel] removeVideo setVideos prev:', prev.length, 'next:', next.length);
        return next;
      });
    },
    [editorRef, videos]
  );

  const updateStrength = useCallback((id: string, name: string, value: number) => {
    setImages((prev) =>
      prev.map((img) =>
        img.id === id
          ? { ...img, strengths: { ...img.strengths, [name]: value } }
          : img
      )
    );
  }, []);

  // Slot handlers
  const fillSlot = useCallback((index: number, item: ImageInfo | VideoInfo) => {
    console.log('[Panel] fillSlot called with index:', index, 'item:', { id: item.id, name: item.name, dataUrl: item.dataUrl?.substring(0, 30) });
    setSlots((prev) => {
      console.log('[Panel] fillSlot prev slots:', prev.length, 'items');
      const next = [...prev];
      if (index < next.length) {
        next[index] = { ...next[index], data: item };
        console.log('[Panel] fillSlot updated index', index, 'to', { type: next[index].type, hasData: !!next[index].data });
      } else {
        console.warn('[Panel] fillSlot index', index, 'out of bounds, length:', next.length);
      }
      return next;
    });
  }, []);
  // Keep fillSlotRef in sync for handleCaptureDone
  fillSlotRef.current = fillSlot;

  const clearSlot = useCallback((index: number) => {
    setSlots((prev) => {
      const next = [...prev];
      if (index < next.length) {
        next[index] = { ...next[index], data: null };
      }
      return next;
    });
  }, []);

  const handleLocalConfirm = useCallback(() => {
    onConfirm({ images, videos, enableImageStrength, prompt, slots });
  }, [images, videos, enableImageStrength, prompt, slots, onConfirm]);

  return (
    <>
    <div
      ref={panelRef}
      style={{
        position: 'absolute',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'min(95%, 1200px)', // Increased from 700px to 1200px
        maxWidth: '95vw',
        zIndex: 1000,
      }}
    >
      {/* Main white card */}
      <div
        style={{
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
          padding: '12px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {/* Image thumbnails row — only shown when enableImage is true */}
        {enableImage && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              display: 'flex',
              gap: 8,
              overflowX: 'auto',
              overflowY: 'hidden',
              paddingBottom: 4,
              flex: '1 1 0',
              minWidth: 0,
              scrollbarWidth: 'thin', // Firefox
              msOverflowStyle: 'none', // IE/Edge
            }}
          >
            <ThumbnailList images={images} onRemove={removeImage} enableStrength={enableImageStrength} strengthDefs={strengthDefs} onStrengthChange={updateStrength} />
          </div>
          <button
            onClick={() => {
              const editor = editorRef.current;
              if (!editor) return;

              const selectedShapeIds = editor.getSelectedShapeIds();
              console.log('[Image+] selectedShapeIds:', selectedShapeIds);
              
              // Check if a video is selected → open frame capture for it
              const allSelectedShapes = selectedShapeIds.map((id) => editor.getShape(id));
              console.log('[Image+] allSelectedShapes:', allSelectedShapes.map(s => ({ id: s?.id, type: s?.type, hasAssetId: !!(s as any)?.props?.assetId })));
              
              const selectedVideoShapes = allSelectedShapes.filter(
                (shape): shape is TLVideoShape => shape?.type === 'video'
              );
              console.log('[Image+] selectedVideoShapes count:', selectedVideoShapes.length);
              
              if (selectedVideoShapes.length > 0) {
                const shape = selectedVideoShapes[0];
                const assetId = shape.props.assetId;
                console.log('[Image+] video shape assetId:', assetId);
                if (assetId) {
                  const asset = editor.getAsset(assetId) as TLAsset | undefined;
                  console.log('[Image+] video asset:', asset?.type, asset?.id);
                  if (asset && asset.type === 'video') {
                    const src = (asset.props as any).src as string;
                    const name = (asset.props as any).name as string || 'video';
                    console.log('[Image+] opening frame capture for:', name);
                    handleStartCapture({ id: `vid_${Date.now()}`, name, dataUrl: src, assetId: assetId as string, shapeId: shape.id as string });
                    return;
                  }
                  console.warn('[Image+] video asset not found or type mismatch');
                }
              }

              const selectedImageShapes = selectedShapeIds
                .map((id) => editor.getShape(id))
                .filter((shape): shape is TLImageShape => shape?.type === 'image');

              if (selectedImageShapes.length === 0) {
                alert('No images selected. Click on images on the canvas to select them first.');
                return;
              }

              let addedCount = 0;
              const newShapeIds: string[] = [];
              for (const shape of selectedImageShapes) {
                const assetId = shape.props.assetId;
                if (!assetId) continue;
                if (images.some((img) => img.shapeId === shape.id)) continue;

                const asset = editor.getAsset(assetId) as TLAsset | undefined;
                if (!asset || asset.type !== 'image') continue;

                const src = (asset.props as any).src as string;
                const name = (asset.props as any).name as string || 'image';

                setImages((prev) => [
                  ...prev,
                  {
                    id: `img_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                    name,
                    dataUrl: src,
                    assetId: assetId as string,
                    shapeId: shape.id as string,
                    strengths: strengthDefs.reduce((acc, d) => ({ ...acc, [d.name]: d.default }), {} as Record<string, number>),
                  },
                ]);
                newShapeIds.push(shape.id as string);
                addedCount++;
              }

              if (newShapeIds.length > 0) {
                (editor as any).selectShapes(newShapeIds);
              }

              if (addedCount === 0) {
                alert('All selected images are already in the list.');
              }
            }}
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              border: 'none',
              background: '#f0f0f0',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 18,
              color: '#666',
              fontWeight: 300,
              transition: 'background 0.2s',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#e0e0e0';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#f0f0f0';
            }}
            title="Add images from canvas"
          >
            +
          </button>
        </div>
        )}

        {/* Video thumbnails row — only shown when enableVideo is true */}
        {enableVideo !== false && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              display: 'flex',
              gap: 8,
              overflowX: 'auto',
              overflowY: 'hidden',
              paddingBottom: 4,
              flex: '1 1 0',
              minWidth: 0,
              scrollbarWidth: 'thin', // Firefox
              msOverflowStyle: 'none', // IE/Edge
            }}
          >
            {videos.map((vid) => (
              <VideoCard key={vid.id} vid={vid} onRemove={removeVideo} onCaptureFrame={handleStartCapture} />
            ))}
          </div>
          <button
            onClick={() => {
              const editor = editorRef.current;
              if (!editor) return;

              const selectedShapeIds = editor.getSelectedShapeIds();
              const selectedVideoShapes = selectedShapeIds
                .map((id) => editor.getShape(id))
                .filter((shape): shape is TLVideoShape => shape?.type === 'video');

              if (selectedVideoShapes.length === 0) {
                alert('No videos selected. Click on videos on the canvas to select them first.');
                return;
              }

              let addedCount = 0;
              const newShapeIds: string[] = [];
              for (const shape of selectedVideoShapes) {
                const assetId = shape.props.assetId;
                if (!assetId) continue;
                if (videos.some((vid) => vid.shapeId === shape.id)) continue;

                const asset = editor.getAsset(assetId) as TLAsset | undefined;
                if (!asset || asset.type !== 'video') continue;

                const src = (asset.props as any).src as string;
                const name = (asset.props as any).name as string || 'video';

                setVideos((prev) => [
                  ...prev,
                  {
                    id: `vid_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                    name,
                    dataUrl: src,
                    assetId: assetId as string,
                    shapeId: shape.id as string,
                  },
                ]);
                newShapeIds.push(shape.id as string);
                addedCount++;
              }

              if (newShapeIds.length > 0) {
                (editor as any).selectShapes(newShapeIds);
              }

              if (addedCount === 0) {
                alert('All selected videos are already in the list.');
              }
            }}
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              border: 'none',
              background: '#f0f0f0',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 18,
              color: '#666',
              fontWeight: 300,
              transition: 'background 0.2s',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#e0e0e0';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#f0f0f0';
            }}
            title="Add videos from canvas"
          >
            +
          </button>
        </div>
        )}

        {/* Slot row - only show when enableSlot is true */}
        {enableSlot && slotDefs.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
            {slotDefs.map((def, index) => (
              <SlotCard
                key={`${def.type}-${def.name}-${index}`}
                slot={slots[index] || { type: def.type, data: null }}
                slotIndex={index}
                slotName={def.name}
                editorRef={editorRef}
                onFill={fillSlot}
                onClear={clearSlot}
                onCaptureRequest={(vid, idx) => handleStartCapture(vid, idx)}
              />
            ))}
          </div>
        )}

        {/* Prompt input row - only show when enablePrompt is true */}
        {enablePrompt && (
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Ask for help ..."
            style={{
              border: 'none',
              background: 'transparent',
              color: '#666',
              fontSize: 14,
              outline: 'none',
              padding: 0,
              width: '100%',
            }}
          />
        )}

        {/* Bottom row: Confirm button with arrow icon */}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={handleLocalConfirm}
            style={{
              width: 36,
              height: 36,
              borderRadius: '50%',
              border: 'none',
              background: '#4a9eff',
              color: '#fff',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 0.2s',
              flexShrink: 0,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="19" x2="12" y2="5"></line>
              <polyline points="5 12 12 5 19 12"></polyline>
            </svg>
          </button>
        </div>
      </div>
      {/* Custom scrollbar styles */}
      <style>{`
        /* Webkit browsers (Chrome, Safari, Edge) */
        div::-webkit-scrollbar {
          height: 8px;
          width: 8px;
        }
        div::-webkit-scrollbar-track {
          background: rgba(0, 0, 0, 0.05);
          border-radius: 4px;
        }
        div::-webkit-scrollbar-thumb {
          background: rgba(0, 0, 0, 0.2);
          border-radius: 4px;
        }
        div::-webkit-scrollbar-thumb:hover {
          background: rgba(0, 0, 0, 0.35);
        }
        /* Hide scrollbar when not needed */
        div:has(> div:first-child)::-webkit-scrollbar {
          display: none;
        }
      `}</style>
    </div>
    {/* Frame capture modal — rendered via portal to body to escape Panel's transform */}
    {captureTarget && createPortal(
      <FrameCaptureModal
        videoUrl={captureTarget.vid.dataUrl}
        videoName={captureTarget.vid.name}
        onCapture={handleCaptureDone}
        onClose={handleCaptureClose}
      />,
      document.body
    )}
  </>
  );
});

Panel.displayName = 'Panel';

export default Panel;
