import React, { useEffect, useRef, useState } from 'react';
import IntSwitchCard from './components/IntSwitchCard';
import StringSwitchCard from './components/StringSwitchCard';
import ImageSwitchCard from './components/ImageSwitchCard';
import MaskSwitchCard from './components/MaskSwitchCard';
import JsonSwitchCard from './components/JsonSwitchCard';
import ConnectionSwitchCard from './components/ConnectionSwitchCard';
import CustomImageCard from './components/CustomImageCard';

interface PreviewItem {
  type: string;
  data: string;
}

interface InputItem {
  key: string;
  preview?: PreviewItem;
  nodeName?: string;
}

const App: React.FC = () => {
  const [inputs, setInputs] = useState<InputItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/inputs_data')
      .then((res) => res.json())
      .then((data) => {
        const keys: string[] = data.input_keys || [];
        const previews: Record<string, PreviewItem> = data.input_previews || {};
        const connections: Record<string, string> = data.connection_info || {};
        const items = keys.map((k) => ({
          key: k,
          preview: previews[k],
          nodeName: connections[k],
        }));
        setInputs(items);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSelect = (key: string, customImage?: string) => {
    setSelected(key);
    fetch('/select_input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selected_key: key, custom_image: customImage }),
    }).then(() => {
      window.close();
    });
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
      handleSelect('__custom__', base64);
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

  if (loading) {
    return (
      <div style={containerStyle}>
        <div style={titleStyle}>Loading...</div>
      </div>
    );
  }

  const hasImagePreview = inputs.some((item) => item.preview?.type === 'image');

  return (
    <div style={containerStyle}>
      <input
        type="file"
        accept="image/*"
        ref={fileInputRef}
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
      <div style={titleStyle}>Select an input</div>
      <div style={gridStyle}>
        {inputs.length === 0 && (
          <div style={emptyStyle}>No connected inputs found.</div>
        )}
        {inputs.map((item) => {
          const common = {
            name: item.key,
            selected: selected === item.key,
            onClick: () => handleSelect(item.key),
          };

          const type = item.preview?.type;
          const data = item.preview?.data || '';

          // Non-lazy mode: show actual preview content if available
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

          // Lazy mode fallback: show connection card if nodeName is available
          if (item.nodeName !== undefined) {
            return (
              <ConnectionSwitchCard
                key={item.key}
                {...common}
                nodeName={item.nodeName}
              />
            );
          }

          // json / unknown fallback
          return <JsonSwitchCard key={item.key} {...common} value={data} />;
        })}
        {hasImagePreview && (
          <CustomImageCard
            selected={selected === '__custom__'}
            onClick={handleCustomClick}
          />
        )}
      </div>
      {selected && (
        <div style={successStyle}>Selected {selected}. You can close this window.</div>
      )}
    </div>
  );
};

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'flex-start',
  minHeight: '100vh',
  padding: '40px 20px',
  gap: '24px',
  background: '#1a1a1a',
};

const titleStyle: React.CSSProperties = {
  fontSize: '22px',
  fontWeight: 600,
  color: '#f5f5f5',
};

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
  gap: '16px',
  width: '100%',
  maxWidth: '960px',
};

const emptyStyle: React.CSSProperties = {
  gridColumn: '1 / -1',
  textAlign: 'center',
  color: '#888',
  padding: '40px 0',
};

const successStyle: React.CSSProperties = {
  color: '#34c759',
  fontSize: '14px',
};

export default App;
