import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const rootPathOf = (root) =>
  typeof root?.rootPath === "string" ? root.rootPath : null;

const upsertRoot = (roots, nextRoot) => {
  const nextPath = rootPathOf(nextRoot);
  if (!nextPath) return roots;
  const index = roots.findIndex((root) => rootPathOf(root) === nextPath);
  if (index < 0) return [...roots, nextRoot];
  const next = roots.slice();
  next[index] = { ...next[index], ...nextRoot };
  return next;
};

export function useLibraryCatalog({
  activeRootPath,
  scannedRoot,
  scannedDirectories = [],
}) {
  const [roots, setRoots] = useState([]);
  const [currentRoot, setCurrentRoot] = useState(scannedRoot ?? null);
  const [directories, setDirectories] = useState(scannedDirectories);
  const [error, setError] = useState(null);
  const rootsRequestRef = useRef(0);
  const treeRequestRef = useRef(0);
  const profileEpochRef = useRef(0);

  const refreshRoots = useCallback(async () => {
    const api = window.electronAPI?.library;
    if (!api?.listRoots) return [];
    const requestId = ++rootsRequestRef.current;
    try {
      const result = await api.listRoots();
      if (requestId !== rootsRequestRef.current) return [];
      if (result?.success === false) {
        throw new Error(result.error || "Could not load library roots");
      }
      const nextRoots = Array.isArray(result?.roots) ? result.roots : [];
      setRoots(nextRoots);
      setError(null);
      return nextRoots;
    } catch (nextError) {
      if (requestId === rootsRequestRef.current) {
        setError(nextError?.message || "Could not load library roots");
      }
      return [];
    }
  }, []);

  const refreshTree = useCallback(async (rootPath = activeRootPath) => {
    const api = window.electronAPI?.library;
    if (!rootPath || !api?.getTree) return null;
    const requestId = ++treeRequestRef.current;
    try {
      const result = await api.getTree(rootPath);
      if (requestId !== treeRequestRef.current) return null;
      if (result?.success === false) {
        throw new Error(result.error || "Could not load folder tree");
      }
      setCurrentRoot(result?.root ?? null);
      setDirectories(Array.isArray(result?.directories) ? result.directories : []);
      setError(null);
      return result;
    } catch (nextError) {
      if (requestId === treeRequestRef.current) {
        setError(nextError?.message || "Could not load folder tree");
      }
      return null;
    }
  }, [activeRootPath]);

  const setPinned = useCallback(async (rootPath, pinned) => {
    const api = window.electronAPI?.library;
    if (!rootPath || !api?.setPinned) return null;
    const profileEpoch = profileEpochRef.current;
    try {
      const result = await api.setPinned(rootPath, Boolean(pinned));
      if (profileEpoch !== profileEpochRef.current) return null;
      if (result?.success === false) {
        throw new Error(result.error || "Could not update library pin");
      }
      if (result?.root) {
        setRoots((previous) => upsertRoot(previous, result.root));
        setCurrentRoot((previous) =>
          rootPathOf(previous) === rootPath ? { ...previous, ...result.root } : previous
        );
      }
      await refreshRoots();
      if (profileEpoch !== profileEpochRef.current) return null;
      setError(null);
      return result?.root ?? null;
    } catch (nextError) {
      if (profileEpoch === profileEpochRef.current) {
        setError(nextError?.message || "Could not update library pin");
        throw nextError;
      }
      return null;
    }
  }, [refreshRoots]);

  useEffect(() => {
    refreshRoots();
  }, [refreshRoots]);

  useEffect(() => {
    const scannedPath = rootPathOf(scannedRoot);
    if (!activeRootPath) {
      treeRequestRef.current += 1;
      setCurrentRoot(null);
      setDirectories([]);
      return;
    }

    if (scannedPath === activeRootPath) {
      treeRequestRef.current += 1;
      setCurrentRoot(scannedRoot);
      setDirectories(Array.isArray(scannedDirectories) ? scannedDirectories : []);
      setRoots((previous) => upsertRoot(previous, scannedRoot));
      refreshRoots();
      return;
    }

    refreshTree(activeRootPath);
  }, [
    activeRootPath,
    scannedRoot,
    refreshRoots,
    refreshTree,
  ]);

  useEffect(() => {
    const subscribe = window.electronAPI?.profiles?.onChanged;
    if (!subscribe) return undefined;
    return subscribe(() => {
      rootsRequestRef.current += 1;
      treeRequestRef.current += 1;
      profileEpochRef.current += 1;
      setRoots([]);
      setCurrentRoot(null);
      setDirectories([]);
      setError(null);
      refreshRoots();
    });
  }, [refreshRoots]);

  const pinnedRoots = useMemo(
    () => roots.filter((root) => Boolean(root?.pinned)),
    [roots]
  );

  return {
    roots,
    pinnedRoots,
    currentRoot,
    directories,
    error,
    refreshRoots,
    refreshTree,
    setPinned,
  };
}
