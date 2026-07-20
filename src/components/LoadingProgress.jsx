import React, { useEffect, useMemo, useRef, useState } from "react";
import "./LoadingProgress.css";

const PHASE_STEPS = [
  { id: "discover", label: "Discover" },
  { id: "index", label: "Index" },
  { id: "prepare", label: "Prepare" },
];

const PHASE_DETAILS = {
  preparing: {
    step: 0,
    title: "Preparing folder",
    progressLabel: "Preparing the scan",
  },
  enumerating: {
    step: 0,
    title: "Discovering video files",
    progressLabel: "Scanning folders",
  },
  indexing: {
    step: 1,
    title: "Indexing collection",
    progressLabel: "Indexing metadata",
  },
  reconciling: {
    step: 1,
    title: "Checking library state",
    progressLabel: "Reconciling files",
  },
  enriching: {
    step: 2,
    title: "Reading video details",
    progressLabel: "Preparing videos",
  },
  finalizing: {
    step: 2,
    title: "Building the video grid",
    progressLabel: "Finalizing collection",
  },
  complete: {
    step: PHASE_STEPS.length,
    title: "Collection ready",
    progressLabel: "Complete",
  },
  cancelling: {
    step: null,
    title: "Cancelling scan",
    progressLabel: "Stopping safely",
  },
  error: {
    step: null,
    title: "Couldn’t open this collection",
    progressLabel: "Scan failed",
  },
};

const DEFAULT_STATUS = {
  phase: "preparing",
  directoriesScanned: 0,
  entriesInspected: 0,
  videosDiscovered: 0,
  completed: 0,
  total: null,
  fingerprintsReused: 0,
  warnings: 0,
};

function finiteNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function timestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(finiteNonNegative(milliseconds) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

export function formatMemoryMB(value) {
  const megabytes = Number(value);
  if (!Number.isFinite(megabytes) || megabytes <= 0) return null;
  return `${Math.round(megabytes).toLocaleString()} MB`;
}

export function formatActivity(updatedAt, now = Date.now()) {
  const updated = timestamp(updatedAt);
  if (updated === null) return "Working…";

  const seconds = Math.max(0, Math.floor((now - updated) / 1000));
  if (seconds < 2) return "Updated just now";
  if (seconds < 10) return `Updated ${seconds}s ago`;
  return `Still working · last update ${seconds}s ago`;
}

function formatError(error) {
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }
  return "The folder could not be read. Check that it is available and try again.";
}

function warningCount(warnings) {
  if (Array.isArray(warnings)) return warnings.length;
  return finiteNonNegative(warnings);
}

function relativeCurrentPath(rootPath, currentPath) {
  if (typeof currentPath !== "string" || !currentPath) return "";
  if (typeof rootPath !== "string" || !rootPath) return currentPath;

  const normalizedRoot = rootPath.replace(/[\\/]+$/, "");
  const normalizedCurrent = currentPath.replace(/[\\/]+$/, "");
  const matchesRoot =
    normalizedCurrent === normalizedRoot ||
    normalizedCurrent.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`) ||
    normalizedCurrent.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}\\`);

  if (!matchesRoot) return currentPath;
  return normalizedCurrent
    .slice(normalizedRoot.length)
    .replace(/^[\\/]+/, "") || ".";
}

function normalizeStatus(status, legacyProgress) {
  if (status) return { ...DEFAULT_STATUS, ...status };
  if (!legacyProgress) return DEFAULT_STATUS;

  const current = finiteNonNegative(legacyProgress.current);
  const total = finiteNonNegative(legacyProgress.total, 100);
  return {
    ...DEFAULT_STATUS,
    phase: total > 0 && current >= total ? "complete" : "preparing",
    completed: current,
    total,
    message: legacyProgress.stage || "",
  };
}

function getStepState(phase, stepIndex) {
  const activeStep = PHASE_DETAILS[phase]?.step;
  if (activeStep === PHASE_STEPS.length) return "complete";
  if (activeStep === null || activeStep === undefined) return "pending";
  if (stepIndex < activeStep) return "complete";
  if (stepIndex === activeStep) return "active";
  return "pending";
}

