import React from 'react';

const LoadingProgress = ({ progress, onCancel }) => {
  const { current, total, stage } = progress;
  const percentage = total > 0 ? Math.round((current / total) * 100) : 0;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.8)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 10000,
      fontFamily: 'system-ui, -apple-system, sans-serif'
    }}>
      <div style={{
        backgroundColor: '#2d2d2d',
        borderRadius: '12px',
        padding: '2rem',
        maxWidth: '400px',
        width: '90%',
        textAlign: 'center',
        boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
        border: '1px solid #404040'
      }}>
        {/* Header */}
        <div style={{
          fontSize: '1.5rem',
          marginBottom: '1rem',
          color: '#fff'
        }}>
          🐝 Loading Video Collection
        </div>

        {/* Stage indicator */}
        <div style={{
          fontSize: '0.9rem',
          color: '#ccc',
          marginBottom: '1.5rem',
          minHeight: '1.2rem'
        }}>
          {stage}
        </div>

        {/* Progress bar */}
        <div style={{
          width: '100%',
          height: '8px',
          backgroundColor: '#404040',
          borderRadius: '4px',
          overflow: 'hidden',
          marginBottom: '1rem'
        }}>
          <div style={{
            width: `${percentage}%`,
            height: '100%',
            backgroundColor: '#4CAF50',
            borderRadius: '4px',
            transition: 'width 0.3s ease',
            background: total > 0 
              ? 'linear-gradient(90deg, #4CAF50, #45a049)' 
              : 'linear-gradient(90deg, #666, #888)'
          }} />
        </div>

        {/* Progress text */}
        <div style={{
          fontSize: '0.9rem',
          color: '#ccc',
          marginBottom: '1.5rem',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <span>
            {total > 0 ? `${current.toLocaleString()} / ${total.toLocaleString()}` : 'Preparing...'}
          </span>
          <span style={{ fontWeight: 'bold', color: '#4CAF50' }}>
            {percentage}%
          </span>
        </div>

        {/* Performance tips */}
        <div style={{
          fontSize: '0.75rem',
          color: '#888',
          marginBottom: '1.5rem',
          padding: '0.75rem',
          backgroundColor: '#1a1a1a',
          borderRadius: '6px',
          lineHeight: 1.4
        }}>
          💡 <strong>Tip:</strong> Videos are rendered progressively to prevent freezing. 
          Large collections may take a moment to fully load.
        </div>

        {/* Controls */}
        <div style={{
          display: 'flex',
          gap: '1rem',
          justifyContent: 'center'
        }}>
          <button
            onClick={onCancel}
            style={{
              padding: '0.75rem 1.5rem',
              backgroundColor: '#ff4444',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '0.9rem',
              fontWeight: 'bold',
              transition: 'background-color 0.2s'
            }}
            onMouseEnter={(e) => e.target.style.backgroundColor = '#cc3333'}
            onMouseLeave={(e) => e.target.style.backgroundColor = '#ff4444'}
          >
            Cancel (ESC)
          </button>
          
          {percentage === 100 && (
            <button
              onClick={onCancel}
              style={{
                padding: '0.75rem 1.5rem',
                backgroundColor: '#4CAF50',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '0.9rem',
                fontWeight: 'bold',
                transition: 'background-color 0.2s'
              }}
              onMouseEnter={(e) => e.target.style.backgroundColor = '#45a049'}
              onMouseLeave={(e) => e.target.style.backgroundColor = '#4CAF50'}
            >
              Continue
            </button>
          )}
        </div>

        {/* Memory usage indicator (if available) */}
        {performance.memory && (
          <div style={{
            marginTop: '1rem',
            fontSize: '0.7rem',
            color: '#666',
            display: 'flex',
            justifyContent: 'space-between'
          }}>
            <span>Memory:</span>
            <span>
              {Math.round((performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit) * 100)}%
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

export default LoadingProgress;