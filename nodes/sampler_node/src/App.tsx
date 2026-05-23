import React, { useEffect, useState, useCallback } from 'react';
import EditPhase from './components/EditPhase';
import SelectPhase from './components/SelectPhase';
import LoadingOverlay from './components/LoadingOverlay';
import type { Phase, ServerConfig, StatusResponse, ResultResponse } from './types';

const POLL_INTERVAL = 500;
const PROMPT_POLL_INTERVAL = 1500;

const App: React.FC = () => {
  const [phase, setPhase] = useState<Phase>('edit');
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [maskConfirmed, setMaskConfirmed] = useState<boolean>(false);
  const [promptReady, setPromptReady] = useState<boolean>(false);
  const [originalImage, setOriginalImage] = useState<string>('');
  const [detailedImage, setDetailedImage] = useState<string>('');

  // Fetch config on mount
  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then((data: ServerConfig) => setConfig(data))
      .catch(e => setError('Failed to load config: ' + e.message));
  }, []);

  // Listen for postMessage from mask iframe
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'mask-confirmed') {
        setMaskConfirmed(true);
        setError(null);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Poll prompt status periodically
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
        // ignore poll errors
      }
    };
    poll(); // initial
    const interval = setInterval(poll, PROMPT_POLL_INTERVAL);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Poll status when in loading phase
  useEffect(() => {
    if (phase !== 'loading') return;

    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/status');
        const data: StatusResponse = await res.json();
        if (cancelled) return;

        if (data.detail_status === 'done') {
          const r2 = await fetch('/api/result');
          const result: ResultResponse = await r2.json();
          if (cancelled) return;
          setOriginalImage(result.original_image);
          setDetailedImage(result.detailed_image);
          setPhase('select');
        } else if (data.detail_status === 'error') {
          setError(data.error || 'Detailer failed');
          setPhase('edit');
        }
        // else keep polling
      } catch (e: any) {
        if (!cancelled) {
          setError('Polling error: ' + e.message);
          setPhase('edit');
        }
      }
    };

    const interval = setInterval(poll, POLL_INTERVAL);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [phase]);

  const handleRunDetail = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/run_detail', { method: 'POST' });
      const data = await res.json();
      if (!data.started) {
        setError(data.error || 'Failed to start detailer');
        return;
      }
      setPhase('loading');
    } catch (e: any) {
      setError('Run detail error: ' + e.message);
    }
  }, []);

  const handleNextLoop = useCallback(async (useDetailed: boolean) => {
    try {
      await fetch('/api/next_loop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ use_detailed: useDetailed }),
      });
      window.location.reload();
    } catch (e: any) {
      setError('Next loop error: ' + e.message);
    }
  }, []);

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
      {phase === 'edit' && (
        <EditPhase
          maskUrl={config.mask_url}
          promptUrl={config.prompt_url}
          loopCount={config.loop_count}
          maskConfirmed={maskConfirmed}
          promptReady={promptReady}
          onRunDetail={handleRunDetail}
          onFinish={handleFinish}
        />
      )}
      {phase === 'loading' && <LoadingOverlay />}
      {phase === 'select' && (
        <SelectPhase
          originalImage={originalImage}
          detailedImage={detailedImage}
          onNextLoopOriginal={() => handleNextLoop(false)}
          onNextLoopDetailed={() => handleNextLoop(true)}
          onFinish={handleFinish}
        />
      )}
      {error && phase === 'edit' && (
        <div style={{
          position: 'fixed', bottom: 60, left: '50%', transform: 'translateX(-50%)',
          background: '#c0392b', color: '#fff', padding: '8px 16px', borderRadius: 4, fontSize: 13, zIndex: 100
        }}>
          {error}
        </div>
      )}
    </div>
  );
};

export default App;
