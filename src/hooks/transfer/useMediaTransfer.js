import { useCallback, useEffect, useRef, useState } from "react";

export const COPY_PHASES = Object.freeze({
  IDLE: "idle",
  PREPARING: "preparing",
  READY: "ready",
  COPYING: "copying",
  CANCELLING: "cancelling",
  COMPLETE: "complete",
});

const boundedCount = (value) => {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
};

const destinationDisplayName = (value) => {
  const parts = String(value || "Selected folder")
    .split(/[\\/]+/)
    .filter(Boolean);
  return parts.at(-1) || "Selected folder";
};

const safeRelativePath = (value) => {
  const text = typeof value === "string"
    ? value
    : typeof value?.relativePath === "string"
      ? value.relativePath
      : "";
  const trimmed = text.trim();
  if (
    !trimmed ||
    trimmed.includes("\0") ||
    /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(trimmed) ||
    trimmed.split(/[\\/]+/).some((part) => part === "..")
  ) {
    return null;
  }
  return trimmed.replace(/\\/g, "/");
};

const boundedRelativeSamples = (values, limit = 6) =>
  (Array.isArray(values) ? values : [])
    .map(safeRelativePath)
    .filter(Boolean)
    .slice(0, limit);

const boundedIssueSamples = (values, limit = 6) =>
  (Array.isArray(values) ? values : [])
    .map((value) => {
      const relativePath = safeRelativePath(value);
      if (!relativePath) return null;
      const message = typeof value?.message === "string"
        ? value.message.trim().slice(0, 240)
        : "";
      return { relativePath, message };
    })
    .filter(Boolean)
    .slice(0, limit);

export const normalizeCopyPlan = (value) => {
  if (!value || typeof value !== "object") return null;
  if (value.cancelled || value.canceled) return { cancelled: true };
  const planId = typeof value.planId === "string" ? value.planId.trim() : "";
  if (!planId) return null;
  const mediaCount = boundedCount(value.mediaCount);
  const collisionCount = boundedCount(value.collisionCount);
  const copyableCount = Number.isFinite(Number(value.copyableCount))
    ? boundedCount(value.copyableCount)
    : Math.max(0, mediaCount - collisionCount);
  return {
    planId,
    destinationLabel: destinationDisplayName(value.destinationLabel),
    mediaCount,
    totalBytes: Math.max(0, Number(value.totalBytes) || 0),
    collisionCount,
    collisionSamples: boundedRelativeSamples(value.collisionSamples),
    missingCount: boundedCount(value.missingCount),
    failureCount: boundedCount(value.failureCount),
    failureSamples: boundedIssueSamples(value.failureSamples),
    totalFiles: boundedCount(value.totalFiles),
    copyableCount,
    canStart: value.canStart !== false && copyableCount > 0,
  };
};

export const normalizeCopyResult = (value, fallbackTransferMode = "copy") => {
  const result = value && typeof value === "object" ? value : {};
  return {
    transferMode:
      result.transferMode === "move" || fallbackTransferMode === "move"
        ? "move"
        : "copy",
    cancelled: Boolean(result.cancelled || result.canceled),
    copiedCount: boundedCount(
      result.copiedCount ?? result.copiedMedia ?? result.copied
    ),
    skippedCount: boundedCount(
      result.skippedExistingCount ?? result.skippedCount ?? result.skipped
    ),
    missingCount: boundedCount(result.missingCount ?? result.missing),
    failedCount: boundedCount(result.failedCount ?? result.failures),
    failureSamples: boundedIssueSamples(result.failureSamples),
    error: typeof result.error === "string" ? result.error : "",
    code: typeof result.code === "string" ? result.code : "",
    planId: typeof result.planId === "string" ? result.planId : "",
  };
};

/**
 * Destination selection, preflight, layout, progress and completion for a
 * bounded media transfer.
 *
 * This is shared by the review-results flow and by transfers of an arbitrary
 * selection. Both talk to the same native coordinator, so keeping one
 * implementation is what stops collision reporting, cancellation semantics and
 * partial-result wording from drifting between them.
 */
