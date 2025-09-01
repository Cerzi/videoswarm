import { useEffect, useMemo } from 'react';

export default function useTrashIntegration({
  electronAPI,
  notify,
  confirm,
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

  return {
    electronAPI,
    notify,
    confirm,
    releaseVideoHandlesForAsync,
    onItemsRemoved,
  };
}
