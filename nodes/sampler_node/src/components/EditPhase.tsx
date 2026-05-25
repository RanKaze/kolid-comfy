import React from 'react';
import { DebugImage, DebugMask, DebugString } from '@kolid/ui-utils';
import AdvancedSettings from './AdvancedSettings';
import type { DetailerParams, Phase, TagPreviews, DebugRecoverData } from '../types';

interface EditPhaseProps {
  phase: Phase;
  maskUrl: string;
  promptUrl: string;
  switchUrl: string;
  loopCount: number;
  maskConfirmed: boolean;
  promptReady: boolean;
  autoTagging: boolean;
  autoTagResult: string | null;
  tagPreviews: TagPreviews | null;
  tagResult: string | null;
  debugData: DebugRecoverData | null;
  promptIframeRef: React.RefObject<HTMLIFrameElement>;
  params: DetailerParams;
  onParamChange: (params: DetailerParams) => void;
  onRunTag: (mode: 'mask' | 'covered' | 'full') => void;
  onFinish: () => void;
}

const EditPhase: React.FC<EditPhaseProps> = ({
  phase,
  maskUrl,
  promptUrl,
  switchUrl,
  loopCount,
  maskConfirmed,
  promptReady,
  autoTagging,
  autoTagResult,
  tagPreviews,
  tagResult,
  debugData,
  promptIframeRef,
  params,
  onParamChange,
  onRunTag,
  onFinish,
}) => {
  const maskIframeRef = React.useRef<HTMLIFrameElement>(null);
  const isMaskPhase = phase === 'mask';
  const isTagPhase = phase === 'tag';
  const isPromptPhase = phase === 'prompt';
  const isWaiting = phase === 'waiting';
  const isSwitchPhase = phase === 'switch';

  // Notify mask iframe when loop changes (no key remount, use single iframe)
  React.useEffect(() => {
    const iframe = maskIframeRef.current;
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'new-loop', loop: loopCount }, '*');
    }
  }, [loopCount]);

  const hasTagPanel = !!tagPreviews;

  const getPanelFlex = (type: 'mask' | 'prompt' | 'tag' | 'switch') => {
    if (isMaskPhase) {
      // Mask 阶段：mask 为主，prompt 为辅
      if (type === 'mask') return hasTagPanel ? 2.0 : 2.5;
      if (type === 'prompt') return hasTagPanel ? 0.6 : 0.8;
      if (type === 'tag') return hasTagPanel ? 0.4 : 0;
      return 0;
    }
    if (isTagPhase) {
      // Tag 阶段：三者均衡
      if (type === 'mask') return 0.8;
      if (type === 'tag') return 1.0;
      if (type === 'prompt') return 0.8;
      return 0;
    }
    if (isPromptPhase) {
      // Prompt 阶段：prompt 为主
      if (type === 'mask') return 0.4;
      if (type === 'prompt') return hasTagPanel ? 2.2 : 2.5;
      if (type === 'tag') return hasTagPanel ? 0.15 : 0;
      return 0;
    }
    if (isWaiting) {
      // Waiting 阶段：如果有 switch，switch 为主；否则和 prompt 阶段类似
      if (showSwitch) {
        if (type === 'switch') return 3.0;
        if (type === 'mask') return 0.3;
        if (type === 'prompt') return 0.4;
        if (type === 'tag') return hasTagPanel ? 0.1 : 0;
        return 0;
      }
      if (type === 'mask') return 0.4;
      if (type === 'prompt') return hasTagPanel ? 2.2 : 2.5;
      if (type === 'tag') return hasTagPanel ? 0.15 : 0;
      return 0;
    }
    if (isSwitchPhase) {
      // Switch 阶段：switch 为主，其余为辅
      if (type === 'switch') return 3.0;
      if (type === 'mask') return 0.2;
      if (type === 'prompt') return 0.2;
      if (type === 'tag') return hasTagPanel ? 0.08 : 0;
      return 0;
    }
    return 1;
  };

  const showSwitch = !!switchUrl && (isSwitchPhase || isWaiting);
  const showTag = hasTagPanel && !isMaskPhase;

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={styles.title}>Detailer Sampler</span>
          <span style={styles.badge}>Loop #{loopCount + 1}</span>
        </div>
        <div style={styles.phaseSteps}>
          <PhaseStep label="Mask" active={isMaskPhase} done={maskConfirmed} />
          <PhaseConnector done={maskConfirmed} />
          <PhaseStep label="Tag" active={isTagPhase} done={!!tagResult} />
          <PhaseConnector done={!!tagResult} />
          <PhaseStep label="Prompt" active={isPromptPhase} done={promptReady} />
          <PhaseConnector done={promptReady} />
          <PhaseStep label="Waiting" active={isWaiting} done={false} />
          <PhaseConnector done={false} />
          <PhaseStep label="Switch" active={isSwitchPhase} done={false} />
        </div>
      </div>

      {/* Panel layout */}
      <div style={{ ...styles.splitPanel, position: 'relative' }}>
        {/* Mask panel */}
        <div style={{ ...getPanelStyle(maskConfirmed), flex: getPanelFlex('mask') }}>
          <div style={styles.panelLabel}>
            <StatusDot active={maskConfirmed} />
            Mask Editor
          </div>
          <iframe
            ref={maskIframeRef}
            src={maskUrl}
            style={styles.iframe}
            title="Mask Editor"
            allow="clipboard-write"
          />
        </div>

        {/* Tag panel */}
        {showTag && (
          <div style={{ ...getPanelStyle(true), flex: getPanelFlex('tag'), borderColor: '#af52de' }}>
            <div style={styles.panelLabel}>
              <StatusDot active={!!tagResult} />
              Tag Mode
            </div>
            <div style={styles.tagPanelInner}>
              <TagCard
                label="Mask Tag"
                description="Cropped to mask"
                image={tagPreviews.mask}
                onClick={() => onRunTag('mask')}
                disabled={autoTagging}
              />
              <TagCard
                label="Covered Tag"
                description="Mask kept, outside white"
                image={tagPreviews.covered}
                onClick={() => onRunTag('covered')}
                disabled={autoTagging}
              />
              <TagCard
                label="Full Tag"
                description="Full image"
                image={tagPreviews.full}
                onClick={() => onRunTag('full')}
                disabled={autoTagging}
              />
            </div>
            {autoTagging && (
              <div style={styles.tagLoading}>
                <div style={styles.spinner} />
                <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: 600 }}>Running tagger…</span>
              </div>
            )}
            {tagResult && (
              <div style={styles.tagResultBar}>
                <span style={{ color: '#64d2ff', fontSize: 11, fontWeight: 600 }}>Tag:</span>
                <span style={{ color: 'rgba(255,255,255,0.8)', fontSize: 11, marginLeft: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tagResult}</span>
              </div>
            )}
          </div>
        )}

        {/* Prompt panel */}
        <div style={{ ...getPanelStyle(promptReady), flex: getPanelFlex('prompt') }}>
          <div style={styles.panelLabel}>
            <StatusDot active={promptReady} />
            Prompt Selector
          </div>
          <iframe
            key={`prompt-${loopCount}`}
            ref={promptIframeRef}
            src={promptUrl}
            style={styles.iframe}
            title="Prompt Selector"
            allow="clipboard-write"
          />
        </div>

        {/* Switch panel */}
        {showSwitch && (
          <div style={{ ...getPanelStyle(true), flex: getPanelFlex('switch'), borderColor: '#30d158' }}>
            <div style={styles.panelLabel}>
              <StatusDot active={true} />
              Result Switch
            </div>
            <iframe
              key={`switch-${loopCount}`}
              src={switchUrl}
              style={styles.iframe}
              title="Result Switch"
              allow="clipboard-write"
            />
          </div>
        )}

        {/* Debug panel */}
        {isSwitchPhase && debugData && (
          <div style={{ ...getPanelStyle(true), flex: 1, borderColor: '#ff453a', maxWidth: 360, overflowY: 'auto' }}>
            <div style={styles.panelLabel}>
              <StatusDot active={true} />
              Debug: recover_crop
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '44px 10px 10px' }}>
              <DebugImage src={debugData.background} label="Background" />
              <DebugImage src={debugData.image} label="Image (to paste)" />
              <DebugMask src={debugData.mask} label="Mask" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                <DebugString label="crop_x" value={debugData.crop_x} />
                <DebugString label="crop_y" value={debugData.crop_y} />
                <DebugString label="crop_w" value={debugData.crop_width} />
                <DebugString label="crop_h" value={debugData.crop_height} />
                <DebugString label="orig_w" value={debugData.original_width} />
                <DebugString label="orig_h" value={debugData.original_height} />
              </div>
            </div>
          </div>
        )}

        {/* Waiting overlay */}
        {isWaiting && !switchUrl && (
          <div style={styles.waitingOverlay}>
            <div style={styles.spinner} />
            <div style={styles.waitingTitle}>Running Detailer</div>
            <div style={styles.waitingSubtitle}>Please wait while the detailer processes your image…</div>
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div style={styles.bottomBar}>
        <div style={styles.statusRow}>
          {isMaskPhase && (
            <span style={styles.phaseHint}>
              Draw mask area and click <b style={{ color: '#30d158' }}>Confirm</b> in the mask editor
            </span>
          )}
          {isTagPhase && (
            <span style={styles.phaseHint}>
              Select how the tagger should see the image
            </span>
          )}
          {isPromptPhase && (
            <span style={styles.phaseHint}>
              Select prompt, then click <b style={{ color: '#0a84ff' }}>Confirm</b> in the prompt selector
            </span>
          )}
          {isWaiting && (
            <span style={styles.phaseHint}>
              Detailer is running… <b style={{ color: '#ff9f0a' }}>Do not close</b> this window
            </span>
          )}
          {isSwitchPhase && (
            <span style={styles.phaseHint}>
              Choose <b style={{ color: '#30d158' }}>Original</b> or <b style={{ color: '#0a84ff' }}>Detailed</b> for the next loop
            </span>
          )}
          {autoTagResult && !isSwitchPhase && (
            <div style={styles.tagResult} title={autoTagResult}>
              <span style={{ color: '#64d2ff', fontSize: 12, fontWeight: 600 }}>Tag:</span>
              <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, marginLeft: 6, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {autoTagResult}
              </span>
            </div>
          )}
        </div>

        {(isMaskPhase || isPromptPhase) && (
          <div style={styles.settingsRow}>
            <AdvancedSettings params={params} onChange={onParamChange} />
          </div>
        )}

        <div style={styles.actionRow}>
          <button style={styles.secondaryBtn} onClick={onFinish}>
            {isSwitchPhase ? 'Finish & Close' : 'Finish'}
          </button>
        </div>
      </div>
    </div>
  );
};

