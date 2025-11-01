import { useState, useCallback } from 'react';

/**
 * Manages context-menu UI state.
 * - Right-click on item: open menu without mutating selection
 * - Right-click on empty space: hide the custom menu (native menus permitted)
 * - Stores position + contextId for the menu renderer
 */
export function useContextMenu() {
  const [state, setState] = useState({
    visible: false,
    position: { x: 0, y: 0 },
    contextId: undefined, // id of the item right-clicked, undefined if background
  });

  const showOnItem = useCallback((event, videoId) => {
    if (!event || !videoId) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    setState({
      visible: true,
      position: {
        x: event.clientX ?? 0,
        y: event.clientY ?? 0,
      },
      contextId: videoId,
    });
  }, []);

  const showOnEmpty = useCallback((event) => {
    if (!event) return;
    event.stopPropagation?.();
    setState((prev) =>
      prev.visible
        ? { ...prev, visible: false, contextId: undefined }
        : prev
    );
  }, []);

  const hide = useCallback(() => {
    setState((s) => ({ ...s, visible: false }));
  }, []);

  return { contextMenu: state, showOnItem, showOnEmpty, hide };
}
