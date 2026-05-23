import React from 'react';

interface EditPhaseProps {
  maskUrl: string;
  promptUrl: string;
  loopCount: number;
  maskConfirmed: boolean;
  promptReady: boolean;
  onRunDetail: () => void;
  onFinish: () => void;
}

const EditPhase: React.FC<EditPhaseProps> = ({
  maskUrl,
  promptUrl,
  loopCount,
  maskConfirmed,
  promptReady,
  onRunDetail,
  onFinish,
}) => {
  const allReady = maskConfirmed && promptReady;

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={styles.title}>Detailer Sampler</span>
          <span style={styles.badge}>Loop #{loopCount + 1}</span>
        </div>
        <span style={styles.hint}>Draw mask → Confirm · Select prompt → Run</span>
      </div>

      {/* Split panel */}
      <div style={styles.splitPanel}>
        <div style={getPanelStyle(maskConfirmed)}>
          <div style={styles.panelLabel}>
            <StatusDot active={maskConfirmed} />
            Mask Editor
          </div>
          <iframe
            src={maskUrl}
            style={styles.iframe}
            title="Mask Editor"
            allow="clipboard-write"
          />
        </div>
        <div style={getPanelStyle(promptReady)}>
          <div style={styles.panelLabel}>
            <StatusDot active={promptReady} />
            Prompt Selector
          </div>
          <iframe
            src={promptUrl}
            style={styles.iframe}
            title="Prompt Selector"
            allow="clipboard-write"
          />
        </div>
      </div>

      {/* Bottom status + actions */}
      <div style={styles.bottomBar}>
        <div style={styles.statusRow}>
          <StatusItem label="Mask" active={maskConfirmed} />
          <StatusItem label="Prompt" active={promptReady} />
        </div>
        <div style={styles.actionRow}>
          <button
            style={{
              ...styles.primaryBtn,
              opacity: allReady ? 1 : 0.45,
              cursor: allReady ? 'pointer' : 'not-allowed',
            }}
            onClick={onRunDetail}
            disabled={!allReady}
          >
            Run Detail
          </button>
          <button style={styles.secondaryBtn} onClick={onFinish}>
            Finish
          </button>
        </div>
      </div>
    </div>
  );
};

function getPanelStyle(active: boolean): React.CSSProperties {
  const color = active ? '#007aff' : '#ff9f0a';
  return {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    background: '#0d0d0d',
    position: 'relative',
    borderRadius: 14,
    overflow: 'hidden',
    border: `2px solid ${color}`,
    boxShadow: active
      ? `0 0 0 1px ${color}33, 0 0 20px ${color}22`
      : `0 0 0 1px ${color}33, 0 0 20px ${color}22`,
    transition: 'border-color 0.4s ease, box-shadow 0.4s ease',
    margin: '0 4px',
  };
}

const StatusDot: React.FC<{ active: boolean }> = ({ active }) => (
  <span
    style={{
      width: 8,
      height: 8,
      borderRadius: '50%',
      display: 'inline-block',
      marginRight: 6,
      background: active ? '#30d158' : '#ff9f0a',
      boxShadow: active
        ? '0 0 6px rgba(48, 209, 88, 0.5)'
        : '0 0 6px rgba(255, 159, 10, 0.5)',
      transition: 'all 0.3s ease',
    }}
  />
);

const StatusItem: React.FC<{ label: string; active: boolean }> = ({ label, active }) => (
  <div style={styles.statusItem}>
    <StatusDot active={active} />
    <span style={{ color: active ? '#30d158' : 'rgba(255,255,255,0.5)', transition: 'color 0.3s' }}>
      {label} {active ? 'Ready' : 'Pending'}
    </span>
  </div>
);

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: '#0d0d0d',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif",
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 24px',
    background: 'rgba(28, 28, 30, 0.6)',
    backdropFilter: 'blur(20px) saturate(180%)',
    WebkitBackdropFilter: 'blur(20px) saturate(180%)',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
    flexShrink: 0,
    zIndex: 10,
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  title: {
    fontSize: 15,
    fontWeight: 700,
    color: '#fff',
    letterSpacing: '0.2px',
  },
  badge: {
    fontSize: 11,
    fontWeight: 600,
    color: 'rgba(255,255,255,0.6)',
    background: 'rgba(255,255,255,0.08)',
    padding: '3px 10px',
    borderRadius: 10,
    letterSpacing: '0.3px',
  },
  hint: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.4)',
    fontWeight: 500,
  },
  splitPanel: {
    display: 'flex',
    flex: 1,
    minHeight: 0,
    gap: 4,
    padding: '0 4px',
  },
  panelLabel: {
    position: 'absolute',
    top: 12,
    left: 12,
    zIndex: 5,
    display: 'flex',
    alignItems: 'center',
    fontSize: 12,
    fontWeight: 600,
    color: 'rgba(255,255,255,0.7)',
    background: 'rgba(28, 28, 30, 0.55)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    padding: '6px 14px',
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.06)',
    letterSpacing: '0.2px',
  },
  iframe: {
    width: '100%',
    height: '100%',
    border: 'none',
    background: '#0d0d0d',
  },
  bottomBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 24px',
    background: 'rgba(28, 28, 30, 0.6)',
    backdropFilter: 'blur(20px) saturate(180%)',
    WebkitBackdropFilter: 'blur(20px) saturate(180%)',
    borderTop: '1px solid rgba(255,255,255,0.06)',
    flexShrink: 0,
    zIndex: 10,
  },
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 20,
  },
  statusItem: {
    display: 'flex',
    alignItems: 'center',
    fontSize: 13,
    fontWeight: 600,
  },
  actionRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  primaryBtn: {
    padding: '9px 24px',
    fontSize: 14,
    fontWeight: 700,
    color: '#fff',
    background: 'rgba(0, 122, 255, 0.85)',
    border: 'none',
    borderRadius: 10,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    letterSpacing: '0.3px',
    boxShadow: '0 2px 8px rgba(0, 122, 255, 0.25)',
  },
  secondaryBtn: {
    padding: '9px 24px',
    fontSize: 14,
    fontWeight: 700,
    color: '#fff',
    background: 'rgba(255,255,255,0.1)',
    border: 'none',
    borderRadius: 10,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    letterSpacing: '0.3px',
  },
};

export default EditPhase;