const TagCard: React.FC<{
  label: string;
  description: string;
  image?: string;
  onClick: () => void;
  disabled: boolean;
}> = ({ label, description, image, onClick, disabled }) => (
  <button
    style={{
      ...styles.tagCard,
      opacity: disabled ? 0.5 : 1,
      cursor: disabled ? 'not-allowed' : 'pointer',
    }}
    onClick={onClick}
    disabled={disabled}
  >
    <div style={styles.tagCardImageWrap}>
      {image ? (
        <img src={image} alt={label} style={styles.tagCardImage} />
      ) : (
        <div style={styles.tagCardPlaceholder}>No preview</div>
      )}
    </div>
    <div style={styles.tagCardLabel}>{label}</div>
    <div style={styles.tagCardDesc}>{description}</div>
  </button>
);

const PhaseStep: React.FC<{ label: string; active: boolean; done: boolean }> = ({ label, active, done }) => (
  <div style={{
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    padding: '4px 12px',
    borderRadius: 8,
    background: active ? 'rgba(10, 132, 255, 0.12)' : done ? 'rgba(48, 209, 88, 0.08)' : 'transparent',
    border: active ? '1px solid rgba(10, 132, 255, 0.25)' : done ? '1px solid rgba(48, 209, 88, 0.2)' : '1px solid transparent',
    transition: 'all 0.3s ease',
  }}>
    <StatusDot active={done || active} />
    <span style={{
      fontSize: 12,
      fontWeight: active ? 700 : 600,
      color: active ? '#0a84ff' : done ? '#30d158' : 'rgba(255,255,255,0.35)',
      transition: 'color 0.3s ease',
    }}>
      {label}
    </span>
  </div>
);

