import React, { useEffect, useMemo, useRef } from 'react';
import {
  actionPolicies,
  getContextPolicy,
  TargetPolicy,
} from "../hooks/actions/actionPolicies";

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
    electronAPI?.openInExternalPlayer ||
    electronAPI?.showItemInFolder ||
    electronAPI?.moveToTrash
  );
  const canSingleFileOps = Boolean(primaryVideo?.isElectronFile && primaryVideo?.fullPath);

  // ===== Label helper based on policy =====
  const menuLabel = (actionId) => {
    const base = actionPolicies[actionId]?.label ?? actionId;
    if (selectionCount > 1) {
      const policy = getContextPolicy(actionId);
      if (policy === TargetPolicy.CONTEXT_ONLY) return `${base} (this item)`;
      if (policy === TargetPolicy.ALL_SELECTED) return `${base} (${selectionCount} selected)`;
    }
    return base;
  };

  // ===== Menu items =====
  const menuItems = useMemo(() => {
    const items = [];

    // If we right-clicked an item (contextId present)
    if (contextId) {
      if (isElectron && canSingleFileOps) {
        // Single-item verbs (operate on CONTEXT_ONLY when multi-selected)
        items.push(
          { id: 'show-in-folder', label: `📁 ${menuLabel('show-in-folder')}`, action: 'show-in-folder' },
          { id: 'open-external',  label: `🎬 ${menuLabel('open-external')}`,  action: 'open-external' },
        );
      }

      // Copy actions (ALL_SELECTED)
      items.push(
        { type: 'separator' },
        { id: 'copy-path',          label: `📋 ${menuLabel('copy-path')}`,          action: 'copy-path' },
        { id: 'copy-relative-path', label: `📋 ${menuLabel('copy-relative-path')}`, action: 'copy-relative-path' },
        { id: 'copy-filename',      label: `📄 ${menuLabel('copy-filename')}`,      action: 'copy-filename' },
      );

      // Properties (CONTEXT_ONLY)
      items.push(
        { type: 'separator' },
        { id: 'file-properties',    label: `📊 ${menuLabel('file-properties')}`,    action: 'file-properties' },
      );

      // Destructive (ALL_SELECTED)
      if (isElectron) {
        items.push(
          { type: 'separator' },
          { id: 'move-to-trash', label: `🗑️ ${menuLabel('move-to-trash')}`, action: 'move-to-trash', dangerous: true }
        );
      }
      return items;
    }

    // Background context (no contextId): keep minimal
    items.push(
      { id: 'copy-filename', label: '📄 Copy Filename', action: 'copy-filename', disabled: true }
    );
    return items;
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
