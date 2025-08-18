import React from 'react';

export default function RecentFolders({ items, onOpen, onRemove, onClear }) {
  if (!items?.length) return null;

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <h3 style={{ margin: 0, color: '#ddd', fontWeight: 600 }}>Recent Locations</h3>
        <button
          onClick={onClear}
          style={{ marginLeft: 'auto', background: 'transparent', color: '#999', border: '1px solid #444', borderRadius: 6, padding: '4px 8px', cursor: 'pointer' }}
          title="Clear all"
        >
          Clear
        </button>
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {items.map((it) => (
          <li key={it.path}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 12px',
                border: '1px solid #333',
                borderRadius: 8,
                marginBottom: 8,
                background: '#1c1c1c'
              }}>
            <button
              onClick={() => onOpen(it.path)}
              style={{ 
                flex: 1, textAlign: 'left', background: 'transparent', border: 'none', color: '#ddd', cursor: 'pointer'
              }}
              title={it.path}
            >
              <div style={{ fontSize: 14, fontWeight: 600 }}>{it.name}</div>
              <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{it.path}</div>
            </button>
            <button
              onClick={() => onRemove(it.path)}
              aria-label="Remove from history"
              title="Remove"
              style={{
                background: 'transparent',
                border: 'none',
                color: '#888',
                cursor: 'pointer',
                fontSize: 18,
                padding: '0 6px'
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
