import React, { useEffect, useState, useCallback, useRef } from 'react';
import EditPhase from './components/EditPhase';
import type { Phase, ServerConfig, StatusResponse, DetailerParams, TagPreviews } from './types';

const POLL_INTERVAL = 500;
const PROMPT_POLL_INTERVAL = 1500;

const App: React.FC = () => {
  const [phase, setPhase] = useState<Phase>('mask');
  const phaseRef = useRef<Phase>('mask');
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [maskConfirmed, setMaskConfirmed] = useState<boolean>(false);
  const [promptReady, setPromptReady] = useState<boolean>(false);
  const [autoTagging, setAutoTagging] = useState(false);
  const [autoTagResult, setAutoTagResult] = useState<string | null>(null);
  const [tagPreviews, setTagPreviews] = useState<TagPreviews | null>(null);
  const [tagResult, setTagResult] = useState<string | null>(null);
  const promptIframeRef = useRef<HTMLIFrameElement>(null);

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
      })
      .catch(e => setError('Failed to load config: ' + e.message));
  }, []);

  // Load tag previews when entering tag phase
  useEffect(() => {
    if (phase !== 'tag') return;
    fetch('/api/tag_previews')
      .then(r => r.json())
      .then((data: TagPreviews) => {
        if (data.full || data.mask || data.covered) {
          setTagPreviews(data);
        }
      })
      .catch(e => setError('Failed to load tag previews: ' + e.message));
  }, [phase]);

  // Listen for postMessage from mask/prompt iframes
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'mask-confirmed') {
        setMaskConfirmed(true);
        setError(null);
      } else if (event.data?.type === 'prompt-confirmed') {
        setPromptReady(true);
        setError(null);
        if (phaseRef.current === 'prompt') {
          handleRunDetailRef.current();
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Auto-advance from mask → tag/prompt when mask is confirmed
  useEffect(() => {
    if (phase === 'mask' && maskConfirmed && config) {
      if (config.has_tagger) {
        setPhase('tag');
      } else {
        setPhase('prompt');
      }
    }
  }, [phase, maskConfirmed, config]);

  // Poll prompt status periodically (fallback)
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/has_prompt');
        const data = await res.json();
        if (!cancelled) {
          setPromptReady(!!data.has_prompt);
        }
      } catch {
        // ignore
      }
    };
    poll();
    const interval = setInterval(poll, PROMPT_POLL_INTERVAL);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Poll status when in waiting phase
  useEffect(() => {
    if (phase !== 'waiting') return;

    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/status');
        const data: StatusResponse = await res.json();
        if (cancelled) return;

        if (data.detail_status === 'done') {
          const configRes = await fetch('/api/config');
          const newConfig: ServerConfig = await configRes.json();
          if (!cancelled) {
            setConfig(newConfig);
            setPhase('switch');
          }
        } else if (data.detail_status === 'error') {
          setError(data.error || 'Detailer failed');
          setPhase('prompt');
        }
      } catch (e: any) {
        if (!cancelled) {
          setError('Polling error: ' + e.message);
          setPhase('prompt');
        }
      }
    };

    const interval = setInterval(poll, POLL_INTERVAL);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [phase]);

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
      setAutoTagResult(data.tag);
      // Send tag to prompt iframe
      const iframe = promptIframeRef.current;
      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage({ type: 'auto-tag', tag: data.tag }, '*');
      }
      setPhase('prompt');
    } catch (e: any) {
      setError('Tag error: ' + e.message);
    } finally {
      setAutoTagging(false);
    }
  }, []);

  const handleAutoTag = useCallback(async () => {
    setError(null);
    setAutoTagging(true);
    try {
      const res = await fetch('/api/auto_tag', { method: 'POST' });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Auto tag failed');
        setAutoTagging(false);
        return;
      }
      setAutoTagResult(data.tag);
      const iframe = promptIframeRef.current;
      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage({ type: 'auto-tag', tag: data.tag }, '*');
      }
    } catch (e: any) {
      setError('Auto tag error: ' + e.message);
    } finally {
      setAutoTagging(false);
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

  const handleRunDetail = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/run_detail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = await res.json();
      if (!data.started) {
        setError(data.error || 'Failed to start detailer');
        return;
      }
      setPhase('waiting');
    } catch (e: any) {
      setError('Run detail error: ' + e.message);
    }
  }, [params]);

  const handleRunDetailRef = useRef(handleRunDetail);
  useEffect(() => { handleRunDetailRef.current = handleRunDetail; }, [handleRunDetail]);

  // Poll switch status when in switch phase
  useEffect(() => {
    if (phase !== 'switch') return;

    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/switch_status');
        const data = await res.json();
        if (cancelled) return;

        if (data.selected) {
          await fetch('/api/next_loop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          window.location.reload();
        } else if (data.window_closed) {
          await fetch('/api/finish', { method: 'POST' });
          window.close();
        }
      } catch (e: any) {
        if (!cancelled) {
          setError('Switch poll error: ' + e.message);
        }
      }
    };

    const interval = setInterval(poll, POLL_INTERVAL);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [phase]);

  const handleFinish = useCallback(async () => {
    try {
      await fetch('/api/finish', { method: 'POST' });
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
        phase={phase}
        maskUrl={config.mask_url}
        promptUrl={config.prompt_url}
        switchUrl={config.switch_url}
        loopCount={config.loop_count}
        maskConfirmed={maskConfirmed}
        promptReady={promptReady}
        autoTagging={autoTagging}
        autoTagResult={autoTagResult}
        tagPreviews={tagPreviews}
        tagResult={tagResult}
        promptIframeRef={promptIframeRef}
        params={params}
        onParamChange={handleParamChange}
        onAutoTag={handleAutoTag}
        onRunTag={handleRunTag}
        onFinish={handleFinish}
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
