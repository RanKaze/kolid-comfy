import React, { useCallback, useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import { Editor, TLImageShape, TLVideoShape, TLAsset } from '@tldraw/tldraw';
import ThumbnailList from './ThumbnailList';

export interface ImageInfo {
  id: string;
  name: string;
  dataUrl: string;
  assetId: string;
  shapeId: string;
  strengths?: Record<string, number>;
}

export interface VideoInfo {
  id: string;
  name: string;
  dataUrl: string;
  assetId: string;
  shapeId: string;
  aspectRatio?: number; // width / height
}

export interface PanelHandle {
  setImages: (images: ImageInfo[]) => void;
  setVideos: (videos: VideoInfo[]) => void;
  setPrompt: (prompt: string) => void;
}

interface PanelProps {
  editor: React.RefObject<Editor | null>;
  onHeightChange: (height: number) => void;
  onConfirm: (data: { images: ImageInfo[]; videos: VideoInfo[]; enableStrength: boolean; prompt: string }) => void;
  enableStrength: boolean;
  enablePrompt: boolean;
  strengthDefs?: { name: string; default: number }[];
}

// Video Card Component with dynamic width based on aspect ratio
const VideoCard: React.FC<{
  vid: VideoInfo;
  onRemove: (id: string) => void;
}> = ({ vid, onRemove }) => {
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

const Panel = forwardRef<PanelHandle, PanelProps>(({ editor: editorRef, onHeightChange, onConfirm, enableStrength, enablePrompt, strengthDefs = [] }, ref) => {
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [videos, setVideos] = useState<VideoInfo[]>([]);
  const [prompt, setPrompt] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);

  // Expose setImages, setVideos and setPrompt to parent for snapshot restore
  useImperativeHandle(ref, () => ({
    setImages: (newImages: ImageInfo[]) => setImages(newImages),
    setVideos: (newVideos: VideoInfo[]) => setVideos(newVideos),
    setPrompt: (newPrompt: string) => setPrompt(newPrompt),
  }));

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

  const handleLocalConfirm = useCallback(() => {
    onConfirm({ images, videos, enableStrength, prompt });
  }, [images, videos, enableStrength, prompt, onConfirm]);

  return (
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
        {/* Image thumbnails row */}
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
            <ThumbnailList images={images} onRemove={removeImage} enableStrength={enableStrength} strengthDefs={strengthDefs} onStrengthChange={updateStrength} />
          </div>
          <button
            onClick={() => {
              const editor = editorRef.current;
              if (!editor) return;

              const selectedShapeIds = editor.getSelectedShapeIds();
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

        {/* Video thumbnails row */}
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
              <VideoCard key={vid.id} vid={vid} onRemove={removeVideo} />
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
  );
});

Panel.displayName = 'Panel';

export default Panel;