function Stat({ label, value }) {
  return (
    <div className="loading-progress__stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

const LoadingProgress = ({ status: statusProp, memoryStatus, progress, onCancel }) => {
  const status = useMemo(
    () => normalizeStatus(statusProp, progress),
    [progress, statusProp]
  );
  const [now, setNow] = useState(() => Date.now());
  const cancelButtonRef = useRef(null);
  const previousFocusRef = useRef(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    cancelButtonRef.current?.focus();

    return () => {
      const previousFocus = previousFocusRef.current;
      if (previousFocus?.isConnected && typeof previousFocus.focus === "function") {
        previousFocus.focus();
      }
    };
  }, []);

  const phase = PHASE_DETAILS[status.phase] ? status.phase : "preparing";
  const details = PHASE_DETAILS[phase];
  const isError = phase === "error" || Boolean(status.error);
  const isCancelling = phase === "cancelling";
  const completed = finiteNonNegative(status.completed);
  const total = Number(status.total);
  const hasKnownTotal = Number.isFinite(total) && total > 0;
  const boundedCompleted = hasKnownTotal ? Math.min(completed, total) : completed;
  const percentage = hasKnownTotal
    ? Math.min(100, Math.round((boundedCompleted / total) * 100))
    : null;
  const startedAt = timestamp(status.startedAt);
  const elapsed = startedAt === null ? null : formatElapsed(now - startedAt);
  const activity = formatActivity(status.updatedAt, now);
  const currentPath = relativeCurrentPath(status.rootPath, status.currentPath);
  const appMemory = formatMemoryMB(memoryStatus?.currentMemoryMB);
  const memoryLabel =
    memoryStatus?.source === "jsHeap" ? "Renderer heap" : "App memory";
  const skipped = warningCount(status.warnings);
  const stageTitle = isError
    ? PHASE_DETAILS.error.title
    : status.message || details.title;
  const progressText = hasKnownTotal
    ? `${boundedCompleted.toLocaleString()} of ${total.toLocaleString()} · ${percentage}%`
    : phase === "enumerating"
      ? `${finiteNonNegative(status.videosDiscovered).toLocaleString()} videos found so far`
      : "Working…";
  const stageMetricLabel =
    phase === "indexing" || phase === "reconciling" ? "Indexed" : "Prepared";

  return (
    <div className="loading-progress-backdrop">
      <section
        className={`loading-progress${isError ? " loading-progress--error" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-busy={!isError && phase !== "complete"}
        aria-labelledby="loading-progress-title"
        aria-describedby="loading-progress-stage"
      >
        <header className="loading-progress__header">
          <span className="loading-progress__mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <div className="loading-progress__heading">
            <h2 id="loading-progress-title">
              {isError ? "Couldn’t open collection" : "Opening collection"}
            </h2>
            {status.rootPath && (
              <p className="loading-progress__root" title={status.rootPath}>
                {status.rootPath}
              </p>
            )}
          </div>
        </header>

        <ol className="loading-progress__steps" aria-label="Loading stages">
          {PHASE_STEPS.map((step, index) => {
            const stepState = getStepState(phase, index);
            return (
              <li
                key={step.id}
                className={`loading-progress__step loading-progress__step--${stepState}`}
                aria-current={stepState === "active" ? "step" : undefined}
              >
                <span className="loading-progress__step-marker" aria-hidden="true">
                  {stepState === "complete" ? "✓" : index + 1}
                </span>
                <span>{step.label}</span>
              </li>
            );
          })}
        </ol>

        <div className="loading-progress__stage-row">
          <div>
            <p
              id="loading-progress-stage"
              className="loading-progress__stage"
              aria-live="polite"
              aria-atomic="true"
            >
              {!isError && <span className="loading-progress__activity-dot" aria-hidden="true" />}
              {stageTitle}
            </p>
            {!isError && <p className="loading-progress__heartbeat">{activity}</p>}
          </div>
          {elapsed && (
            <span className="loading-progress__elapsed" aria-label={`Elapsed ${elapsed}`}>
              {elapsed}
            </span>
          )}
        </div>

        {isError ? (
          <div className="loading-progress__error" role="alert">
            {formatError(status.error)}
          </div>
        ) : (
          <>
            <div
              className={`loading-progress__track${
                hasKnownTotal ? "" : " loading-progress__track--indeterminate"
              }`}
              role="progressbar"
              aria-label={details.progressLabel}
              aria-valuemin={hasKnownTotal ? 0 : undefined}
              aria-valuemax={hasKnownTotal ? total : undefined}
              aria-valuenow={hasKnownTotal ? boundedCompleted : undefined}
              aria-valuetext={progressText}
            >
              <span
                className="loading-progress__bar"
                style={hasKnownTotal ? { "--loading-progress-width": `${percentage}%` } : undefined}
              />
            </div>
            <div className="loading-progress__progress-copy">
              <span>{details.progressLabel}</span>
              <strong>{progressText}</strong>
            </div>
          </>
        )}

        {!isError && (
          <dl className="loading-progress__stats">
            <Stat
              label="Videos found"
              value={finiteNonNegative(status.videosDiscovered).toLocaleString()}
            />
            <Stat
              label="Folders scanned"
              value={finiteNonNegative(status.directoriesScanned).toLocaleString()}
            />
            {hasKnownTotal && (
              <Stat
                label={stageMetricLabel}
                value={`${boundedCompleted.toLocaleString()} / ${total.toLocaleString()}`}
              />
            )}
            {finiteNonNegative(status.fingerprintsReused) > 0 && (
              <Stat
                label="Metadata reused"
                value={finiteNonNegative(status.fingerprintsReused).toLocaleString()}
              />
            )}
          </dl>
        )}

        {!isError && currentPath && (
          <div className="loading-progress__current-path">
            <span>Current location</span>
            <strong title={status.currentPath}>{currentPath}</strong>
          </div>
        )}

        {!isError && skipped > 0 && (
          <p className="loading-progress__warning" role="status">
            {skipped.toLocaleString()} {skipped === 1 ? "item" : "items"} could not be read
          </p>
        )}

        <footer className="loading-progress__footer">
          <div className="loading-progress__telemetry">
            <span>
              <span aria-hidden="true">◌</span> {memoryLabel}{" "}
              {appMemory || "Measuring…"}
            </span>
          </div>
          <button
            ref={cancelButtonRef}
            type="button"
            className="loading-progress__cancel"
            onClick={onCancel}
            disabled={isCancelling}
          >
            {isError ? "Close" : isCancelling ? "Cancelling…" : "Cancel scan"}
            {!isError && !isCancelling && <kbd>Esc</kbd>}
          </button>
        </footer>
      </section>
    </div>
  );
};

export default LoadingProgress;
