import { useCallback, useEffect, useRef, useState } from "react";

const assertSuccess = (result, fallback) => {
  if (result?.success === false) {
    throw new Error(result.error || fallback);
  }
  return result;
};

export function useSavedViews() {
  const [savedViews, setSavedViews] = useState([]);
  const [error, setError] = useState(null);
  const requestRef = useRef(0);
  const profileEpochRef = useRef(0);

  const refreshSavedViews = useCallback(async () => {
    const api = window.electronAPI?.library;
    if (!api?.listSavedViews) return [];
    const requestId = ++requestRef.current;
    try {
      const result = assertSuccess(
        await api.listSavedViews(),
        "Could not load saved views"
      );
      if (requestId !== requestRef.current) return [];
      const views = Array.isArray(result?.views) ? result.views : [];
      setSavedViews(views);
      setError(null);
      return views;
    } catch (nextError) {
      if (requestId === requestRef.current) {
        setError(nextError?.message || "Could not load saved views");
      }
      return [];
    }
  }, []);

  const createSavedView = useCallback(async (name, definition) => {
    const api = window.electronAPI?.library;
    if (!api?.createSavedView) return null;
    const profileEpoch = profileEpochRef.current;
    try {
      const result = assertSuccess(
        await api.createSavedView(name, definition),
        "Could not save this view"
      );
      if (profileEpoch !== profileEpochRef.current) return null;
      if (result?.view) {
        setSavedViews((previous) =>
          [...previous.filter((view) => view.id !== result.view.id), result.view].sort(
            (left, right) => left.name.localeCompare(right.name)
          )
        );
      }
      await refreshSavedViews();
      if (profileEpoch !== profileEpochRef.current) return null;
      setError(null);
      return result?.view ?? null;
    } catch (nextError) {
      if (profileEpoch === profileEpochRef.current) {
        setError(nextError?.message || "Could not save this view");
        throw nextError;
      }
      return null;
    }
  }, [refreshSavedViews]);

  const updateSavedView = useCallback(async (id, changes) => {
    const api = window.electronAPI?.library;
    if (!api?.updateSavedView) return null;
    const profileEpoch = profileEpochRef.current;
    try {
      const result = assertSuccess(
        await api.updateSavedView(id, changes),
        "Could not update this view"
      );
      if (profileEpoch !== profileEpochRef.current) return null;
      if (result?.view) {
        setSavedViews((previous) =>
          previous
            .map((view) => (view.id === result.view.id ? result.view : view))
            .sort((left, right) => left.name.localeCompare(right.name))
        );
      }
      await refreshSavedViews();
      if (profileEpoch !== profileEpochRef.current) return null;
      setError(null);
      return result?.view ?? null;
    } catch (nextError) {
      if (profileEpoch === profileEpochRef.current) {
        setError(nextError?.message || "Could not update this view");
        throw nextError;
      }
      return null;
    }
  }, [refreshSavedViews]);

  const deleteSavedView = useCallback(async (id) => {
    const api = window.electronAPI?.library;
    if (!api?.deleteSavedView) return false;
    const profileEpoch = profileEpochRef.current;
    try {
      const result = assertSuccess(
        await api.deleteSavedView(id),
        "Could not delete this view"
      );
      if (profileEpoch !== profileEpochRef.current) return false;
      if (result?.deleted) {
        setSavedViews((previous) => previous.filter((view) => view.id !== id));
      }
      await refreshSavedViews();
      if (profileEpoch !== profileEpochRef.current) return false;
      setError(null);
      return Boolean(result?.deleted);
    } catch (nextError) {
      if (profileEpoch === profileEpochRef.current) {
        setError(nextError?.message || "Could not delete this view");
        throw nextError;
      }
      return false;
    }
  }, [refreshSavedViews]);

  useEffect(() => {
    refreshSavedViews();
  }, [refreshSavedViews]);

  useEffect(() => {
    const subscribe = window.electronAPI?.profiles?.onChanged;
    if (!subscribe) return undefined;
    return subscribe(() => {
      requestRef.current += 1;
      profileEpochRef.current += 1;
      setSavedViews([]);
      setError(null);
      refreshSavedViews();
    });
  }, [refreshSavedViews]);

  return {
    savedViews,
    error,
    refreshSavedViews,
    createSavedView,
    updateSavedView,
    deleteSavedView,
  };
}
