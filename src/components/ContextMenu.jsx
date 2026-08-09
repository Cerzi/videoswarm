import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  actionPolicies,
  getContextPolicy,
  TargetPolicy,
} from "../hooks/actions/actionPolicies";

const MENU_MARGIN = 8;
const ROOT_MENU_WIDTH = 280;
const SUBMENU_WIDTH = 270;
const HEADER_HEIGHT = 40;
const ITEM_HEIGHT = 36;
const SEPARATOR_HEIGHT = 8;

const getViewport = () => ({
  width: typeof window === 'undefined' ? 1024 : window.innerWidth,
  height: typeof window === 'undefined' ? 768 : window.innerHeight,
});

const estimatedHeight = (items, includeHeader = false) =>
  (includeHeader ? HEADER_HEIGHT : 0) +
  items.reduce(
    (height, item) =>
      height + (item.type === 'separator' ? SEPARATOR_HEIGHT : ITEM_HEIGHT),
    0
  );

const fitToViewport = ({ x, y }, { width, height }) => {
  const viewport = getViewport();
  const availableWidth = Math.max(0, viewport.width - MENU_MARGIN * 2);
  const availableHeight = Math.max(0, viewport.height - MENU_MARGIN * 2);
  const fittedWidth = Math.min(width, availableWidth);
  const fittedHeight = Math.min(height, availableHeight);

  return {
    x: Math.max(
      MENU_MARGIN,
      Math.min(Number(x) || 0, viewport.width - fittedWidth - MENU_MARGIN)
    ),
    y: Math.max(
      MENU_MARGIN,
      Math.min(Number(y) || 0, viewport.height - fittedHeight - MENU_MARGIN)
    ),
  };
};

const placementRect = ({ x, y }, { width, height }) => ({
  x,
  y,
  left: x,
  top: y,
  right: x + width,
  bottom: y + height,
  width,
  height,
});

/**
 * Reports which horizontal side of the raw requested pointer position contains
 * the final menu midpoint. A menu that is clamped back from the right viewport
 * edge therefore reports "left"; an ordinarily placed menu reports "right".
 */
const placementSide = (rect, requestedX) =>
  rect.left + rect.width / 2 < (Number(requestedX) || 0) ? 'left' : 'right';

const rootMenuSize = (element, items) => {
  const measuredRect = element?.getBoundingClientRect?.();
  const viewport = getViewport();
  return {
    width:
      measuredRect?.width > 0
        ? measuredRect.width
        : Math.min(ROOT_MENU_WIDTH, Math.max(0, viewport.width - MENU_MARGIN * 2)),
    height:
      measuredRect?.height > 0
        ? measuredRect.height
        : Math.min(
            estimatedHeight(items, true),
            Math.max(0, viewport.height - MENU_MARGIN * 2)
          ),
  };
};

