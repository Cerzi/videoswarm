import { useCallback, useEffect, useRef, useState } from "react";

const EMPTY = { folders: [], inRoot: [], rootCovered: false };

const shapeOf = (result) => ({
  folders: Array.isArray(result?.folders) ? result.folders : [],
  inRoot: Array.isArray(result?.inRoot) ? result.inRoot : [],
  rootCovered: result?.rootCovered === true,
});

/**
 * Archived folders (docs/architecture/library-archive.md): every archived
 * folder, the open root's archived tree paths ("" for the root itself), and
 * whether a folder above the root is archived. Follows the open root and
 * profile switches.
 */
export function useArchivedFolders({ activeRootPath = null } = {}) {
  const [state, setState] = useState(EMPTY);
  const requestRef = useRef(0);

  const take = useCallback((requestId, result) => {
    if (requestId !== requestRef.current) return false;
    if (result?.success === false) throw new Error(result.error || "Could not read archived folders");
    setState(shapeOf(result));
    return true;
  }, []);

  const refresh = useCallback(async () => {
    const api = window.electronAPI?.library;
    if (!api?.listArchived) return;
    const requestId = ++requestRef.current;
    try {
      take(requestId, await api.listArchived(activeRootPath || null));
    } catch {
      if (requestId === requestRef.current) setState(EMPTY);
    }
  }, [activeRootPath, take]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const subscribe = window.electronAPI?.profiles?.onChanged;
    if (!subscribe) return undefined;
    return subscribe(() => {
      requestRef.current += 1;
      setState(EMPTY);
      refresh();
    });
  }, [refresh]);

  // A folder of the open root, by its tree path.
  const setArchived = useCallback(
    async (relativePath, archived) => {
      const api = window.electronAPI?.library;
      if (!api?.setArchived || !activeRootPath) return false;
      const requestId = ++requestRef.current;
      return take(
        requestId,
        await api.setArchived({ rootPath: activeRootPath, relativePath: relativePath || "", archived })
      );
    },
    [activeRootPath, take]
  );

  // Any archived folder, by its own path, brought back.
  const unarchiveFolder = useCallback(
    async (folderPath) => {
      const api = window.electronAPI?.library;
      if (!api?.setArchived) return false;
      const requestId = ++requestRef.current;
      const result = await api.setArchived({ folderPath, archived: false });
      if (!take(requestId, result)) return false;
      // The answer names no root; read the open root's paths again.
      if (activeRootPath) await refresh();
      return true;
    },
    [activeRootPath, refresh, take]
  );

  return {
    archivedFolders: state.folders,
    archivedTreePaths: state.inRoot,
    archivedRootCovered: state.rootCovered,
    refreshArchived: refresh,
    setArchived,
    unarchiveFolder,
  };
}

/**
 * How a tree path is archived: "own" when archived itself, "covered" when
 * under an archived folder, else null.
 */
export function archivedTreeState(treePath, archivedTreePaths, rootCovered = false) {
  const target = String(treePath || "");
  if ((archivedTreePaths || []).includes(target)) return "own";
  if (rootCovered) return "covered";
  for (const archived of archivedTreePaths || []) {
    if (archived === "" || target.startsWith(`${archived}/`)) return "covered";
  }
  return null;
}