export function useMediaTransfer({
  open = false,
  enabled = false,
  onPrepare,
  onStart,
  onCancel,
  onListDestinations,
  layout = "structured",
  onLayoutChange,
  progress = null,
  onError,
} = {}) {
  const [phase, setPhase] = useState(COPY_PHASES.IDLE);
  const [plan, setPlan] = useState(null);
  const [result, setResult] = useState(null);
  const [transferMode, setTransferMode] = useState("copy");
  const [recentDestinations, setRecentDestinations] = useState([]);

  const primaryActionRef = useRef(null);
  const activePlanIdRef = useRef(null);
  const cancelRequestedPlanIdRef = useRef(null);
  const requestRef = useRef(0);
  const operationRef = useRef(false);
  const openRef = useRef(Boolean(open));
  const onCancelRef = useRef(onCancel);
  const onErrorRef = useRef(onError);
  openRef.current = Boolean(open);
  onCancelRef.current = onCancel;
  onErrorRef.current = onError;

  const busy = [
    COPY_PHASES.PREPARING,
    COPY_PHASES.COPYING,
    COPY_PHASES.CANCELLING,
  ].includes(phase);
  // A click starts work before React re-renders, so the ref closes the gap for
  // synchronous guards such as an Escape handler.
  const busyRef = useRef(busy);
  busyRef.current = busy || operationRef.current;

  const reportError = (message) => onErrorRef.current?.(message);

  const requestPlanCancellation = (planId, { bestEffort = true } = {}) => {
    const normalizedPlanId = typeof planId === "string" ? planId : "";
    if (
      !normalizedPlanId ||
      cancelRequestedPlanIdRef.current === normalizedPlanId
    ) {
      return Promise.resolve();
    }
    cancelRequestedPlanIdRef.current = normalizedPlanId;
    try {
      const request = Promise.resolve(
        onCancelRef.current?.(normalizedPlanId)
      ).then((response) => {
        if (response?.success === false) {
          throw new Error(response.error || "The copy could not be cancelled.");
        }
        return response;
      });
      return bestEffort ? request.catch(() => {}) : request;
    } catch (error) {
      return bestEffort ? Promise.resolve() : Promise.reject(error);
    }
  };

  // Also invalidates any in-flight prepare/start so a response that lands
  // after teardown cannot revive a plan the caller has already walked away
  // from. Called on close and on unmount.
  const abandonActivePlan = useCallback(() => {
    requestRef.current += 1;
    const planId = activePlanIdRef.current;
    activePlanIdRef.current = null;
    if (planId) requestPlanCancellation(planId);
  }, []);

  const reset = ({ cancelPlan = false } = {}) => {
    requestRef.current += 1;
    operationRef.current = false;
    if (cancelPlan) abandonActivePlan();
    else activePlanIdRef.current = null;
    cancelRequestedPlanIdRef.current = null;
    setPhase(COPY_PHASES.IDLE);
    setPlan(null);
    setResult(null);
    setTransferMode("copy");
    reportError("");
  };

  // Reload on every open so a destination recorded by the previous transfer,
  // or by another window, is offered without reopening the app.
  useEffect(() => {
    if (!open || typeof onListDestinations !== "function") {
      setRecentDestinations([]);
      return undefined;
    }
    let cancelled = false;
    Promise.resolve(onListDestinations())
      .then((destinations) => {
        if (cancelled) return;
        setRecentDestinations(
          Array.isArray(destinations)
            ? destinations.filter(
                (entry) => entry && typeof entry.path === "string"
              )
            : []
        );
      })
      .catch(() => {
        if (!cancelled) setRecentDestinations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, onListDestinations, result]);

  useEffect(() => {
    if (open) return undefined;
    setPhase(COPY_PHASES.IDLE);
    setPlan(null);
    setResult(null);
    setTransferMode("copy");
    return undefined;
  }, [open]);

  const prepare = async (
    destinationPath = null,
    nextLayout = layout,
    reusePlanId = null
  ) => {
    if (!enabled || operationRef.current) return;
    operationRef.current = true;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setPhase(COPY_PHASES.PREPARING);
    setPlan(null);
    setResult(null);
    reportError("");
    try {
      const response = await onPrepare?.(
        destinationPath,
        nextLayout,
        reusePlanId
      );
      const prepared = normalizeCopyPlan(response);
      if (!openRef.current || requestRef.current !== requestId) {
        if (prepared?.planId) requestPlanCancellation(prepared.planId);
        return;
      }
      if (prepared?.cancelled) {
        setPhase(COPY_PHASES.IDLE);
        return;
      }
      if (!prepared) {
        throw new Error(
          response?.error || "The copy plan could not be prepared."
        );
      }
      activePlanIdRef.current = prepared.planId;
      cancelRequestedPlanIdRef.current = null;
      setPlan(prepared);
      setPhase(COPY_PHASES.READY);
    } catch (error) {
      if (openRef.current && requestRef.current === requestId) {
        setPhase(COPY_PHASES.IDLE);
        reportError(error?.message || "The copy plan could not be prepared.");
      }
    } finally {
      operationRef.current = false;
    }
  };

  const chooseDestination = async (
    destinationPath = null,
    nextLayout = layout
  ) => {
    if (!enabled || operationRef.current) return;
    const previousPlanId = activePlanIdRef.current;
    if (previousPlanId) {
      await requestPlanCancellation(previousPlanId);
      activePlanIdRef.current = null;
      cancelRequestedPlanIdRef.current = null;
    }
    setPlan(null);
    setResult(null);
    setPhase(COPY_PHASES.IDLE);
    await prepare(destinationPath, nextLayout);
  };

  // Layout changes the destination paths, so collisions have to be recomputed.
  // The already-chosen folder is reused via the plan id rather than making the
  // user pick it again.
  const changeLayout = async (nextLayout) => {
    const resolved = nextLayout === "flat" ? "flat" : "structured";
    if (resolved === layout) return;
    onLayoutChange?.(resolved);
    if (!plan || phase !== COPY_PHASES.READY) return;
    if (!enabled || operationRef.current) return;
    const reusePlanId = activePlanIdRef.current;
    activePlanIdRef.current = null;
    cancelRequestedPlanIdRef.current = null;
    await prepare(null, resolved, reusePlanId);
  };

  const start = async (requestedMode) => {
    if (
      operationRef.current ||
      phase !== COPY_PHASES.READY ||
      !plan?.canStart ||
      typeof onStart !== "function"
    ) {
      return;
    }
    operationRef.current = true;
    busyRef.current = true;
    const nextTransferMode = requestedMode === "move" ? "move" : "copy";
    setTransferMode(nextTransferMode);
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setPhase(COPY_PHASES.COPYING);
    reportError("");
    try {
      const response = await onStart(plan.planId, nextTransferMode);
      if (!openRef.current || requestRef.current !== requestId) return;
      const normalized = normalizeCopyResult(response, nextTransferMode);
      const hasTerminalCounts =
        normalized.cancelled ||
        normalized.copiedCount > 0 ||
        normalized.skippedCount > 0 ||
        normalized.missingCount > 0 ||
        normalized.failedCount > 0;
      const consumedPreparedPlan = normalized.planId === plan.planId;
      const retiredPreparedPlan = consumedPreparedPlan || [
        "ACCEPTED_COPY_PLAN_EXPIRED",
        "ACCEPTED_COPY_PLAN_NOT_FOUND",
        "ACCEPTED_COPY_CLOSED",
        "ACCEPTED_COPY_PAUSED",
      ].includes(normalized.code);
      if (
        response?.success === false &&
        !hasTerminalCounts &&
        !retiredPreparedPlan
      ) {
        throw new Error(
          normalized.error || "Accepted clips could not be copied."
        );
      }
      activePlanIdRef.current = null;
      cancelRequestedPlanIdRef.current = null;
      setResult(normalized);
      setPhase(COPY_PHASES.COMPLETE);
    } catch (error) {
      if (openRef.current && requestRef.current === requestId) {
        setPhase(COPY_PHASES.READY);
        reportError(error?.message || "Accepted clips could not be copied.");
      }
    } finally {
      operationRef.current = false;
    }
  };

  const cancel = async () => {
    const planId = activePlanIdRef.current;
    if (
      !planId ||
      ![COPY_PHASES.COPYING, COPY_PHASES.CANCELLING].includes(phase)
    ) {
      return;
    }
    setPhase(COPY_PHASES.CANCELLING);
    reportError("");
    try {
      await requestPlanCancellation(planId, { bestEffort: false });
    } catch (error) {
      cancelRequestedPlanIdRef.current = null;
      setPhase(COPY_PHASES.COPYING);
      reportError(error?.message || "The copy could not be cancelled.");
    }
  };

  const progressMatchesPlan =
    progress &&
    plan?.planId &&
    progress.planId === plan.planId &&
    ["copying", "complete"].includes(progress.phase);
  const progressCompleted = progressMatchesPlan
    ? boundedCount(
        progress.completedCount ??
          progress.completedFiles ??
          progress.processedCount ??
          progress.processedFiles ??
          progress.processed ??
          progress.completed
      )
    : 0;
  const fallbackProgressTotal =
    boundedCount(plan?.totalFiles) || boundedCount(plan?.copyableCount);
  const progressTotal = Math.max(
    1,
    progressMatchesPlan
      ? boundedCount(
          progress.totalCount ?? progress.totalFiles ?? progress.total
        ) || fallbackProgressTotal
      : fallbackProgressTotal
  );
  const progressValue = Math.min(progressCompleted, progressTotal);

  const terminalHasIssues = Boolean(
    result &&
      (result.error ||
        result.failedCount > 0 ||
        result.missingCount > 0 ||
        result.skippedCount > 0)
  );

  return {
    phase,
    plan,
    result,
    transferMode,
    recentDestinations,
    busy,
    busyRef,
    primaryActionRef,
    layout,
    enabled,
    progressTotal,
    progressValue,
    terminalHasIssues,
    prepare,
    chooseDestination,
    changeLayout,
    start,
    cancel,
    reset,
    abandonActivePlan,
  };
}