const ContextMenu = ({
  visible,
  position,
  contextId,
  getById,
  selectionCount = 0,
  electronAPI = typeof window !== 'undefined' ? window.electronAPI : undefined,
  onClose,
  onAction,
  onPlacementChange,
  reviewModeEnabled = true,
}) => {
  const requestedPosition = position || { x: 0, y: 0 };
  const layerRef = useRef(null);
  const menuRef = useRef(null);
  const submenuRef = useRef(null);
  const submenuTriggerRefs = useRef(new Map());
  const onPlacementChangeRef = useRef(onPlacementChange);
  const lastPlacementReportRef = useRef(null);
  onPlacementChangeRef.current = onPlacementChange;
  const [activeSubmenu, setActiveSubmenu] = useState(null);
  const [rootPosition, setRootPosition] = useState(requestedPosition);
  const [submenuPosition, setSubmenuPosition] = useState(null);

  const primaryVideo = useMemo(() => {
    if (!contextId || !getById) return undefined;
    try { return getById(contextId); } catch { return undefined; }
  }, [contextId, getById]);

  const headerText = useMemo(() => {
    if (selectionCount > 1) return `${selectionCount} items selected`;
    if (primaryVideo?.name) return primaryVideo.name;
    return 'Actions';
  }, [primaryVideo, selectionCount]);

  const canSingleFileOps = Boolean(
    primaryVideo?.isElectronFile && primaryVideo?.fullPath
  );

  const menuLabel = (actionId) => {
    const base = actionPolicies[actionId]?.label ?? actionId;
    if (selectionCount > 1) {
      const policy = getContextPolicy(actionId);
      if (policy === TargetPolicy.CONTEXT_ONLY) return `${base} (this item)`;
      if (policy === TargetPolicy.ALL_SELECTED) {
        return `${base} (${selectionCount} selected)`;
      }
    }
    return base;
  };

  const menuItems = useMemo(() => {
    if (!contextId) {
      return [
        {
          id: 'copy-filename',
          label: '📄 Copy Filename',
          action: 'copy-filename',
          disabled: true,
        },
      ];
    }

    const items = [];
    const pushSection = (sectionItems = []) => {
      const filtered = sectionItems.filter(Boolean);
      if (!filtered.length) return;
      if (items.length) items.push({ type: 'separator' });
      items.push(...filtered);
    };
    const localFileUnavailableReason = canSingleFileOps
      ? 'Desktop integration is unavailable'
      : 'Only available for local files';

    pushSection([
      {
        id: 'show-in-folder',
        label: `📁 ${menuLabel('show-in-folder')}`,
        action: 'show-in-folder',
        disabled:
          !canSingleFileOps || typeof electronAPI?.showItemInFolder !== 'function',
        disabledReason: localFileUnavailableReason,
      },
      {
        id: 'open-external',
        label: `🎬 ${menuLabel('open-external')}`,
        action: 'open-external',
        disabled:
          !canSingleFileOps ||
          typeof electronAPI?.openInExternalPlayer !== 'function',
        disabledReason: localFileUnavailableReason,
      },
    ]);

    const reviewTarget =
      selectionCount > 1 ? ` (${selectionCount} selected)` : '';
    pushSection([
      {
        id: 'metadata-open',
        label: 'ⓘ Open details',
        action: 'metadata:open',
      },
      reviewModeEnabled ? {
        id: 'review-state',
        label: `✓ Review status${reviewTarget}`,
        children: [
          {
            id: 'metadata-review-pick',
            label: '✓ Mark as accepted',
            action: 'metadata:review:pick',
          },
          {
            id: 'metadata-review-reviewed',
            label: '● Mark reviewed',
            action: 'metadata:review:reviewed',
          },
          {
            id: 'metadata-review-reject',
            label: '× Mark as reject',
            action: 'metadata:review:reject',
          },
          {
            id: 'metadata-review-unreviewed',
            label: '○ Reset to unreviewed (clears rating)',
            action: 'metadata:review:unreviewed',
          },
        ],
      } : null,
      {
        id: 'rating',
        label: `★ Rating${reviewTarget}`,
        children: [5, 4, 3, 2, 1].map((stars) => ({
          id: `metadata-rate-${stars}`,
          label: `★ Rate ${'★'.repeat(stars).padEnd(5, '☆')}`,
          action: `metadata:rate:${stars}`,
        })).concat({
          id: 'metadata-rate-clear',
          label: '☆ Clear rating',
          action: 'metadata:rate:clear',
        }),
      },
    ]);

    pushSection([
      {
        id: 'copy',
        label: '📋 Copy',
        children: [
          {
            id: 'copy-path',
            label: `📋 ${menuLabel('copy-path')}`,
            action: 'copy-path',
          },
          {
            id: 'copy-relative-path',
            label: `📋 ${menuLabel('copy-relative-path')}`,
            action: 'copy-relative-path',
          },
          {
            id: 'copy-filename',
            label: `📄 ${menuLabel('copy-filename')}`,
            action: 'copy-filename',
          },
          {
            id: 'copy-last-frame',
            label: `🖼️ ${menuLabel('copy-last-frame')}`,
            action: 'copy-last-frame',
          },
        ],
      },
      {
        id: 'transfer-files',
        label: `📁 ${menuLabel('transfer-files')}`,
        action: 'transfer-files',
      },
      {
        id: 'file-properties',
        label: `📊 ${menuLabel('file-properties')}`,
        action: 'file-properties',
      },
    ]);

    pushSection([
      {
        id: 'move-to-trash',
        label: `🗑️ ${menuLabel('move-to-trash')}`,
        action: 'move-to-trash',
        dangerous: true,
        disabled: typeof electronAPI?.moveToTrash !== 'function',
        disabledReason: 'Desktop integration is unavailable',
      },
    ]);

    return items;
  }, [
    canSingleFileOps,
    contextId,
    electronAPI,
    reviewModeEnabled,
    selectionCount,
  ]);

  const activeSubmenuItem = useMemo(
    () => menuItems.find((item) => item.id === activeSubmenu),
    [activeSubmenu, menuItems]
  );

  useLayoutEffect(() => {
    if (!visible || !position) return;
    const nextPosition = fitToViewport(
      requestedPosition,
      rootMenuSize(menuRef.current, menuItems)
    );
    setRootPosition((previous) =>
      previous?.x === nextPosition.x && previous?.y === nextPosition.y
        ? previous
        : nextPosition
    );
  }, [menuItems, position, requestedPosition.x, requestedPosition.y, visible]);

  useLayoutEffect(() => {
    const hasPlacementCallback =
      typeof onPlacementChangeRef.current === 'function';
    if (!visible || !position || !hasPlacementCallback) {
      lastPlacementReportRef.current = null;
      return;
    }

    const { width, height } = rootMenuSize(menuRef.current, menuItems);
    const fittedPosition = fitToViewport(requestedPosition, { width, height });

    // The request may have changed while state still contains the previous
    // fitted position. Wait for the clamped position to reach the DOM rather
    // than reporting that stale intermediate geometry.
    if (
      rootPosition.x !== fittedPosition.x ||
      rootPosition.y !== fittedPosition.y
    ) {
      return;
    }

    const rect = placementRect(fittedPosition, { width, height });
    const side = placementSide(rect, requestedPosition.x);
    const signature = [
      contextId ?? '',
      Number(requestedPosition.x) || 0,
      Number(requestedPosition.y) || 0,
      rect.left,
      rect.top,
      rect.width,
      rect.height,
      side,
    ].join(':');

    if (lastPlacementReportRef.current === signature) return;
    lastPlacementReportRef.current = signature;
    onPlacementChangeRef.current({ contextId, rect, side });
  }, [
    contextId,
    menuItems,
    position,
    requestedPosition.x,
    requestedPosition.y,
    rootPosition.x,
    rootPosition.y,
    visible,
    Boolean(onPlacementChange),
  ]);

  useLayoutEffect(() => {
    if (!visible) return;
    if (!activeSubmenuItem?.children?.length) {
      setSubmenuPosition(null);
      return;
    }

    const trigger = submenuTriggerRefs.current.get(activeSubmenuItem.id);
    const triggerRect = trigger?.getBoundingClientRect();
    const submenuRect = submenuRef.current?.getBoundingClientRect();
    const viewport = getViewport();
    const width = submenuRect?.width || SUBMENU_WIDTH;
    const height = Math.min(
      submenuRect?.height || estimatedHeight(activeSubmenuItem.children),
      viewport.height - MENU_MARGIN * 2
    );
    let x = (triggerRect?.right || rootPosition.x + ROOT_MENU_WIDTH) + 4;
    if (x + width > viewport.width - MENU_MARGIN) {
      x = (triggerRect?.left || rootPosition.x) - width - 4;
    }
    const nextPosition = fitToViewport(
      {
        x,
        y: triggerRect?.top || rootPosition.y,
      },
      { width, height }
    );
    setSubmenuPosition(nextPosition);
  }, [activeSubmenuItem, rootPosition, visible]);

  useEffect(() => {
    setActiveSubmenu(null);
  }, [contextId, requestedPosition.x, requestedPosition.y]);

  useEffect(() => {
    if (!visible) return undefined;
    const handlePointerDown = (event) => {
      if (layerRef.current && !layerRef.current.contains(event.target)) {
        onClose?.();
      }
    };
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      if (activeSubmenu) {
        event.preventDefault();
        setActiveSubmenu(null);
        submenuTriggerRefs.current.get(activeSubmenu)?.focus?.();
      } else {
        onClose?.();
      }
    };
    const handleResize = () => onClose?.();
    const handleScroll = (event) => {
      if (!layerRef.current?.contains(event.target)) {
        onClose?.();
        return;
      }
      if (event.target === menuRef.current) setActiveSubmenu(null);
    };

    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('touchstart', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('touchstart', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [activeSubmenu, onClose, visible]);

  if (!visible || !position) return null;

  const handleAction = (item) => {
    if (!item?.action || item.disabled) return;
    onAction?.(item.action);
    onClose?.();
  };

  const renderItem = (item, { inSubmenu = false } = {}) => {
    if (item.type === 'separator') {
      return <div key={`separator-${item.id}`} role="separator" className="context-menu__separator" />;
    }

    const hasChildren = Boolean(item.children?.length);
    const expanded = hasChildren && activeSubmenu === item.id;
    const disabledTitle = item.disabled ? item.disabledReason : undefined;
    return (
      <button
        key={item.id}
        ref={
          hasChildren && !inSubmenu
            ? (element) => {
                if (element) submenuTriggerRefs.current.set(item.id, element);
                else submenuTriggerRefs.current.delete(item.id);
              }
            : undefined
        }
        type="button"
        role="menuitem"
        className={`context-menu__item${item.dangerous ? ' context-menu__item--dangerous' : ''}`}
        aria-disabled={item.disabled ? 'true' : undefined}
        aria-haspopup={hasChildren ? 'menu' : undefined}
        aria-expanded={hasChildren ? expanded : undefined}
        aria-controls={hasChildren ? `context-submenu-${item.id}` : undefined}
        title={disabledTitle}
        onMouseEnter={() => {
          if (!inSubmenu) setActiveSubmenu(hasChildren ? item.id : null);
        }}
        onClick={() => {
          if (item.disabled) return;
          if (hasChildren) {
            setActiveSubmenu((current) => current === item.id ? null : item.id);
          } else {
            handleAction(item);
          }
        }}
        onKeyDown={(event) => {
          if (hasChildren && ['ArrowRight', 'Enter', ' '].includes(event.key)) {
            event.preventDefault();
            setActiveSubmenu(item.id);
          }
          if (inSubmenu && event.key === 'ArrowLeft') {
            event.preventDefault();
            setActiveSubmenu(null);
            submenuTriggerRefs.current.get(activeSubmenu)?.focus?.();
          }
        }}
      >
        <span className="context-menu__item-label">{item.label}</span>
        {hasChildren ? (
          <span className="context-menu__submenu-arrow" aria-hidden="true">
            ›
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <div
      ref={layerRef}
      className="context-menu-layer"
      data-context-menu
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        ref={menuRef}
        className="context-menu"
        role="menu"
        aria-label={`Actions for ${headerText}`}
        style={{ left: `${rootPosition.x}px`, top: `${rootPosition.y}px` }}
      >
        <div className="context-menu-header" title={primaryVideo?.name || headerText}>
          <span className="context-menu-title">{headerText}</span>
        </div>
        <div className="context-menu-items">
          {menuItems.map((item, index) =>
            renderItem(
              item.type === 'separator' ? { ...item, id: `root-${index}` } : item
            )
          )}
        </div>
      </div>

      {activeSubmenuItem?.children?.length ? (
        <div
          ref={submenuRef}
          id={`context-submenu-${activeSubmenuItem.id}`}
          className="context-menu context-menu--submenu"
          role="menu"
          aria-label={activeSubmenuItem.label}
          style={{
            left: `${submenuPosition?.x ?? rootPosition.x}px`,
            top: `${submenuPosition?.y ?? rootPosition.y}px`,
            visibility: submenuPosition ? 'visible' : 'hidden',
          }}
        >
          <div className="context-menu-items">
            {activeSubmenuItem.children.map((item) =>
              renderItem(item, { inSubmenu: true })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default ContextMenu;
