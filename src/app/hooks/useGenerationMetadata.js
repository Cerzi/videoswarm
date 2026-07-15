import { useCallback, useEffect, useRef, useState } from "react";

const EMPTY_STATE = Object.freeze({
  loading: false,
  found: false,
  cached: false,
  status: "idle",
  sourceKind: null,
  sourceFormat: null,
  sourceLabel: null,
  quality: null,
  readerAvailable: null,
  readerStatus: null,
  fallbackUsed: false,
  diagnostics: [],
  metadata: null,
  error: null,
  errorCode: null,
});

export const DEFAULT_GENERATION_METADATA_DEBOUNCE_MS = 150;
let generationRequestSequence = 0;

const createGenerationRequestToken = () =>
  `renderer-${Date.now().toString(36)}-${(++generationRequestSequence).toString(36)}`;

export function useGenerationMetadata({
  instanceId,
  enabled = true,
  debounceMs = DEFAULT_GENERATION_METADATA_DEBOUNCE_MS,
}) {
  const [state, setState] = useState(EMPTY_STATE);
  const requestRef = useRef(0);
  const debounceTimerRef = useRef(null);
  const activeRequestTokenRef = useRef(null);

  const clearScheduledRefresh = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const cancelActiveRequest = useCallback(() => {
    requestRef.current += 1;
    const requestToken = activeRequestTokenRef.current;
    activeRequestTokenRef.current = null;
    if (!requestToken) return;
    try {
      const cancellation = window.electronAPI?.metadata?.cancelGeneration?.(
        requestToken
      );
      cancellation?.catch?.(() => {});
    } catch {}
  }, []);

  const loadNow = useCallback(async ({ force = false } = {}) => {
    const id = Number(instanceId);
    const api = window.electronAPI?.metadata;
    if (!enabled || !Number.isSafeInteger(id) || id <= 0 || !api?.getGeneration) {
      cancelActiveRequest();
      setState(EMPTY_STATE);
      return null;
    }

    const requestId = ++requestRef.current;
    const requestToken = createGenerationRequestToken();
    activeRequestTokenRef.current = requestToken;
    setState({ ...EMPTY_STATE, loading: true, status: "loading" });
    try {
      const result = force
        ? await api.getGeneration(id, requestToken, { force: true })
        : await api.getGeneration(id, requestToken);
      if (requestId !== requestRef.current) return null;
      if (result?.success === false) {
        const error = new Error(
          result.error || "Could not read generation metadata"
        );
        error.code = result.code || "GENERATION_METADATA_ERROR";
        throw error;
      }
      const metadata = result?.metadata ?? result?.generationMetadata ?? null;
      const found = Boolean(result?.found && metadata);
      setState({
        loading: false,
        found,
        cached: Boolean(result?.cached),
        status:
          result?.status ||
          result?.payloadStatus ||
          metadata?.extractionStatus ||
          (found ? "found" : "none"),
        sourceKind:
          result?.sourceKind || result?.source?.kind || metadata?.sourceKind || null,
        sourceFormat:
          result?.sourceFormat ||
          result?.source?.format ||
          metadata?.sourceFormat ||
          null,
        sourceLabel:
          result?.sourceLabel ||
          result?.source?.label ||
          metadata?.sourceLabel ||
          null,
        quality: result?.quality || metadata?.quality || null,
        readerAvailable:
          typeof result?.readerAvailable === "boolean"
            ? result.readerAvailable
            : typeof metadata?.provenance?.readerAvailable === "boolean"
              ? metadata.provenance.readerAvailable
              : null,
        readerStatus:
          result?.readerStatus || metadata?.provenance?.readerStatus || null,
        fallbackUsed: Boolean(
          result?.fallbackUsed ||
          result?.sourceKind === "sidecar" ||
          result?.source?.kind === "sidecar" ||
          metadata?.sourceKind === "sidecar"
        ),
        diagnostics: Array.isArray(result?.diagnostics)
          ? result.diagnostics.slice(0, 64)
          : [],
        metadata: found ? metadata : null,
        error: null,
        errorCode: null,
      });
      return found ? metadata : null;
    } catch (error) {
      if (requestId === requestRef.current) {
        setState({
          ...EMPTY_STATE,
          status: "error",
          error: error?.message || "Could not read generation metadata",
          errorCode: error?.code || "GENERATION_METADATA_ERROR",
        });
      }
      return null;
    } finally {
      if (activeRequestTokenRef.current === requestToken) {
        activeRequestTokenRef.current = null;
      }
    }
  }, [cancelActiveRequest, enabled, instanceId]);

  const refresh = useCallback(() => {
    clearScheduledRefresh();
    cancelActiveRequest();
    return loadNow({ force: true });
  }, [cancelActiveRequest, clearScheduledRefresh, loadNow]);

  useEffect(() => {
    clearScheduledRefresh();
    cancelActiveRequest();

    const id = Number(instanceId);
    const api = window.electronAPI?.metadata;
    if (!enabled || !Number.isSafeInteger(id) || id <= 0 || !api?.getGeneration) {
      setState(EMPTY_STATE);
      return undefined;
    }

    setState({ ...EMPTY_STATE, loading: true, status: "loading" });
    const delay = Math.max(0, Number(debounceMs) || 0);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      loadNow();
    }, delay);

    return () => {
      clearScheduledRefresh();
      cancelActiveRequest();
    };
  }, [
    cancelActiveRequest,
    clearScheduledRefresh,
    debounceMs,
    enabled,
    instanceId,
    loadNow,
  ]);

  return { ...state, refresh };
}
