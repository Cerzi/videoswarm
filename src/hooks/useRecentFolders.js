import { useEffect, useState, useCallback } from 'react';

const LS_KEY = 'recent-folders';
const isElectron = !!window.electronAPI?.recent;

function lsGet() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
}
function lsSet(items) {
  localStorage.setItem(LS_KEY, JSON.stringify(items));
}

export default function useRecentFolders() {
  const [items, setItems] = useState([]);

  const refresh = useCallback(async () => {
    if (isElectron) {
      const data = await window.electronAPI.recent.get();
      setItems(data);
    } else {
      setItems(lsGet());
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const add = useCallback(async (folderPath) => {
    if (!folderPath) return;
    if (isElectron) {
      setItems(await window.electronAPI.recent.add(folderPath));
    } else {
      const name = folderPath.split(/[\\/]/).pop();
      const now = Date.now();
      const next = [{ path: folderPath, name, lastOpened: now }, ...lsGet().filter(x => x.path !== folderPath)].slice(0, 10);
      lsSet(next);
      setItems(next);
    }
  }, []);

  const remove = useCallback(async (folderPath) => {
    if (isElectron) {
      setItems(await window.electronAPI.recent.remove(folderPath));
    } else {
      const next = lsGet().filter(x => x.path !== folderPath);
      lsSet(next);
      setItems(next);
    }
  }, []);

  const clear = useCallback(async () => {
    if (isElectron) {
      setItems(await window.electronAPI.recent.clear());
    } else {
      lsSet([]);
      setItems([]);
    }
  }, []);

  return { items, refresh, add, remove, clear };
}
