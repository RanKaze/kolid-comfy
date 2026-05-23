import React, { useEffect, useRef, useState } from 'react';
import IntSwitchCard from './components/IntSwitchCard';
import StringSwitchCard from './components/StringSwitchCard';
import ImageSwitchCard from './components/ImageSwitchCard';
import MaskSwitchCard from './components/MaskSwitchCard';
import JsonSwitchCard from './components/JsonSwitchCard';
import ConnectionSwitchCard from './components/ConnectionSwitchCard';
import CustomImageCard from './components/CustomImageCard';
import {
  startHoverSuck,
  stopHoverSuck,
  startInstantBurst,
  cleanupAllAnimations,
} from './animationManager';

interface PreviewItem {
  type: string;
  data: string;
}

interface InputItem {
  key: string;
  preview?: PreviewItem;
  nodeName?: string;
}

interface HistoryItem {
  key: string;
  src: string;
  name: string;
}

interface HoveredInfo {
  type: string;
  data: string;
  name: string;
}

const App: React.FC = () => {
  const [inputs, setInputs] = useState<InputItem[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nodeTitle, setNodeTitle] = useState<string>('Snapshot Switch');
  const [hovered, setHovered] = useState<HoveredInfo | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hoverRafRef = useRef<number | null>(null);
  const previewLockedRef = useRef(false);

  useEffect(() => {
    fetch('/inputs_data')
      .then((res) => res.json())
      .then((data) => {
        const keys: string[] = data.input_keys || [];
        const previews: Record<string, PreviewItem> = data.input_previews || {};
        const connections: Record<string, string> = data.connection_info || {};
        const hist: HistoryItem[] = data.history || [];
        const title = connections['__node_title__'] || 'Snapshot Switch';
        setNodeTitle(title);
        const items = keys.map((k) => ({
          key: k,
          preview: previews[k],
          nodeName: connections[k],
        }));
        setInputs(items);
        setHistory(hist);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const postSelection = (key: string, customImage?: string) => {
    setSelected(key);
    fetch('/select_input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selected_key: key, custom_image: customImage }),
    });
  };

  const handleCardClick = (key: string, imgSrc?: string, customImage?: string) => {
    stopHoverSuck();
    postSelection(key, customImage);
    if (imgSrc) {
      previewLockedRef.current = true;
      startInstantBurst(imgSrc, () => window.close());
    } else {
      setHovered(null);
      window.close();
    }
  };

  const handleCustomClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result as string;
      postSelection('__custom__', base64);
      window.close();
    };
    reader.readAsDataURL(file);
  };

  const handleDropFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result as string;
      postSelection('__custom__', base64);
      window.close();
    };
    reader.readAsDataURL(file);
  };

  useEffect(() => {
    const handleBeforeUnload = () => {
      navigator.sendBeacon?.('/window_closed', '');
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  useEffect(() => {
    return () => {
      if (hoverRafRef.current) cancelAnimationFrame(hoverRafRef.current);
      cleanupAllAnimations();
    };
  }, []);

  if (loading) {
    return (
      <div style={containerStyle}>
        <div style={loaderStyle}>Loading…</div>
      </div>
    );
  }

  const hasImagePreview = inputs.some((item) => item.preview?.type === 'image');
  const showHistory = history.length > 0;

  return (
    <div style={containerStyle}>
      <div style={bannerStyle}>{nodeTitle}</div>

      {/* Preview area - between header and selection groups */}
      <div style={previewAreaStyle}>
        {hovered && (
          <div style={previewInnerStyle}>
            {hovered.type === 'image' || hovered.type === 'mask' ? (
              <img src={hovered.data} alt={hovered.name} style={previewImgStyle} data-preview-img />
            ) : hovered.type === 'int' ? (
              <div style={previewIntStyle}>{hovered.data}</div>
            ) : hovered.type === 'text' ? (
              <div style={previewTextStyle}>{hovered.data}</div>
            ) : hovered.type === 'connection' ? (
              <div style={previewConnStyle}>
                <span style={{ fontSize: '48px' }}>🔌</span>
                <span>{hovered.data}</span>
              </div>
            ) : (
              <pre style={previewPreStyle}>{hovered.data}</pre>
            )}
          </div>
        )}
      </div>

      <input
        type="file"
        accept="image/*"
        ref={fileInputRef}
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      <div style={scrollContainerStyle} data-scroll-container>
        {inputs.length === 0 && history.length === 0 && (
          <div style={emptyStyle}>No connected inputs found.</div>
        )}

        {/* 1. Custom group */}
        {hasImagePreview && (
          <div style={groupStyle}>
            <div style={groupLabelStyle}>Custom</div>
            <div style={groupInnerStyle}>
              <div
                data-card-item
                style={{ flexShrink: 0, width: '280px' }}
                onMouseEnter={() => {
                  if (previewLockedRef.current) return;
                  setHovered({ type: 'custom', data: '', name: 'Custom Image' });
                }}
                onMouseLeave={() => {
                  if (previewLockedRef.current) return;
                  setHovered(null);
                  if (hoverRafRef.current) {
                    cancelAnimationFrame(hoverRafRef.current);
                    hoverRafRef.current = null;
                  }
                  stopHoverSuck();
                }}
              >
                <CustomImageCard
                  selected={selected === '__custom__'}
                  onClick={handleCustomClick}
                  onDropFile={handleDropFile}
                />
              </div>
            </div>
          </div>
        )}

        {/* 2. Options group */}
        {inputs.length > 0 && (
          <div style={groupStyle}>
            <div style={groupLabelStyle}>Options</div>
            <div style={groupInnerStyle}>
              {inputs.map((item) => {
                const common = {
                  name: item.nodeName || item.key,
                  selected: selected === item.key,
                  onClick: () => {},
                };

                const type = item.preview?.type;
                const data = item.preview?.data || '';
                const hoverType = type || (item.nodeName !== undefined ? 'connection' : 'json');
                const hoverData = data || item.nodeName || '';
                const isImage = type === 'image' || type === 'mask';

                const card = (() => {
                  if (type === 'image') {
                    return <ImageSwitchCard key={item.key} {...common} src={data} />;
                  }
                  if (type === 'mask') {
                    return <MaskSwitchCard key={item.key} {...common} src={data} />;
                  }
                  if (type === 'int') {
                    return <IntSwitchCard key={item.key} {...common} value={data} />;
                  }
                  if (type === 'text') {
                    return <StringSwitchCard key={item.key} {...common} value={data} />;
                  }
                  if (item.nodeName !== undefined) {
                    return (
                      <ConnectionSwitchCard
                        key={item.key}
                        {...common}
                        nodeName={item.nodeName}
                      />
                    );
                  }
                  return <JsonSwitchCard key={item.key} {...common} value={data} />;
                })();

                return (
                  <div
                    data-card-item
                    key={item.key}
                    style={{ flexShrink: 0, width: '280px' }}
                    onMouseEnter={(e) => {
                      if (previewLockedRef.current) return;
                      const info = { type: hoverType, data: hoverData, name: common.name };
                      if (isImage) {
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        hoverRafRef.current = requestAnimationFrame(() => {
                          startHoverSuck(data, rect, () => setHovered(info));
                        });
                      } else {
                        setHovered(info);
                      }
                    }}
                    onMouseLeave={() => {
                      if (previewLockedRef.current) return;
                      setHovered(null);
                      if (hoverRafRef.current) {
                        cancelAnimationFrame(hoverRafRef.current);
                        hoverRafRef.current = null;
                      }
                      stopHoverSuck();
                    }}
                    onClick={() => handleCardClick(item.key, isImage ? data : undefined)}
                  >
                    {card}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 3. History group */}
        {showHistory && (
          <div style={historyGroupStyle}>
            <div style={historyLabelStyle}>History</div>
            <div style={historyInnerStyle}>
              {history.map((h) => (
                <div
                  data-card-item
                  key={h.key}
                  style={{ flexShrink: 0, width: '280px' }}
                  onMouseEnter={(e) => {
                    if (previewLockedRef.current) return;
                    const info = { type: 'image', data: h.src, name: h.name };
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    hoverRafRef.current = requestAnimationFrame(() => {
                      startHoverSuck(h.src, rect, () => setHovered(info));
                    });
                  }}
                  onMouseLeave={() => {
                    if (previewLockedRef.current) return;
                    setHovered(null);
                    if (hoverRafRef.current) {
                      cancelAnimationFrame(hoverRafRef.current);
                      hoverRafRef.current = null;
                    }
                    stopHoverSuck();
                  }}
                  onClick={() => handleCardClick('__custom__', h.src, h.src)}
                >
                  <ImageSwitchCard
                    name={h.name}
                    src={h.src}
                    selected={selected === h.key}
                    onClick={() => {}}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>


    </div>
  );
};

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  minHeight: '100vh',
  gap: '28px',
  background: 'linear-gradient(180deg, #0a0a0a 0%, #1a1a1a 75%, rgba(51, 51, 51, 1) 100%)',
  position: 'relative',
};

const bannerStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  zIndex: 100,
  padding: '18px 24px',
  fontSize: '18px',
  fontWeight: 600,
  color: '#fff',
  textAlign: 'center',
  letterSpacing: '0.5px',
  background: 'rgba(255, 255, 255, 0.06)',
  backdropFilter: 'blur(24px) saturate(180%)',
  WebkitBackdropFilter: 'blur(24px) saturate(180%)',
  borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
  boxShadow: '0 4px 30px rgba(0, 0, 0, 0.2)',
};

const scrollContainerStyle: React.CSSProperties = {
  position: 'relative',
  zIndex: 200,
  display: 'flex',
  flexDirection: 'row',
  flexWrap: 'nowrap',
  alignItems: 'flex-end',
  gap: '20px',
  width: '100%',
  maxWidth: '100vw',
  padding: '0 20px',
  scrollBehavior: 'smooth',
  marginTop: 'auto',
};

const groupStyle: React.CSSProperties = {
  position: 'relative',
  zIndex: 200,
  display: 'flex',
  flexDirection: 'row',
  flexWrap: 'nowrap',
  alignItems: 'flex-end',
  gap: '16px',
  flexShrink: 0,
  padding: '16px 20px',
  background: 'rgba(255, 255, 255, 0.04)',
  backdropFilter: 'blur(16px) saturate(140%)',
  WebkitBackdropFilter: 'blur(16px) saturate(140%)',
  border: '1px solid rgba(255, 255, 255, 0.1)',
  borderRadius: '24px',
};

const groupLabelStyle: React.CSSProperties = {
  position: 'absolute',
  top: '-10px',
  left: '18px',
  fontSize: '11px',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '1px',
  color: '#8e8e93',
  zIndex: 200,
  background: 'rgba(20, 20, 30, 0.85)',
  padding: '2px 10px',
  borderRadius: '6px',
  border: '1px solid rgba(255,255,255,0.08)',
};

const groupInnerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'row',
  flexWrap: 'nowrap',
  alignItems: 'flex-end',
  gap: '16px',
};

const historyGroupStyle: React.CSSProperties = groupStyle;

const historyLabelStyle: React.CSSProperties = groupLabelStyle;

const historyInnerStyle: React.CSSProperties = groupInnerStyle;

const previewAreaStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  minHeight: 0,
};

const previewInnerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  animation: 'fadeIn 0.2s ease forwards',
  position: 'relative',
  zIndex: 95,
};

const previewImgStyle: React.CSSProperties = {
  maxWidth: '90vw',
  maxHeight: '60vh',
  borderRadius: '16px',
  objectFit: 'contain',
  boxShadow: '0 16px 50px rgba(0,0,0,0.6)',
};

const previewIntStyle: React.CSSProperties = {
  fontSize: '80px',
  fontWeight: 800,
  color: '#ff9f0a',
  textShadow: '0 4px 30px rgba(255, 159, 10, 0.4)',
};

const previewTextStyle: React.CSSProperties = {
  fontSize: '24px',
  fontWeight: 500,
  color: '#f5f5f5',
  textAlign: 'center',
  lineHeight: 1.6,
  wordBreak: 'break-word',
  textShadow: '0 2px 12px rgba(0,0,0,0.5)',
  maxWidth: '80vw',
};

const previewConnStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '12px',
  fontSize: '26px',
  fontWeight: 700,
  color: '#fff',
  textShadow: '0 2px 12px rgba(0,0,0,0.5)',
};

const previewPreStyle: React.CSSProperties = {
  margin: 0,
  fontSize: '17px',
  color: '#d1d1d6',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  lineHeight: 1.6,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  textShadow: '0 2px 10px rgba(0,0,0,0.5)',
  maxWidth: '80vw',
  maxHeight: '45vh',
  overflow: 'auto',
};

const emptyStyle: React.CSSProperties = {
  textAlign: 'center',
  color: '#888',
  padding: '40px 0',
  fontSize: '16px',
  flexShrink: 0,
};

const loaderStyle: React.CSSProperties = {
  color: '#fff',
  fontSize: '18px',
  fontWeight: 500,
  letterSpacing: '1px',
};

export default App;
