import { useCallback, useEffect, useMemo } from 'react';

export default function useTrashIntegration({
  electronAPI,
  notify,
  confirm,
  preTrashCleanup,
  postConfirmRecovery,
  captureLastFocusSelector,
  releaseVideoHandlesForAsync,

  // your real setters
  setVideos,            // (prev) => next array
  setSelected,          // (prevSet) => nextSet
  setLoadedIds,         // Set updater (ids)
  setPlayingIds,        // Set updater (ids)
  setVisibleIds,        // optional
  setLoadingIds,        // optional
}) {
  // movedSet contains *paths/ids* (your app uses id === path)
  const onItemsRemoved = useMemo(() => (movedSet) => {
    if (!movedSet || movedSet.size === 0) return;

    // Remove from collection (by id)
    setVideos(prev => prev.filter(v => !movedSet.has(v.id)));

    // Clear selection
    if (setSelected) {
      setSelected(prev => {
        const next = new Set(prev);
        for (const id of prev) if (movedSet.has(id)) next.delete(id);
        return next;
      });
    }

    // Drop loaded/playing/visible/loading
    const prune = (setter) => setter && setter(prev => {
      const next = new Set(prev);
      for (const id of prev) if (movedSet.has(id)) next.delete(id);
      return next;
    });

    prune(setLoadedIds);
    prune(setPlayingIds);
    prune(setVisibleIds);
    prune(setLoadingIds);
  }, [setVideos, setSelected, setLoadedIds, setPlayingIds, setVisibleIds, setLoadingIds]);

  // Optional: listen for main-process broadcast
  useEffect(() => {
    const api = electronAPI;
    if (!api?.onFilesTrashed) return;
    const handler = (_evt, movedPaths) => {
      const movedSet = new Set(movedPaths || []);
      onItemsRemoved(movedSet);
      releaseVideoHandlesForAsync?.(Array.from(movedSet)).catch(() => {});
    };
    api.onFilesTrashed(handler);
    return () => api.offFilesTrashed?.(handler);
  }, [electronAPI, onItemsRemoved, releaseVideoHandlesForAsync]);

  const confirmMoveToTrash = useCallback(async ({ count, sampleName }) => {
    preTrashCleanup?.();

    const lastFocusedSelector = captureLastFocusSelector?.() ?? null;

    const buildMessage = () => {
      if (count === 1) {
        if (sampleName) return `Move "${sampleName}" to Recycle Bin?`;
        return "Move this item to Recycle Bin?";
      }
      return `Move ${count} item(s) to Recycle Bin?`;
    };

    const fallbackConfirm = () => {
      const fn = typeof confirm === 'function' ? confirm : window?.confirm;
      if (typeof fn !== 'function') return true;
      try {
        return fn(buildMessage());
      } catch (error) {
        console.warn('[trash] confirm fallback failed', error);
        return false;
      }
    };

    let confirmed = false;
    try {
      if (electronAPI?.confirmMoveToTrash) {
        confirmed = await electronAPI.confirmMoveToTrash({ count, sampleName });
      } else {
        confirmed = fallbackConfirm();
      }
    } catch (error) {
      console.warn('[trash] confirmMoveToTrash failed', error);
      confirmed = false;
    }

    postConfirmRecovery?.({
      cancelled: !confirmed,
      lastFocusedSelector,
    });

    return { confirmed: !!confirmed, lastFocusedSelector };
  }, [captureLastFocusSelector, confirm, electronAPI, postConfirmRecovery, preTrashCleanup]);

  return {
    electronAPI,
    notify,
    confirmMoveToTrash,
    postConfirmRecovery,
    releaseVideoHandlesForAsync,
    onItemsRemoved,
  };
}
