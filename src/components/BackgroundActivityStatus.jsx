import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { useBackgroundActivity } from "../app/hooks/useBackgroundActivity";
import "./BackgroundActivityStatus.css";

// The status line's quiet note of background work, and its pause
// (docs/architecture/background-activity.md). Nothing shows while idle. It
// owns its updates, so they never re-render the grid.

export const ACTIVITY_LABELS = Object.freeze({
  // Generation keys and workflow facts, from one read of each file.
  prompts: "Reading clips' workflows",
  "playback-proxies": "Building playback proxies",
  "stack-frames": "Reading first frames for stacks",
  "tag-suggestions": "Learning tag suggestions",
});

const format = (value) => value.toLocaleString();

function remaining(activity) {
  return Math.max(0, activity.total - activity.done);
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
      <rect x="3.5" y="3" width="3" height="10" rx="0.6" fill="currentColor" />
      <rect x="9.5" y="3" width="3" height="10" rx="0.6" fill="currentColor" />
    </svg>
  );
}

function ActivityRow({ activity, paused }) {
  const held = paused && activity.pausable;
  const known = activity.total > 0;
  const share = known ? Math.min(100, Math.round((activity.done / activity.total) * 100)) : 0;
  return (
    <li className="background-activity__row">
      <div className="background-activity__row-text">
        <span className="background-activity__row-label">{ACTIVITY_LABELS[activity.kind]}</span>
        <span className="background-activity__row-count">
          {held ? "Paused · " : ""}
          {known ? `${format(activity.done)} / ${format(activity.total)}` : held ? "waiting" : "starting"}
        </span>
      </div>
      {known ? (
        <div className="background-activity__bar" aria-hidden="true">
          <span style={{ width: `${share}%` }} />
        </div>
      ) : null}
    </li>
  );
}

export function BackgroundActivityView({ paused, activities, onSetPaused }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const actionRef = useRef(null);
  const panelId = useId();
  const shown = activities.filter((activity) => ACTIVITY_LABELS[activity.kind]);
  const idle = !paused && shown.length === 0;

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) close(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, close]);

  useEffect(() => {
    if (open) actionRef.current?.focus();
  }, [open]);

  // Gone when the work is done, unless someone is reading the panel.
  useEffect(() => {
    if (idle && open && !rootRef.current?.contains(document.activeElement)) setOpen(false);
  }, [idle, open]);

  if (idle && !open) return null;

  const [first] = shown;
  let summary;
  if (paused) {
    summary = "Background work paused";
  } else if (first) {
    const left = remaining(first);
    summary = `${ACTIVITY_LABELS[first.kind]}${first.total > 0 ? ` · ${format(left)} left` : ""}`;
  } else {
    summary = "Background work done";
  }

  return (
    <div className="background-activity" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`background-activity__chip${paused ? " is-paused" : ""}${open ? " is-open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={paused ? "Background work is paused" : "Work running in the background"}
        onClick={() => setOpen((value) => !value)}
      >
        {paused ? (
          <PauseIcon />
        ) : (
          <span className="background-activity__spinner" aria-hidden="true" />
        )}
        <span className="background-activity__summary">{summary}</span>
        {!paused && shown.length > 1 ? (
          <span className="background-activity__more">+{shown.length - 1}</span>
        ) : null}
      </button>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="Background work"
          className="background-activity__panel"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="background-activity__heading">
            {paused ? "Background work paused" : "Working in the background"}
          </div>
          {shown.length > 0 ? (
            <ul className="background-activity__rows">
              {shown.map((activity) => (
                <ActivityRow key={activity.kind} activity={activity} paused={paused} />
              ))}
            </ul>
          ) : (
            <p className="background-activity__empty">{paused ? "Nothing waiting." : "All done."}</p>
          )}
          <div className="background-activity__footer">
            <span className="background-activity__note">
              {paused
                ? "Held until you resume or restart. Work you ask for still runs."
                : "Pausing holds this work; anything already running finishes."}
            </span>
            <button
              ref={actionRef}
              type="button"
              className="background-activity__action"
              onClick={() => onSetPaused?.(!paused)}
            >
              {paused ? "Resume" : "Pause"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function BackgroundActivityStatus() {
  const { available, paused, activities, setPaused } = useBackgroundActivity();
  if (!available) return null;
  return <BackgroundActivityView paused={paused} activities={activities} onSetPaused={setPaused} />;
}
