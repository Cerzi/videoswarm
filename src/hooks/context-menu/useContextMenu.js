import { useState, useCallback } from 'react';

/**
 * Manages *only* context-menu UI state.
 * - Right-click on item: optionally selectOnly(id) if not already selected
 * - Right-click on empty space: clear selection
 * - Stores position + contextId for the menu renderer
 */
export function useContextMenu() {
  const [state, setState] = useState({
    visible: false,
    position: { x: 0, y: 0 },
    contextId: undefined, // id of the item right-clicked, undefined if background
  });

  const showOnItem = useCallback((event, videoId, isSelected, selectOnly) => {
    event.preventDefault();
    event.stopPropagation();
    if (!isSelected) selectOnly?.(videoId); // UX: right-click selects the item
    setState({
      visible: true,
      position: { x: event.clientX, y: event.clientY },
      contextId: videoId,
    });
  }, []);

  const showOnEmpty = useCallback((event, clearSelection) => {
    event.preventDefault();
    event.stopPropagation();
    clearSelection?.();
    setState({
      visible: true,
      position: { x: event.clientX, y: event.clientY },
      contextId: undefined,
    });
  }, []);

  const hide = useCallback(() => {
    setState(s => ({ ...s, visible: false }));
  }, []);

  return { contextMenu: state, showOnItem, showOnEmpty, hide };
}
