import { useCallback } from 'react';
import useMasonryBoxSelection from './useMasonryBoxSelection';

/**
 * Centralizes all per-card interactions:
 * - Click: single / ctrl-toggle / shift range (bounding box) / double → fullscreen
 * - Right-click: open context menu without mutating selection
 * - Background right-click: dismiss custom menu without altering selection
 */
export default function useCardSelection({
  gridRef,
  selection,
  getById,
  openFullScreen,
  playingVideos,
    // from useContextMenu – use the pair that matches your hook API
    showOnItem,     // (event, id)
    showOnEmpty,    // (event)
  // OR if you still expose a single function:
  showContextMenu // (event, video|null)
}) {
  const { selectRangeByBox } = useMasonryBoxSelection(gridRef);

  const handleVideoSelect = useCallback(
    (videoId, isCtrlClick, isShiftClick, isDoubleClick) => {
      const video = getById?.(videoId);

      if (isDoubleClick && video) {
        openFullScreen?.(video, playingVideos);
        return;
      }

      if (isShiftClick) {
        if (!selection.anchorId) {
          selection.selectOnly(videoId);
          return;
        }
        // bounding-box range; additive when ctrl/meta held
        selectRangeByBox(selection, selection.anchorId, videoId, isCtrlClick);
        return;
      }

      if (isCtrlClick) {
        selection.toggle(videoId);
      } else {
        selection.selectOnly(videoId);
      }
    },
    [getById, openFullScreen, playingVideos, selection, selectRangeByBox]
  );

  // Card context menu – select if needed then show the menu
  const handleCardContextMenu = useCallback((e, video) => {
    const id = video?.id;
    if (!id) return;

    if (showOnItem) {
      showOnItem(e, id);
      return;
    }

    // fallback for older useContextMenu API
    e.preventDefault();
    e.stopPropagation();
    showContextMenu?.(e, video);
  }, [showOnItem, showContextMenu]);

  // Background context menu – clear selection then show background menu
  const handleBackgroundContextMenu = useCallback((e) => {
    if (showOnEmpty) {
      showOnEmpty(e);
      return;
    }
    // Fallback retains legacy behavior of hiding the custom menu without
    // altering selection state.
    e.stopPropagation();
    showContextMenu?.(e, null);
  }, [showOnEmpty, showContextMenu]);

  return {
    handleVideoSelect,
    handleCardContextMenu,
    handleBackgroundContextMenu
  };
}
