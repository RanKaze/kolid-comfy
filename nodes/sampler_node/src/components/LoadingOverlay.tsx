import React from 'react';

const LoadingOverlay: React.FC = () => {
  return (
    <div style={styles.overlay}>
      <div style={styles.spinner} />
      <p style={styles.text}>Running detailer... Please wait.</p>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0,0,0,0.85)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  spinner: {
    width: 48,
    height: 48,
    border: '4px solid rgba(255,255,255,0.1)',
    borderTopColor: '#007aff',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  },
  text: {
    marginTop: 16,
    fontSize: 14,
    color: '#ccc',
  },
};

export default LoadingOverlay;
