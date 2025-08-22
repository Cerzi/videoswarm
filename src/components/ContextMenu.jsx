import React, { useEffect, useMemo, useRef } from 'react';

const pluralize = (count, one, many = undefined) =>
  count === 1 ? one : (many ?? `${one}s`);

const withCount = (count, base, basePlural) =>
  count > 1 ? `${basePlural ?? base} (${count})` : base;

const ContextMenu = ({
  visible,
  position,
  contextId,
  getById,
  selectionCount = 0,
  electronAPI = typeof window !== 'undefined' ? window.electronAPI : undefined,
  onClose,
  onAction,
}) => {
  const rootRef = useRef(null);
  if (!visible || !position) return null;

  useEffect(() => {
    const handlePointerDown = (e) => {
      const root = rootRef.current;
      if (root && !root.contains(e.target)) onClose?.();
    };
    const handleKeyDown = (e) => { if (e.key === 'Escape') onClose?.(); };
    const handleWindowChange = () => onClose?.();

    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('touchstart', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('resize', handleWindowChange);
    window.addEventListener('scroll', handleWindowChange, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('touchstart', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('resize', handleWindowChange);
      window.removeEventListener('scroll', handleWindowChange, true);
    };
  }, [onClose]);

  const primaryVideo = useMemo(() => {
    if (!contextId || !getById) return undefined;
    try { return getById(contextId); } catch { return undefined; }
  }, [contextId, getById]);

  const headerText = useMemo(() => {
    if (selectionCount > 1) return `${selectionCount} items selected`;
    if (primaryVideo?.name) return primaryVideo.name;
    return 'Actions';
  }, [primaryVideo, selectionCount]);

  const isElectron = Boolean(
    electronAPI?.openInExternalPlayer || electronAPI?.showItemInFolder || electronAPI?.moveToTrash
  );
  const canSingleFileOps = Boolean(primaryVideo?.isElectronFile && primaryVideo?.fullPath);

  // Build menu items with pluralized labels when selectionCount > 1
  const menuItems = useMemo(() => {
    const items = [];
    const n = Math.max(1, selectionCount); // effective count for labels

    // Single-item context
    if (contextId && selectionCount <= 1) {
      if (isElectron && canSingleFileOps) {
        items.push(
          { id: 'show-in-folder', label: '📁 Show in File Explorer', action: 'show-in-folder' },
          { id: 'open-external',  label: '🎬 Open in External Player', action: 'open-external' },
          { type: 'separator' },
          { id: 'copy-path',          label: '📋 Copy Full Path', action: 'copy-path' },
          { id: 'copy-relative-path', label: '📋 Copy Relative Path', action: 'copy-relative-path' },
          { id: 'copy-filename',      label: '📄 Copy Filename', action: 'copy-filename' },
          { type: 'separator' },
          { id: 'file-properties',    label: '📊 File Properties', action: 'file-properties' },
          { type: 'separator' },
          { id: 'move-to-trash',      label: '🗑️ Move to Trash', action: 'move-to-trash', dangerous: true },
        );
      } else {
        items.push(
          { id: 'copy-relative-path', label: '📋 Copy Relative Path', action: 'copy-relative-path' },
          { id: 'copy-filename',      label: '📄 Copy Filename', action: 'copy-filename' },
          { type: 'separator' },
          { id: 'file-properties',    label: '📊 File Properties', action: 'file-properties' },
        );
      }
      return items;
    }

    // Multi-selection (apply to all selected)
    if (selectionCount > 1) {
      if (isElectron) {
        items.push(
          { id: 'open-external',      label: `🎬 Open ${n} ${pluralize(n, 'item')}`, action: 'open-external' },
          { type: 'separator' },
          { id: 'copy-path',          label: `📋 Copy ${n} ${pluralize(n, 'Full Path', 'Full Paths')}`, action: 'copy-path' },
          { id: 'copy-relative-path', label: `📋 Copy ${n} ${pluralize(n, 'Relative Path', 'Relative Paths')}`, action: 'copy-relative-path' },
          { id: 'copy-filename',      label: `📄 Copy ${n} ${pluralize(n, 'Filename', 'Filenames')}`, action: 'copy-filename' },
          { type: 'separator' },
          { id: 'move-to-trash',      label: `🗑️ Move ${n} ${pluralize(n, 'item')} to Trash`, action: 'move-to-trash', dangerous: true },
        );
      } else {
        items.push(
          { id: 'copy-relative-path', label: `📋 Copy ${n} ${pluralize(n, 'Relative Path', 'Relative Paths')}`, action: 'copy-relative-path' },
          { id: 'copy-filename',      label: `📄 Copy ${n} ${pluralize(n, 'Filename', 'Filenames')}`, action: 'copy-filename' },
        );
      }
      return items;
    }

    // Background (no selection)
    items.push(
      { id: 'copy-filename', label: '📄 Copy Filename', action: 'copy-filename', disabled: true }
    );
    return items;
  }, [contextId, selectionCount, isElectron, canSingleFileOps]);

  const handleAction = (action) => {
    if (!action) return;
    onAction?.(action);
    onClose?.();
  };

  // Size/positioning
  const approxHeight = menuItems.reduce((h, it) => h + (it.type === 'separator' ? 8 : 36), 40);
  const menuWidth = 260;
  const adjustedPosition = (() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = position.x;
    let y = position.y;
    if (x + menuWidth > vw) x = Math.max(10, vw - menuWidth - 10);
    if (y + approxHeight > vh) y = Math.max(10, vh - approxHeight - 10);
    return { x, y };
  })();

  // Styles
  const menuStyle = {
    position: 'fixed',
    left: `${adjustedPosition.x}px`,
    top: `${adjustedPosition.y}px`,
    backgroundColor: '#2d2d2d',
    border: '1px solid #404040',
    borderRadius: '8px',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
    minWidth: '240px',
    maxWidth: '300px',
    zIndex: 999999,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: '13px',
    userSelect: 'none',
  };
  const headerStyle = {
    backgroundColor: '#1a1a1a',
    padding: '10px 14px',
    borderBottom: '1px solid #404040',
    color: '#fff',
    fontSize: '12px',
    fontWeight: '600',
    borderRadius: '8px 8px 0 0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };
  const itemBase = {
    padding: '10px 14px',
    color: '#e0e0e0',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    transition: 'background-color 0.1s ease',
  };
  const separatorStyle = { height: 1, backgroundColor: '#404040', margin: '4px 0' };

  return (
    <div
      ref={rootRef}
      data-context-menu
      style={menuStyle}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={headerStyle} title={primaryVideo?.name || headerText}>
        {headerText}
      </div>

      {menuItems.map((item, idx) => {
        if (item.type === 'separator') {
          return <div key={`sep-${idx}`} style={separatorStyle} />;
        }
        const isLast = idx === menuItems.length - 1;
        const isDanger = item.dangerous;
        const disabled = item.disabled;
        return (
          <div
            key={item.id}
            role="menuitem"
            aria-disabled={disabled ? 'true' : 'false'}
            style={{
              ...itemBase,
              ...(isDanger ? { color: '#ff6b6b' } : {}),
              ...(disabled ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
              ...(isLast ? { borderRadius: '0 0 8px 8px' } : {}),
            }}
            onClick={() => !disabled && handleAction(item.action)}
            onMouseEnter={(e) => {
              if (disabled) return;
              e.currentTarget.style.backgroundColor = isDanger ? '#ff4444' : '#404040';
              e.currentTarget.style.color = 'white';
            }}
            onMouseLeave={(e) => {
              if (disabled) return;
              e.currentTarget.style.backgroundColor = 'transparent';
              e.currentTarget.style.color = isDanger ? '#ff6b6b' : '#e0e0e0';
            }}
          >
            {item.label}
          </div>
        );
      })}
    </div>
  );
};

export default ContextMenu;
