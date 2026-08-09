import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  REVIEW_RESULTS_TRASH_LIMIT,
  summarizeReviewScope,
} from "../review/reviewResults";
import { CopyIcon, MoveIcon } from "./UiIcons";
import "./ProcessReviewResultsDialog.css";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const COUNT_CARDS = [
  { key: "pick", label: "Accept", tone: "accept" },
  { key: "reviewed", label: "Reviewed", tone: "reviewed" },
  { key: "reject", label: "Reject", tone: "reject" },
  { key: "unreviewed", label: "Unreviewed", tone: "unreviewed" },
];

const COPY_PHASES = Object.freeze({
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

const formatBytes = (value) => {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "Size unavailable";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  const digits = amount >= 10 || unitIndex === 0 ? 0 : 1;
  return `${amount.toFixed(digits)} ${units[unitIndex]}`;
};

const normalizeCopyPlan = (value) => {
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

const normalizeCopyResult = (value, fallbackTransferMode = "copy") => {
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

export default function ProcessReviewResultsDialog({
  open,
  videos = [],
  scopeLabel = "Current folder",
  processingReady = true,
  readinessMessage = "Finish loading this folder before processing results.",
  busy = false,
  onClose,
  onTrashRejects,
  onPrepareAcceptedCopy,
  onListTransferDestinations,
  transferLayout = "structured",
  onTransferLayoutChange,
  onStartAcceptedCopy,
  onCancelAcceptedCopy,
  acceptedCopyProgress = null,
  trashProgress = null,
}) {
  const backdropRef = useRef(null);
  const dialogRef = useRef(null);
  const copyPrimaryActionRef = useRef(null);
  const actionBusyRef = useRef(false);
  const externalBusyRef = useRef(Boolean(busy));
  const openRef = useRef(Boolean(open));
  const onCloseRef = useRef(onClose);
  const onCancelAcceptedCopyRef = useRef(onCancelAcceptedCopy);
  const activePlanIdRef = useRef(null);
  const cancelRequestedPlanIdRef = useRef(null);
  const copyRequestRef = useRef(0);
  const copyOperationRef = useRef(false);
  const [pendingAction, setPendingAction] = useState(null);
  const [actionError, setActionError] = useState("");
  const [copyPhase, setCopyPhase] = useState(COPY_PHASES.IDLE);
  const [copyPlan, setCopyPlan] = useState(null);
  const [copyResult, setCopyResult] = useState(null);
  const [recentDestinations, setRecentDestinations] = useState([]);
  const [transferMode, setTransferMode] = useState("copy");
  const summary = useMemo(() => summarizeReviewScope(videos), [videos]);
  const copyBusy = [
    COPY_PHASES.PREPARING,
    COPY_PHASES.COPYING,
    COPY_PHASES.CANCELLING,
  ].includes(copyPhase);
  const copyOwnsActions = copyBusy;
  const closeBlocked = Boolean(busy || pendingAction !== null || copyBusy);
  const actionBusy = Boolean(busy || pendingAction !== null || copyOwnsActions);
  actionBusyRef.current = closeBlocked;
  externalBusyRef.current = Boolean(busy);
  openRef.current = Boolean(open);
  onCloseRef.current = onClose;
  onCancelAcceptedCopyRef.current = onCancelAcceptedCopy;

  const trashOverLimit = summary.trashableRejectCount > REVIEW_RESULTS_TRASH_LIMIT;
  const canTrash =
    processingReady &&
    !actionBusy &&
    summary.canTrashRejects &&
    typeof onTrashRejects === "function";
  const canPrepareCopy =
    processingReady &&
    !actionBusy &&
    summary.canCopyAccepted &&
    typeof onPrepareAcceptedCopy === "function" &&
    typeof onStartAcceptedCopy === "function" &&
    typeof onCancelAcceptedCopy === "function";

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
        onCancelAcceptedCopyRef.current?.(normalizedPlanId)
      ).then((result) => {
        if (result?.success === false) {
          throw new Error(result.error || "The copy could not be cancelled.");
        }
        return result;
      });
      return bestEffort ? request.catch(() => {}) : request;
    } catch (error) {
      return bestEffort ? Promise.resolve() : Promise.reject(error);
    }
  };

  const abandonActivePlan = () => {
    const planId = activePlanIdRef.current;
    activePlanIdRef.current = null;
    if (planId) requestPlanCancellation(planId);
  };

  const resetCopyWorkflow = ({ cancelPlan = false } = {}) => {
    copyRequestRef.current += 1;
    copyOperationRef.current = false;
    if (cancelPlan) abandonActivePlan();
    else activePlanIdRef.current = null;
    cancelRequestedPlanIdRef.current = null;
    setCopyPhase(COPY_PHASES.IDLE);
    setCopyPlan(null);
    setCopyResult(null);
    setTransferMode("copy");
    setActionError("");
  };

  const closeDialog = () => {
    if (actionBusyRef.current) return;
    abandonActivePlan();
    onCloseRef.current?.();
  };

  // Reload on every open so a destination recorded by the previous transfer,
  // or by another window, is offered without reopening the app.
  useEffect(() => {
    if (!open || typeof onListTransferDestinations !== "function") {
      setRecentDestinations([]);
      return undefined;
    }
    let cancelled = false;
    Promise.resolve(onListTransferDestinations())
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
  }, [open, onListTransferDestinations, copyResult]);

  useEffect(() => {
    if (!open) {
      setPendingAction(null);
      setActionError("");
      setCopyPhase(COPY_PHASES.IDLE);
      setCopyPlan(null);
      setCopyResult(null);
      setTransferMode("copy");
      return undefined;
    }

    const previousActiveElement = document.activeElement;
    const backdrop = backdropRef.current;
    const backgroundSiblings = backdrop?.parentElement
      ? Array.from(backdrop.parentElement.children)
          .filter((element) => element !== backdrop)
          .map((element) => ({
            element,
            ariaHidden: element.getAttribute("aria-hidden"),
            inert: element.hasAttribute("inert"),
          }))
      : [];
    for (const { element } of backgroundSiblings) {
      element.setAttribute("aria-hidden", "true");
      element.setAttribute("inert", "");
    }
    const dialog = dialogRef.current;
    dialog?.querySelector(FOCUSABLE_SELECTOR)?.focus?.();

    const handleKeyDown = (event) => {
      if (event.key === "Escape" && !actionBusyRef.current) {
        event.preventDefault();
        closeDialog();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR));
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      openRef.current = false;
      copyRequestRef.current += 1;
      abandonActivePlan();
      document.removeEventListener("keydown", handleKeyDown);
      for (const { element, ariaHidden, inert } of backgroundSiblings) {
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
        if (!inert) element.removeAttribute("inert");
      }
      previousActiveElement?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (
      [COPY_PHASES.READY, COPY_PHASES.COPYING, COPY_PHASES.COMPLETE]
        .includes(copyPhase)
    ) {
      copyPrimaryActionRef.current?.focus?.();
    }
  }, [copyPhase]);

  if (!open) return null;

  const runAction = async (name, action) => {
    if (actionBusyRef.current || typeof action !== "function") return;
    actionBusyRef.current = true;
    setPendingAction(name);
    setActionError("");
    try {
      await action();
    } catch (error) {
      setActionError(error?.message || "The action could not be completed.");
    } finally {
      actionBusyRef.current = externalBusyRef.current;
      setPendingAction(null);
    }
  };

  const prepareAcceptedCopy = async (
    destinationPath = null,
    layout = transferLayout,
    reusePlanId = null
  ) => {
    if (!canPrepareCopy || copyOperationRef.current) return;
    copyOperationRef.current = true;
    actionBusyRef.current = true;
    const requestId = copyRequestRef.current + 1;
    copyRequestRef.current = requestId;
    setCopyPhase(COPY_PHASES.PREPARING);
    setCopyPlan(null);
    setCopyResult(null);
    setActionError("");
    try {
      const response = await onPrepareAcceptedCopy(
        destinationPath,
        layout,
        reusePlanId
      );
      const plan = normalizeCopyPlan(response);
      if (!openRef.current || copyRequestRef.current !== requestId) {
        if (plan?.planId) requestPlanCancellation(plan.planId);
        return;
      }
      if (plan?.cancelled) {
        setCopyPhase(COPY_PHASES.IDLE);
        return;
      }
      if (!plan) {
        throw new Error(response?.error || "The copy plan could not be prepared.");
      }
      activePlanIdRef.current = plan.planId;
      cancelRequestedPlanIdRef.current = null;
      setCopyPlan(plan);
      setCopyPhase(COPY_PHASES.READY);
    } catch (error) {
      if (openRef.current && copyRequestRef.current === requestId) {
        setCopyPhase(COPY_PHASES.IDLE);
        setActionError(error?.message || "The copy plan could not be prepared.");
      }
    } finally {
      copyOperationRef.current = false;
    }
  };

  const chooseAcceptedDestination = async (
    destinationPath = null,
    layout = transferLayout
  ) => {
    if (!canPrepareCopy || copyOperationRef.current) return;
    const previousPlanId = activePlanIdRef.current;
    if (previousPlanId) {
      await requestPlanCancellation(previousPlanId);
      activePlanIdRef.current = null;
      cancelRequestedPlanIdRef.current = null;
    }
    setCopyPlan(null);
    setCopyResult(null);
    setCopyPhase(COPY_PHASES.IDLE);
    await prepareAcceptedCopy(destinationPath, layout);
  };

  // Layout changes the destination paths, so collisions have to be recomputed.
  // The already-chosen folder is reused via the plan id rather than making the
  // user pick it again.
  const changeTransferLayout = async (nextLayout) => {
    const layout = nextLayout === "flat" ? "flat" : "structured";
    if (layout === transferLayout) return;
    onTransferLayoutChange?.(layout);
    if (!copyPlan || copyPhase !== COPY_PHASES.READY) return;
    if (!canPrepareCopy || copyOperationRef.current) return;
    const reusePlanId = activePlanIdRef.current;
    activePlanIdRef.current = null;
    cancelRequestedPlanIdRef.current = null;
    await prepareAcceptedCopy(null, layout, reusePlanId);
  };

  const startAcceptedCopy = async (requestedMode) => {
    if (
      copyOperationRef.current ||
      copyPhase !== COPY_PHASES.READY ||
      !copyPlan?.canStart ||
      typeof onStartAcceptedCopy !== "function"
    ) {
      return;
    }
    copyOperationRef.current = true;
    actionBusyRef.current = true;
    const nextTransferMode = requestedMode === "move" ? "move" : "copy";
    setTransferMode(nextTransferMode);
    const requestId = copyRequestRef.current + 1;
    copyRequestRef.current = requestId;
    setCopyPhase(COPY_PHASES.COPYING);
    setActionError("");
    try {
      const response = await onStartAcceptedCopy(
        copyPlan.planId,
        nextTransferMode
      );
      if (!openRef.current || copyRequestRef.current !== requestId) return;
      const result = normalizeCopyResult(response, nextTransferMode);
      const hasTerminalCounts =
        result.cancelled ||
        result.copiedCount > 0 ||
        result.skippedCount > 0 ||
        result.missingCount > 0 ||
        result.failedCount > 0;
      const consumedPreparedPlan = result.planId === copyPlan.planId;
      const retiredPreparedPlan = consumedPreparedPlan || [
        "ACCEPTED_COPY_PLAN_EXPIRED",
        "ACCEPTED_COPY_PLAN_NOT_FOUND",
        "ACCEPTED_COPY_CLOSED",
        "ACCEPTED_COPY_PAUSED",
      ].includes(result.code);
      if (
        response?.success === false &&
        !hasTerminalCounts &&
        !retiredPreparedPlan
      ) {
        throw new Error(result.error || "Accepted clips could not be copied.");
      }
      activePlanIdRef.current = null;
      cancelRequestedPlanIdRef.current = null;
      setCopyResult(result);
      setCopyPhase(COPY_PHASES.COMPLETE);
    } catch (error) {
      if (openRef.current && copyRequestRef.current === requestId) {
        setCopyPhase(COPY_PHASES.READY);
        setActionError(error?.message || "Accepted clips could not be copied.");
      }
    } finally {
      copyOperationRef.current = false;
    }
  };

  const cancelAcceptedCopy = async () => {
    const planId = activePlanIdRef.current;
    if (!planId || ![COPY_PHASES.COPYING, COPY_PHASES.CANCELLING].includes(copyPhase)) {
      return;
    }
    setCopyPhase(COPY_PHASES.CANCELLING);
    setActionError("");
    try {
      await requestPlanCancellation(planId, { bestEffort: false });
    } catch (error) {
      cancelRequestedPlanIdRef.current = null;
      setCopyPhase(COPY_PHASES.COPYING);
      setActionError(error?.message || "The copy could not be cancelled.");
    }
  };

  const progressMatchesPlan =
    acceptedCopyProgress &&
    copyPlan?.planId &&
    acceptedCopyProgress.planId === copyPlan.planId &&
    ["copying", "complete"].includes(acceptedCopyProgress.phase);
  const progressCompleted = progressMatchesPlan
    ? boundedCount(
          acceptedCopyProgress.completedCount ??
          acceptedCopyProgress.completedFiles ??
          acceptedCopyProgress.processedCount ??
          acceptedCopyProgress.processedFiles ??
          acceptedCopyProgress.processed ??
          acceptedCopyProgress.completed
      )
    : 0;
  const fallbackProgressTotal =
    boundedCount(copyPlan?.totalFiles) || boundedCount(copyPlan?.copyableCount);
  const progressTotal = Math.max(
    1,
    progressMatchesPlan
      ? boundedCount(
          acceptedCopyProgress.totalCount ??
            acceptedCopyProgress.totalFiles ??
            acceptedCopyProgress.total
        ) ||
          fallbackProgressTotal
      : fallbackProgressTotal
  );
  const progressValue = Math.min(progressCompleted, progressTotal);

  const trashTotal = boundedCount(trashProgress?.total);
  const trashFailed = boundedCount(trashProgress?.failed);
  const trashProcessed = Math.min(
    boundedCount(trashProgress?.processed),
    trashTotal
  );

  const terminalHasIssues = Boolean(
    copyResult &&
      (copyResult.error ||
        copyResult.failedCount > 0 ||
        copyResult.missingCount > 0 ||
        copyResult.skippedCount > 0)
  );

  return (
    <div
      ref={backdropRef}
      className="review-results-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !closeBlocked) closeDialog();
      }}
    >
      <section
        ref={dialogRef}
        className="review-results-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-results-title"
        aria-describedby="review-results-description"
        data-hotkey-exempt
        tabIndex={-1}
      >
        <header className="review-results-dialog__header">
          <div className="review-results-dialog__mark" aria-hidden="true">✓</div>
          <div className="review-results-dialog__heading">
            <h2 id="review-results-title">Process review results</h2>
            <p id="review-results-description">
              {scopeLabel} · {summary.instanceCount.toLocaleString()} file
              {summary.instanceCount === 1 ? "" : "s"} · {summary.uniqueCount.toLocaleString()} unique
            </p>
          </div>
          <button
            type="button"
            className="review-results-dialog__close"
            aria-label="Close review results"
            disabled={closeBlocked}
            onClick={closeDialog}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="review-results-dialog__body">
          <div className="review-results-dialog__progress-copy">
            <strong>{summary.reviewedTotal.toLocaleString()} reviewed</strong>
            <span>{summary.instanceCount.toLocaleString()} total</span>
          </div>
          <div
            className="review-results-dialog__progress"
            role="progressbar"
            aria-label="Review progress"
            aria-valuemin="0"
            aria-valuemax={summary.instanceCount || 1}
            aria-valuenow={summary.reviewedTotal}
          >
            <span
              style={{
                width: `${summary.instanceCount
                  ? Math.min(100, (summary.reviewedTotal / summary.instanceCount) * 100)
                  : 0}%`,
              }}
            />
          </div>

          <div className="review-results-dialog__counts">
            {COUNT_CARDS.map(({ key, label, tone }) => (
              <div
                className={`review-results-count review-results-count--${tone}`}
                key={key}
              >
                <span>{label}</span>
                <strong>{summary[key].toLocaleString()}</strong>
              </div>
            ))}
          </div>

          {!processingReady && (
            <p className="review-results-dialog__notice" role="status">
              {readinessMessage}
            </p>
          )}
          {trashOverLimit && (
            <p className="review-results-dialog__notice review-results-dialog__notice--warning">
              This folder scope contains {summary.trashableRejectCount.toLocaleString()} local rejects. The safety limit is
              {` ${REVIEW_RESULTS_TRASH_LIMIT.toLocaleString()}`}; choose a smaller folder to avoid a
              partial operation. No files will be moved.
            </p>
          )}
          {summary.nonLocalRejectCount > 0 && (
            <p className="review-results-dialog__notice">
              {summary.nonLocalRejectCount.toLocaleString()} rejected file
              {summary.nonLocalRejectCount === 1 ? " is" : "s are"} not a local Electron file and cannot be moved to Bin.
            </p>
          )}
          {actionError && (
            <p className="review-results-dialog__notice review-results-dialog__notice--error" role="alert">
              {actionError}
            </p>
          )}

          <div className="review-results-dialog__actions">
            <article className="review-results-action review-results-action--danger">
              <div>
                <h3>Move rejects to Bin</h3>
                <p>
                  Process only rejected files in this folder scope. A native confirmation appears
                  before anything is moved.
                </p>
              </div>
              <button
                type="button"
                disabled={!canTrash}
                onClick={() => runAction("trash", () => onTrashRejects(summary.rejectVideos))}
              >
                {pendingAction === "trash"
                  ? "Processing…"
                  : `Move ${summary.trashableRejectCount.toLocaleString()} to Bin`}
              </button>
              {pendingAction === "trash" && trashTotal > 0 && (
                <div className="review-results-trash-progress">
                  <p aria-live="polite">
                    {`Moved ${trashProcessed.toLocaleString()} of ${trashTotal.toLocaleString()} ${
                      trashTotal === 1 ? "file" : "files"
                    } to Bin…`}
                    {trashFailed > 0
                      ? ` · ${trashFailed.toLocaleString()} failed`
                      : ""}
                  </p>
                  <div
                    className="review-results-dialog__progress review-results-dialog__progress--trash"
                    role="progressbar"
                    aria-label="Reject processing progress"
                    aria-valuemin={0}
                    aria-valuemax={trashTotal}
                    aria-valuenow={trashProcessed}
                  >
                    <span
                      style={{ width: `${(trashProcessed / trashTotal) * 100}%` }}
                    />
                  </div>
                </div>
              )}
            </article>

            <article className="review-results-action review-results-action--copy">
              <div className="review-results-action__copy-heading">
                <div>
                  <h3>Accepted clips</h3>
                  <p>
                    Send {summary.acceptedCount.toLocaleString()} accepted file
                    {summary.acceptedCount === 1 ? "" : "s"} to another folder while preserving the source folder structure.
                  </p>
                </div>
              </div>

              <div className="review-results-destination" aria-live="polite">
                <div>
                  <span>Destination</span>
                  <strong>{copyPlan?.destinationLabel || "No folder selected"}</strong>
                </div>
                <button
                  type="button"
                  className="review-results-copy-actions__secondary"
                  disabled={!canPrepareCopy || copyBusy}
                  onClick={() => chooseAcceptedDestination()}
                >
                  {copyPhase === COPY_PHASES.PREPARING
                    ? "Checking destination…"
                    : copyPlan
                      ? "Change…"
                      : "Choose destination…"}
                </button>
              </div>

              <div
                className="review-results-layout"
                role="group"
                aria-label="Destination folder layout"
              >
                {[
                  {
                    value: "structured",
                    label: "Keep folders",
                    hint: "Recreate each clip's folder path from the library root.",
                  },
                  {
                    value: "flat",
                    label: "Flat",
                    hint: "Write every clip straight into the destination. Same-named clips are reported as collisions.",
                  },
                ].map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={
                      transferLayout === option.value
                        ? "review-results-layout__option is-active"
                        : "review-results-layout__option"
                    }
                    aria-pressed={transferLayout === option.value}
                    title={option.hint}
                    disabled={!canPrepareCopy || copyBusy}
                    onClick={() => changeTransferLayout(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              {recentDestinations.length > 0 && (
                <div className="review-results-recent-destinations">
                  <span id="recent-destinations-label">Recent</span>
                  <ul aria-labelledby="recent-destinations-label">
                    {recentDestinations.map((destination) => (
                      <li key={destination.path}>
                        <button
                          type="button"
                          disabled={!canPrepareCopy || copyBusy}
                          title={destination.path}
                          onClick={() =>
                            chooseAcceptedDestination(destination.path)
                          }
                        >
                          {destination.label || destination.path}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {[COPY_PHASES.IDLE, COPY_PHASES.PREPARING].includes(copyPhase) && (
                <div className="review-results-transfer-actions">
                  <button
                    type="button"
                    className="review-results-transfer-actions__move"
                    aria-label="Move accepted clips; choose a destination first"
                    disabled
                  >
                    <MoveIcon aria-hidden="true" />
                    <span>Move</span>
                    <small>Remove originals</small>
                  </button>
                  <button
                    type="button"
                    aria-label="Copy accepted clips; choose a destination first"
                    disabled
                  >
                    <CopyIcon aria-hidden="true" />
                    <span>Copy</span>
                    <small>Keep originals</small>
                  </button>
                </div>
              )}

              {copyPhase === COPY_PHASES.READY && copyPlan && (
                <div className="review-results-copy-plan" aria-live="polite">
                  <dl className="review-results-copy-plan__facts">
                    <div><dt>Media</dt><dd>{copyPlan.mediaCount.toLocaleString()}</dd></div>
                    <div><dt>Estimated size</dt><dd>{formatBytes(copyPlan.totalBytes)}</dd></div>
                  </dl>

                  {copyPlan.collisionCount > 0 && (
                    <div className="review-results-dialog__notice review-results-dialog__notice--warning">
                      <strong>
                        {copyPlan.collisionCount.toLocaleString()} existing destination file
                        {copyPlan.collisionCount === 1 ? " will" : "s will"} be skipped.
                      </strong>
                      {copyPlan.collisionSamples.length > 0 && (
                        <ul className="review-results-copy-samples">
                          {copyPlan.collisionSamples.map((relativePath, index) => (
                            <li key={`${relativePath}:${index}`}>{relativePath}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                  {copyPlan.missingCount > 0 && (
                    <p className="review-results-dialog__notice">
                      {copyPlan.missingCount.toLocaleString()} indexed source file
                      {copyPlan.missingCount === 1 ? " is" : "s are"} missing or changed and will be skipped.
                    </p>
                  )}
                  {copyPlan.failureCount > 0 && (
                    <div className="review-results-dialog__notice review-results-dialog__notice--warning">
                      <strong>
                        {copyPlan.failureCount.toLocaleString()} additional file
                        {copyPlan.failureCount === 1 ? " could" : "s could"} not be prepared and will be skipped.
                      </strong>
                      {copyPlan.failureSamples.length > 0 && (
                        <ul className="review-results-copy-samples">
                          {copyPlan.failureSamples.map((sample, index) => (
                            <li key={`${sample.relativePath}:${index}`}>
                              {sample.relativePath}
                              {sample.message ? ` — ${sample.message}` : ""}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                  {!copyPlan.canStart && (
                    <p className="review-results-dialog__notice" role="status">
                      No files remain to transfer to this destination.
                    </p>
                  )}
                  <div className="review-results-transfer-actions">
                    <button
                      type="button"
                      className="review-results-transfer-actions__move"
                      aria-label={`Move ${copyPlan.copyableCount.toLocaleString()} file${copyPlan.copyableCount === 1 ? "" : "s"}; remove originals`}
                      disabled={!copyPlan.canStart}
                      onClick={() => startAcceptedCopy("move")}
                    >
                      <MoveIcon aria-hidden="true" />
                      <span>Move</span>
                      <small>Remove originals</small>
                    </button>
                    <button
                      ref={copyPrimaryActionRef}
                      type="button"
                      aria-label={`Copy ${copyPlan.copyableCount.toLocaleString()} file${copyPlan.copyableCount === 1 ? "" : "s"}; keep originals`}
                      disabled={!copyPlan.canStart}
                      onClick={() => startAcceptedCopy("copy")}
                    >
                      <CopyIcon aria-hidden="true" />
                      <span>Copy</span>
                      <small>Keep originals</small>
                    </button>
                  </div>
                </div>
              )}

              {[COPY_PHASES.COPYING, COPY_PHASES.CANCELLING].includes(copyPhase) && (
                <div className="review-results-copy-running">
                  <div
                    className="review-results-copy-running__status"
                    aria-live="polite"
                    aria-atomic="true"
                  >
                    <strong>
                      {copyPhase === COPY_PHASES.CANCELLING
                        ? "Finishing the current file…"
                        : `${transferMode === "move" ? "Moving" : "Copying"} ${progressValue.toLocaleString()} of ${progressTotal.toLocaleString()} ${progressTotal === 1 ? "file" : "files"}…`}
                    </strong>
                    <span>{copyPlan?.destinationLabel}</span>
                  </div>
                  <div
                    className="review-results-dialog__progress review-results-dialog__progress--copy"
                    role="progressbar"
                    aria-label={`Accepted clip ${transferMode} progress`}
                    aria-valuemin="0"
                    aria-valuemax={progressTotal}
                    aria-valuenow={progressValue}
                  >
                    <span style={{ width: `${(progressValue / progressTotal) * 100}%` }} />
                  </div>
                  <button
                    ref={copyPrimaryActionRef}
                    type="button"
                    className="review-results-copy-actions__secondary"
                    disabled={copyPhase === COPY_PHASES.CANCELLING}
                    onClick={cancelAcceptedCopy}
                  >
                    {copyPhase === COPY_PHASES.CANCELLING
                      ? "Cancel requested"
                      : `Cancel ${transferMode}`}
                  </button>
                </div>
              )}

              {copyPhase === COPY_PHASES.COMPLETE && copyResult && (
                <div
                  className={`review-results-copy-result${terminalHasIssues ? " review-results-copy-result--partial" : ""}`}
                  role={copyResult.failedCount > 0 || copyResult.error ? "alert" : "status"}
                >
                  <strong>
                    {copyResult.cancelled
                      ? `${copyResult.transferMode === "move" ? "Move" : "Copy"} cancelled`
                      : copyResult.error && copyResult.copiedCount === 0
                        ? `${copyResult.transferMode === "move" ? "Move" : "Copy"} could not be completed`
                      : terminalHasIssues
                        ? `${copyResult.transferMode === "move" ? "Move" : "Copy"} finished with issues`
                        : `${copyResult.transferMode === "move" ? "Move" : "Copy"} complete`}
                  </strong>
                  {copyResult.error && <p>{copyResult.error}</p>}
                  <p>
                    {copyResult.copiedCount.toLocaleString()} media file
                    {copyResult.copiedCount === 1 ? "" : "s"} {copyResult.transferMode === "move" ? "moved" : "copied"}
                    {copyResult.skippedCount > 0
                      ? ` · ${copyResult.skippedCount.toLocaleString()} existing skipped`
                      : ""}
                    {copyResult.failedCount > 0
                      ? ` · ${copyResult.failedCount.toLocaleString()} failed`
                      : ""}
                    {copyResult.missingCount > 0
                      ? ` · ${copyResult.missingCount.toLocaleString()} missing or changed`
                      : ""}
                  </p>
                  {copyResult.failureSamples.length > 0 && (
                    <ul className="review-results-copy-samples">
                      {copyResult.failureSamples.map((sample, index) => (
                        <li key={`${sample.relativePath}:${index}`}>
                          {sample.relativePath}
                          {sample.message ? ` — ${sample.message}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                  <button
                    ref={copyPrimaryActionRef}
                    type="button"
                    onClick={() => resetCopyWorkflow()}
                  >
                    Transfer again
                  </button>
                </div>
              )}
            </article>
          </div>
        </div>

        <footer className="review-results-dialog__footer">
          <span>Actions use the current folder before search and filter controls.</span>
          <button type="button" disabled={closeBlocked} onClick={closeDialog}>
            Done
          </button>
        </footer>
      </section>
    </div>
  );
}