const PhaseConnector: React.FC<{ done: boolean }> = ({ done }) => (
  <div style={{
    width: 18,
    height: 1,
    background: done ? '#30d158' : 'rgba(255,255,255,0.1)',
    transition: 'background 0.3s ease',
  }} />
);

const StatusDot: React.FC<{ active: boolean }> = ({ active }) => (
  <span
    style={{
      width: 7,
      height: 7,
      borderRadius: '50%',
      display: 'inline-block',
      marginRight: 5,
      background: active ? '#30d158' : '#ff9f0a',
      boxShadow: active
        ? '0 0 5px rgba(48, 209, 88, 0.45)'
        : '0 0 5px rgba(255, 159, 10, 0.4)',
      transition: 'all 0.3s ease',
      flexShrink: 0,
    }}
  />
);

function getPanelStyle(active: boolean): React.CSSProperties {
  const color = active ? '#007aff' : '#ff9f0a';
  return {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    background: '#0d0d0d',
    position: 'relative',
    borderRadius: 14,
    overflow: 'hidden',
    border: `2px solid ${color}`,
    boxShadow: `0 0 0 1px ${color}33, 0 0 20px ${color}22`,
    transition: 'border-color 0.4s ease, box-shadow 0.4s ease, flex 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94)',
    margin: '0 4px',
  };
}

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
    padding: '10px 24px',
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
  phaseSteps: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
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
  tagPanelInner: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '44px 6px 6px',
    overflowY: 'auto',
    flex: 1,
    alignItems: 'stretch',
  },
  tagCard: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    padding: 6,
    background: 'rgba(28, 28, 30, 0.6)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 10,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    textAlign: 'center',
    minHeight: 0,
  },
  tagCardImageWrap: {
    width: '100%',
    aspectRatio: '1',
    borderRadius: 6,
    overflow: 'hidden',
    background: '#1a1a1a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagCardImage: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  tagCardPlaceholder: {
    fontSize: 9,
    color: 'rgba(255,255,255,0.3)',
    fontWeight: 500,
  },
  tagCardLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: '#fff',
    letterSpacing: '0.1px',
    lineHeight: 1.2,
  },
  tagCardDesc: {
    fontSize: 9,
    fontWeight: 500,
    color: 'rgba(255,255,255,0.4)',
    lineHeight: 1.2,
  },
  tagLoading: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '0 12px 10px',
  },
  tagResultBar: {
    display: 'flex',
    alignItems: 'center',
    background: 'rgba(100, 210, 255, 0.08)',
    padding: '5px 12px',
    borderRadius: 8,
    border: '1px solid rgba(100, 210, 255, 0.15)',
    margin: '0 12px 10px',
  },
  waitingOverlay: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(13, 13, 13, 0.82)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    zIndex: 20,
    borderRadius: 14,
    gap: 16,
  },
  spinner: {
    width: 24,
    height: 24,
    borderRadius: '50%',
    border: '2px solid rgba(255,255,255,0.08)',
    borderTopColor: '#0a84ff',
    animation: 'spin 1s linear infinite',
    flexShrink: 0,
  },
  waitingTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: '#fff',
    letterSpacing: '0.3px',
  },
  waitingSubtitle: {
    fontSize: 13,
    fontWeight: 500,
    color: 'rgba(255,255,255,0.45)',
    letterSpacing: '0.2px',
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
    gap: 16,
  },
  phaseHint: {
    fontSize: 13,
    fontWeight: 500,
    color: 'rgba(255,255,255,0.5)',
    lineHeight: 1.5,
  },
  tagResult: {
    display: 'flex',
    alignItems: 'center',
    background: 'rgba(100, 210, 255, 0.08)',
    padding: '4px 12px',
    borderRadius: 10,
    border: '1px solid rgba(100, 210, 255, 0.15)',
  },
  settingsRow: {
    display: 'flex',
    alignItems: 'center',
    marginRight: 20,
  },
  actionRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  autoTagBtn: {
    padding: '9px 24px',
    fontSize: 14,
    fontWeight: 700,
    color: '#fff',
    background: 'rgba(175, 82, 222, 0.85)',
    border: 'none',
    borderRadius: 10,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    letterSpacing: '0.3px',
    boxShadow: '0 2px 8px rgba(175, 82, 222, 0.25)',
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
