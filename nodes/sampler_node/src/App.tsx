import React, { useEffect, useState, useCallback, useRef } from 'react';
import EditPhase from './components/EditPhase';
import type { Tab, ServerConfig, StatusResponse, DetailerParams, TagPreviews, DebugRecoverData, HistoryItem } from './types';

const POLL_INTERVAL = 500;
const PROMPT_POLL_INTERVAL = 1500;

const App: React.FC = () => {
  const [tab, setTab] = useState<Tab>('mask');
  const tabRef = useRef<Tab>('mask');
  useEffect(() => { tabRef.current = tab; }, [tab]);

  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [maskConfirmed, setMaskConfirmed] = useState(false);
  const [promptReady, setPromptReady] = useState(false);
  const [autoTagging, setAutoTagging] = useState(false);
  const [tagPreviews, setTagPreviews] = useState<TagPreviews | null>(null);
  const [tagResult, setTagResult] = useState<string | null>(null);
  const [debugData, setDebugData] = useState<DebugRecoverData | null>(null);
  const [detailStatus, setDetailStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [detailProgress, setDetailProgress] = useState({ progress: 0, current: 0, total: 0 });
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [showFinishDialog, setShowFinishDialog] = useState(false);
  const promptIframeRef = useRef<HTMLIFrameElement>(null);
  const maskIframeRef = useRef<HTMLIFrameElement>(null);

  const [params, setParams] = useState<DetailerParams>({
    add_noise: 'enable',
    start_step_rate: 0.8,
    end_step_rate: 1.0,
    pixels: 1048576,
    crop_reserve: 32,
  });

  // Fetch config on mount
  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then((data: ServerConfig) => {
        setConfig(data);
        setParams({
          add_noise: data.add_noise,
          start_step_rate: data.start_step_rate,
          end_step_rate: data.end_step_rate,
          pixels: data.pixels,
          crop_reserve: data.crop_reserve,
        });
        setDetailStatus(data.detail_status);
      })
      .catch(e => setError('Failed to load config: ' + e.message));
  }, []);

  // Fetch history on mount and when entering context tab
  const refreshHistory = useCallback(() => {
    fetch('/api/history')
      .then(r => r.json())
      .then(data => {
        if (data.history) setHistory(data.history);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { refreshHistory(); }, [refreshHistory]);

  // Load tag previews when entering tag tab
  useEffect(() => {
    if (tab !== 'tag') return;
    fetch('/api/tag_previews')
      .then(r => r.json())
      .then((data: TagPreviews) => {
        if (data.full || data.mask || data.covered) {
          setTagPreviews(data);
        }
      })
      .catch(e => setError('Failed to load tag previews: ' + e.message));
  }, [tab]);

  // Listen for postMessage from mask/prompt iframes
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'mask-confirmed') {
        setMaskConfirmed(true);
        setError(null);
        // Auto-advance: mask → tag (if tagger) or prompt
        if (tabRef.current === 'mask') {
          setTab(config?.has_tagger ? 'tag' : 'prompt');
        }
      } else if (event.data?.type === 'prompt-confirmed') {
        setPromptReady(true);
        setError(null);
        // Auto-advance to Draw tab when prompt is confirmed
        setTab('draw');
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [config]);

  // Poll mask status (fallback)
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/has_mask');
        const data = await res.json();
        if (!cancelled && data.has_mask) {
          setMaskConfirmed(true);
        }
      } catch { /* ignore */ }
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Poll prompt status (fallback)
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/has_prompt');
        const data = await res.json();
        if (!cancelled) setPromptReady(!!data.has_prompt);
      } catch { /* ignore */ }
    };
    poll();
    const interval = setInterval(poll, PROMPT_POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Poll status when in draw tab (running)
  useEffect(() => {
    if (tab !== 'draw' || detailStatus !== 'running') return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/status');
        const data: StatusResponse = await res.json();
        if (cancelled) return;
        setDetailStatus(data.detail_status);
        setDetailProgress({
          progress: data.progress || 0,
          current: data.current_step || 0,
          total: data.total_steps || 0,
        });
        if (data.detail_status === 'done') {
          refreshHistory();
        } else if (data.detail_status === 'error') {
          setError(data.error || 'Detailer failed');
        }
      } catch { /* ignore */ }
    };
    const interval = setInterval(poll, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(interval); };
  }, [tab, detailStatus, refreshHistory]);

  // Fetch debug data when detail is done
  useEffect(() => {
    if (detailStatus !== 'done') return;
    fetch('/api/debug_recover_data')
      .then(r => r.json())
      .then(data => {
        if (!data.error) setDebugData(data);
      })
      .catch(() => {});
  }, [detailStatus]);

  // Fetch result images when detail is done
  const [resultImages, setResultImages] = useState<{original: string; detailed: string} | null>(null);
  useEffect(() => {
    if (detailStatus !== 'done') return;
    fetch('/api/result')
      .then(r => r.json())
      .then(data => {
        if (data.original_image && data.detailed_image) {
          setResultImages({ original: data.original_image, detailed: data.detailed_image });
        }
      })
      .catch(() => {});
    // Tell mask iframe to reload the new image
    setTimeout(() => {
      const iframe = maskIframeRef.current;
      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage({ type: 'reload-image' }, '*');
      }
    }, 200);
  }, [detailStatus]);

  const handleRunTag = useCallback(async (mode: 'mask' | 'covered' | 'full') => {
    setError(null);
    setAutoTagging(true);
    try {
      const res = await fetch('/api/run_tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Tag failed');
        setAutoTagging(false);
        return;
      }
      setTagResult(data.tag);
      // Switch to prompt tab first so iframe is visible, then send tags
      setTab('prompt');
      // Small delay to ensure tab switch + iframe render before postMessage
      setTimeout(() => {
        const iframe = promptIframeRef.current;
        if (iframe?.contentWindow) {
          iframe.contentWindow.postMessage({
            type: 'auto-tag',
            tag: data.tag,
            tags: data.tags || [],
            custom: data.custom || '',
          }, '*');
        }
      }, 100);
    } catch (e: any) {
      setError('Tag error: ' + e.message);
    } finally {
      setAutoTagging(false);
    }
  }, []);

  const handleRunDetailer = useCallback(async () => {
    setError(null);
    setDetailStatus('running');
    setDetailProgress({ progress: 0, current: 0, total: 0 });
    setDebugData(null);
    setResultImages(null);
    try {
      await fetch('/api/run_detailer', { method: 'POST' });
    } catch (e: any) {
      setError('Failed to start detailer: ' + e.message);
      setDetailStatus('idle');
    }
  }, []);

  const handleSelectImage = useCallback(async (key: string) => {
    try {
      await fetch('/api/select_image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      // Reset state for next iteration
      setMaskConfirmed(false);
      setPromptReady(false);
      setTagResult(null);
      setDetailStatus('idle');
      setResultImages(null);
      setDebugData(null);
      setTab('mask');
      // Tell mask iframe to reload its image
      setTimeout(() => {
        const iframe = maskIframeRef.current;
        if (iframe?.contentWindow) {
          iframe.contentWindow.postMessage({ type: 'reload-image' }, '*');
        }
      }, 100);
    } catch (e: any) {
      setError('Failed to select image: ' + e.message);
    }
  }, []);

  const handleParamChange = useCallback((next: DetailerParams) => {
    setParams(next);
    fetch('/api/update_config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    }).catch(() => {});
  }, []);

  const handleFinishClick = useCallback(() => {
    setShowFinishDialog(true);
  }, []);

  const handleFinish = useCallback(async (selectedKey?: string) => {
    try {
      await fetch('/api/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected_key: selectedKey }),
      });
      window.close();
    } catch {
      window.close();
    }
  }, []);

  if (!config) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#888' }}>
        {error || 'Loading...'}
      </div>
    );
  }

  return (
    <div>
      <EditPhase
        tab={tab}
        onTabChange={setTab}
        maskUrl={config.mask_url}
        promptUrl={config.prompt_url}
        maskConfirmed={maskConfirmed}
        promptReady={promptReady}
        autoTagging={autoTagging}
        tagPreviews={tagPreviews}
        tagResult={tagResult}
        debugData={debugData}
        detailStatus={detailStatus}
        detailProgress={detailProgress}
        resultImages={resultImages}
        history={history}
        onRefreshHistory={refreshHistory}
        promptIframeRef={promptIframeRef}
        maskIframeRef={maskIframeRef}
        params={params}
        onParamChange={handleParamChange}
        onRunTag={handleRunTag}
        onRunDetailer={handleRunDetailer}
        onSelectImage={handleSelectImage}
        onFinishClick={handleFinishClick}
        showFinishDialog={showFinishDialog}
        onFinish={handleFinish}
        onCloseFinishDialog={() => setShowFinishDialog(false)}
      />

      {error && (
        <div style={{
          position: 'fixed',
          top: 12,
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(255, 69, 58, 0.85)',
          color: '#fff',
          padding: '8px 24px',
          borderRadius: 10,
          fontSize: 13,
          fontWeight: 600,
          zIndex: 9999,
          backdropFilter: 'blur(12px)',
          letterSpacing: '0.2px',
          boxShadow: '0 4px 16px rgba(255, 69, 58, 0.25)',
        }}>
          {error}
        </div>
      )}
    </div>
  );
};

export default App;
