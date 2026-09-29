import { useCallback, useEffect, useRef, useState } from "react";

const assertSuccess = (result, fallback) => {
  if (result?.success === false) {
    const error = new Error(result.error || fallback);
    if (result.code) error.code = result.code;
    throw error;
  }
  return result;
};

const sequencesApi = () => window.electronAPI?.sequences || null;

/**
 * Named, ordered clip lists.
 *
 * The active sequence is held as a resolved snapshot rather than a list of
 * fingerprints, because an entry whose file has gone missing still occupies its
 * position and the strip has to be able to draw that gap. Present entries carry
 * a full renderer video record, so the same array can be handed to the loupe.
 */
export function useSequences({ preferredRootPath = null } = {}) {
  const [sequences, setSequences] = useState([]);
  const [activeSequenceId, setActiveSequenceId] = useState(null);
  const [activeSequence, setActiveSequence] = useState(null);
  const [error, setError] = useState(null);
  const listRequestRef = useRef(0);
  const snapshotRequestRef = useRef(0);
  const profileEpochRef = useRef(0);
  const rootPathRef = useRef(preferredRootPath);
  rootPathRef.current = preferredRootPath;

  const refreshSequences = useCallback(async () => {
    const api = sequencesApi();
    if (!api?.list) return [];
    const requestId = ++listRequestRef.current;
    try {
      const result = assertSuccess(
        await api.list(),
        "Could not load sequences"
      );
      if (requestId !== listRequestRef.current) return [];
      const next = Array.isArray(result?.sequences) ? result.sequences : [];
      setSequences(next);
      setError(null);
      return next;
    } catch (nextError) {
      if (requestId === listRequestRef.current) {
        setError(nextError?.message || "Could not load sequences");
      }
      return [];
    }
  }, []);

  const loadSnapshot = useCallback(async (sequenceId) => {
    const api = sequencesApi();
    if (!api?.snapshot || !sequenceId) {
      setActiveSequence(null);
      return null;
    }
    const requestId = ++snapshotRequestRef.current;
    try {
      const result = assertSuccess(
        await api.snapshot(sequenceId, {
          preferredRootPath: rootPathRef.current,
        }),
        "Could not load this sequence"
      );
      if (requestId !== snapshotRequestRef.current) return null;
      setActiveSequence(result?.sequence ?? null);
      setError(null);
      return result?.sequence ?? null;
    } catch (nextError) {
      if (requestId === snapshotRequestRef.current) {
        setActiveSequence(null);
        setError(nextError?.message || "Could not load this sequence");
      }
      return null;
    }
  }, []);

  const selectSequence = useCallback(
    (sequenceId) => {
      const id = Number(sequenceId) || null;
      setActiveSequenceId(id);
      // Clear immediately so the strip never shows the previous sequence's
      // entries under the newly selected sequence's name.
      setActiveSequence(null);
      snapshotRequestRef.current += 1;
      if (id) loadSnapshot(id);
      return id;
    },
    [loadSnapshot]
  );

  const refreshActiveSequence = useCallback(
    () => loadSnapshot(activeSequenceId),
    [activeSequenceId, loadSnapshot]
  );

  /**
   * Run a mutation, then reload from the store rather than trusting a locally
   * patched copy: entry positions are the store's to assign, and a mutation can
   * also change whether an entry resolves to a present file.
   */
  const runMutation = useCallback(
    async (fallbackMessage, mutate) => {
      const api = sequencesApi();
      if (!api) return null;
      const profileEpoch = profileEpochRef.current;
      try {
        const result = assertSuccess(await mutate(api), fallbackMessage);
        if (profileEpoch !== profileEpochRef.current) return null;
        setError(null);
        return result;
      } catch (nextError) {
        if (profileEpoch === profileEpochRef.current) {
          setError(nextError?.message || fallbackMessage);
          throw nextError;
        }
        return null;
      }
    },
    []
  );

  const createSequence = useCallback(
    async (name) => {
      const result = await runMutation("Could not create this sequence", (api) =>
        api.create(name)
      );
      await refreshSequences();
      if (result?.sequence?.id) selectSequence(result.sequence.id);
      return result?.sequence ?? null;
    },
    [refreshSequences, runMutation, selectSequence]
  );

  const renameSequence = useCallback(
    async (sequenceId, name) => {
      const result = await runMutation("Could not rename this sequence", (api) =>
        api.rename(sequenceId, name)
      );
      await refreshSequences();
      if (sequenceId === activeSequenceId) await loadSnapshot(sequenceId);
      return result?.sequence ?? null;
    },
    [activeSequenceId, loadSnapshot, refreshSequences, runMutation]
  );

  const deleteSequence = useCallback(
    async (sequenceId) => {
      const result = await runMutation("Could not delete this sequence", (api) =>
        api.remove(sequenceId)
      );
      const remaining = await refreshSequences();
      if (sequenceId === activeSequenceId) {
        selectSequence(remaining[0]?.id ?? null);
      }
      return Boolean(result?.deleted);
    },
    [activeSequenceId, refreshSequences, runMutation, selectSequence]
  );

  const appendFingerprints = useCallback(
    async (fingerprints, sequenceId = activeSequenceId) => {
      if (!sequenceId) return null;
      const list = (Array.isArray(fingerprints)
        ? fingerprints
        : [fingerprints]
      ).filter(Boolean);
      if (!list.length) return null;
      await runMutation("Could not add these clips", (api) =>
        api.append(sequenceId, list)
      );
      await refreshSequences();
      return loadSnapshot(sequenceId);
    },
    [activeSequenceId, loadSnapshot, refreshSequences, runMutation]
  );

  const removeEntries = useCallback(
    async (entryIds) => {
      if (!activeSequenceId) return null;
      const list = (Array.isArray(entryIds) ? entryIds : [entryIds]).filter(
        (entryId) => Number.isFinite(Number(entryId))
      );
      if (!list.length) return null;
      await runMutation("Could not remove these entries", (api) =>
        api.removeEntries(activeSequenceId, list)
      );
      await refreshSequences();
      return loadSnapshot(activeSequenceId);
    },
    [activeSequenceId, loadSnapshot, refreshSequences, runMutation]
  );

  const moveEntry = useCallback(
    async (entryId, position) => {
      if (!activeSequenceId) return null;
      // Show the drop where it landed straight away; the reload below is what
      // makes it true.
      setActiveSequence((previous) => {
        if (!previous?.entries?.length) return previous;
        const from = previous.entries.findIndex(
          (entry) => entry.id === entryId
        );
        if (from === -1) return previous;
        const to = Math.min(
          Math.max(Number(position) || 0, 0),
          previous.entries.length - 1
        );
        if (to === from) return previous;
        const entries = previous.entries.slice();
        const [moved] = entries.splice(from, 1);
        entries.splice(to, 0, moved);
        return {
          ...previous,
          entries: entries.map((entry, index) => ({
            ...entry,
            position: index,
          })),
        };
      });
      try {
        await runMutation("Could not move this entry", (api) =>
          api.moveEntry(activeSequenceId, entryId, position)
        );
        return loadSnapshot(activeSequenceId);
      } catch (moveError) {
        // Reload first so the optimistic order cannot survive a refusal, then
        // restore the reason -- a successful reload would otherwise clear the
        // very error that explains why the clip snapped back.
        await loadSnapshot(activeSequenceId);
        setError(moveError?.message || "Could not move this entry");
        return null;
      }
    },
    [activeSequenceId, loadSnapshot, runMutation]
  );

  useEffect(() => {
    refreshSequences();
  }, [refreshSequences]);

  // With sequences stored but none chosen (a launch, a profile switch), pick
  // the one worked on most recently. Otherwise the picker would name one
  // sequence while the list showed nothing, and the next add would start a
  // new sequence instead of continuing the one on screen.
  useEffect(() => {
    if (activeSequenceId != null || !sequences.length) return;
    const latest = sequences.reduce((best, candidate) =>
      Number(candidate?.updatedAt) > Number(best?.updatedAt) ? candidate : best
    );
    if (latest?.id) selectSequence(latest.id);
  }, [activeSequenceId, selectSequence, sequences]);

  useEffect(() => {
    const subscribe = window.electronAPI?.profiles?.onChanged;
    if (!subscribe) return undefined;
    return subscribe(() => {
      listRequestRef.current += 1;
      snapshotRequestRef.current += 1;
      profileEpochRef.current += 1;
      setSequences([]);
      setActiveSequenceId(null);
      setActiveSequence(null);
      setError(null);
      refreshSequences();
    });
  }, [refreshSequences]);

  return {
    sequences,
    activeSequenceId,
    activeSequence,
    error,
    selectSequence,
    refreshSequences,
    refreshActiveSequence,
    createSequence,
    renameSequence,
    deleteSequence,
    appendFingerprints,
    removeEntries,
    moveEntry,
  };
}
