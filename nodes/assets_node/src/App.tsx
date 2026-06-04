import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Tldraw, createTLStore, defaultShapeUtils, AssetRecordType, Editor } from '@tldraw/tldraw';
import '@tldraw/tldraw/tldraw.css';

interface ImageInfo {
  id: string;
  name: string;
  dataUrl: string;
  assetId: string;
  shapeId: string;
}

const App: React.FC = () => {
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [inputData, setInputData] = useState('');
  const editorRef = useRef<Editor | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const idCounterRef = useRef(0);

  useEffect(() => {
    fetch('/input_data')
      .then((res) => res.json())
      .then((data) => {
        setInputData(data.input_data || '');
      })
      .catch((err) => console.error('Failed to load input data:', err));
  }, []);

  const store = useRef(
    createTLStore({
      shapeUtils: defaultShapeUtils,
    })
  ).current;

  const addImage = useCallback(async (file: File, x: number, y: number) => {
    if (!file.type.startsWith('image/')) return;

    const editor = editorRef.current;
    if (!editor) return;

    const id = `img_${++idCounterRef.current}`;
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

    const shapeId = `shape:${id}`;
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

    setImages((prev) => [...prev, { id, name: file.name, dataUrl, assetId, shapeId }]);
  }, []);

  const removeImage = useCallback(
    (id: string) => {
      const editor = editorRef.current;
      if (!editor) return;

      const info = images.find((img) => img.id === id);
      if (!info) return;

      editor.deleteShape(info.shapeId);
      try {
        editor.deleteAsset(info.assetId);
      } catch (e) {
        // ignore
      }
      setImages((prev) => prev.filter((img) => img.id !== id));
    },
    [images]
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.relatedTarget === null) {
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);

      const files = Array.from(e.dataTransfer.files);
      const rect = containerRef.current?.getBoundingClientRect();
      const dropX = rect ? e.clientX - rect.left : 100;
      const dropY = rect ? e.clientY - rect.top : 100;

      let offset = 0;
      for (const file of files) {
        await addImage(file, dropX + offset, dropY + offset);
        offset += 20;
      }
    },
    [addImage]
  );

  const handleConfirm = useCallback(async () => {
    const selectedImages = images.map((img) => img.dataUrl);
    try {
      await fetch('/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: selectedImages }),
      });
    } catch (err) {
      console.error('Confirm failed:', err);
    }
    window.close();
  }, [images]);

  useEffect(() => {
    const onBeforeUnload = () => {
      fetch('/window_closed', { method: 'POST', body: '{}' });
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
      }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(74, 158, 255, 0.15)',
            border: '3px dashed #4a9eff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            pointerEvents: 'none',
          }}
        >
          <span style={{ fontSize: 24, color: '#4a9eff', fontWeight: 600 }}>
            Drop images here
          </span>
        </div>
      )}

      <div
        ref={containerRef}
        style={{ flex: 1, position: 'relative', minHeight: 0, background: '#111' }}
      >
        <Tldraw
          store={store}
          onMount={(editor) => {
            editorRef.current = editor;
            editor.updateInstanceState({ isDebugMode: false });
          }}
        />
      </div>

      <div
        style={{
          height: 56,
          background: '#2a2a2a',
          borderTop: '1px solid #3a3a3a',
          display: 'flex',
          alignItems: 'center',
          padding: '0 16px',
          gap: 12,
          flexShrink: 0,
        }}
      >
        <label
          htmlFor="image-select"
          style={{ fontSize: 14, color: '#ccc', whiteSpace: 'nowrap' }}
        >
          Selected ({images.length}):
        </label>
        <select
          id="image-select"
          multiple
          style={{
            flex: 1,
            minWidth: 0,
            height: 36,
            background: '#1a1a1a',
            color: '#f5f5f5',
            border: '1px solid #444',
            borderRadius: 6,
            padding: '0 8px',
            fontSize: 14,
          }}
          onKeyDown={(e) => {
            if (e.key === 'Delete' || e.key === 'Backspace') {
              const selected = Array.from(e.currentTarget.selectedOptions).map(
                (o) => o.value
              );
              selected.forEach((id) => removeImage(id));
            }
          }}
        >
          {images.map((img) => (
            <option key={img.id} value={img.id} selected>
              {img.name}
            </option>
          ))}
        </select>
        <button
          onClick={handleConfirm}
          disabled={images.length === 0}
          style={{
            height: 36,
            padding: '0 20px',
            background: images.length === 0 ? '#555' : '#4a9eff',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            fontSize: 14,
            fontWeight: 600,
            cursor: images.length === 0 ? 'not-allowed' : 'pointer',
            transition: 'background 0.2s',
          }}
        >
          Confirm
        </button>
      </div>

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
