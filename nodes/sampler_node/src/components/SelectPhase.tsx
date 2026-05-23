import React, { useState } from 'react';

interface SelectPhaseProps {
  originalImage: string;
  detailedImage: string;
  onNextLoopOriginal: () => void;
  onNextLoopDetailed: () => void;
  onFinish: () => void;
}

const SelectPhase: React.FC<SelectPhaseProps> = ({
  originalImage,
  detailedImage,
  onNextLoopOriginal,
  onNextLoopDetailed,
  onFinish,
}) => {
  const [selected, setSelected] = useState<'original' | 'detailed'>('detailed');

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.title}>Select Result</span>
        <span style={styles.hint}>Choose which image to use for the next loop</span>
      </div>
      <div style={styles.comparePanel}>
        <div
          style={{
            ...styles.card,
            ...(selected === 'original' ? styles.cardSelected : {}),
          }}
          onClick={() => setSelected('original')}
        >
          <img src={originalImage} alt="Original" style={styles.img} />
          <div style={styles.labelRow}>
            <span style={styles.radio}>{selected === 'original' ? '●' : '○'}</span>
            <span style={styles.label}>Original</span>
          </div>
        </div>
        <div
          style={{
            ...styles.card,
            ...(selected === 'detailed' ? styles.cardSelected : {}),
          }}
          onClick={() => setSelected('detailed')}
        >
          <img src={detailedImage} alt="Detailed" style={styles.img} />
          <div style={styles.labelRow}>
            <span style={styles.radio}>{selected === 'detailed' ? '●' : '○'}</span>
            <span style={styles.label}>Detailed</span>
          </div>
        </div>
      </div>
      <div style={styles.actionBar}>
        <button style={styles.secondaryBtn} onClick={onNextLoopOriginal}>
          Next Loop (Original)
        </button>
        <button style={styles.primaryBtn} onClick={onNextLoopDetailed}>
          Next Loop (Detailed)
        </button>
        <button style={styles.secondaryBtn} onClick={onFinish}>
          Finish
        </button>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: '#1a1a1a',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 20px',
    background: '#252525',
    borderBottom: '1px solid #333',
    flexShrink: 0,
  },
  title: {
    fontSize: 15,
    fontWeight: 600,
    color: '#fff',
  },
  hint: {
    fontSize: 12,
    color: '#888',
  },
  comparePanel: {
    display: 'flex',
    flex: 1,
    minHeight: 0,
    gap: 20,
    padding: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    flex: 1,
    maxWidth: '48%',
    height: '100%',
    background: '#252525',
    borderRadius: 8,
    border: '2px solid transparent',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    transition: 'border-color 0.2s',
  },
  cardSelected: {
    borderColor: '#007aff',
  },
  img: {
    width: '100%',
    flex: 1,
    objectFit: 'contain',
    background: '#1a1a1a',
  },
  labelRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: '12px',
    background: '#252525',
  },
  radio: {
    fontSize: 14,
    color: '#007aff',
  },
  label: {
    fontSize: 14,
    fontWeight: 600,
    color: '#fff',
  },
  actionBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: '12px 20px',
    background: '#252525',
    borderTop: '1px solid #333',
    flexShrink: 0,
  },
  primaryBtn: {
    padding: '10px 28px',
    fontSize: 14,
    fontWeight: 600,
    color: '#fff',
    background: '#007aff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
  },
  secondaryBtn: {
    padding: '10px 28px',
    fontSize: 14,
    fontWeight: 600,
    color: '#fff',
    background: '#444',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
  },
};

export default SelectPhase;
