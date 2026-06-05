import React, { useCallback, useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import { Editor, TLImageShape, TLAsset } from '@tldraw/tldraw';
import ThumbnailList from './ThumbnailList';

export interface ImageInfo {
  id: string;
  name: string;
  dataUrl: string;
  assetId: string;
  shapeId: string;
  strengths?: Record<string, number>;
}

export interface PanelHandle {
  setImages: (images: ImageInfo[]) => void;
  setPrompt: (prompt: string) => void;
}

interface PanelProps {
  editor: React.RefObject<Editor | null>;
  onHeightChange: (height: number) => void;
  onConfirm: (data: { images: ImageInfo[]; enableStrength: boolean; prompt: string }) => void;
  enableStrength: boolean;
  enablePrompt: boolean;
  strengthDefs?: { name: string; default: number }[];
}

const Panel = forwardRef<PanelHandle, PanelProps>(({ editor: editorRef, onHeightChange, onConfirm, enableStrength, enablePrompt, strengthDefs = [] }, ref) => {
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [prompt, setPrompt] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);

  // Expose setImages and setPrompt to parent for snapshot restore
  useImperativeHandle(ref, () => ({
    setImages: (newImages: ImageInfo[]) => setImages(newImages),
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
  }, [images, onHeightChange]);

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
    onConfirm({ images, enableStrength, prompt });
  }, [images, enableStrength, prompt, onConfirm]);

  return (
    <div
      ref={panelRef}
      style={{
        position: 'absolute',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'min(90%, 700px)',
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
          flexDirection: 'row',
          gap: 16,
          alignItems: 'stretch',
        }}
      >


        {/* Right side: original content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Image thumbnails row with + button at the end */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ThumbnailList images={images} onRemove={removeImage} enableStrength={enableStrength} strengthDefs={strengthDefs} onStrengthChange={updateStrength} />
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
      </div>
    </div>
  );
});

Panel.displayName = 'Panel';

export default Panel;
