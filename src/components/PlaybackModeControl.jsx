import React from "react";
import {
  DEFAULT_PLAYBACK_MODE,
  PLAYBACK_MODES,
  normalizePlaybackMode,
} from "../playback/playbackPolicy";

const MODE_DESCRIPTIONS = Object.freeze({
  [PLAYBACK_MODES.BALANCED]:
    "Uses a conservative system-aware decoder budget based on CPU, memory and source resolution.",
  [PLAYBACK_MODES.ADAPTIVE_MOTION]:
    "Uses a higher system-aware decoder budget while retaining structural safety limits.",
  [PLAYBACK_MODES.ALL_MOTION]:
    "Requests every visible clip using the original unrestricted scheduling path; this can use substantial CPU and memory.",
  [PLAYBACK_MODES.STATIC_HOVER]:
    "Keeps still first-frame previews and plays only hovered or selected clips.",
});

export default function PlaybackModeControl({
  mode = DEFAULT_PLAYBACK_MODE,
  onModeChange,
  decision = null,
  capabilityStatus = "",
  proxyEnabled = false,
  onProxyToggle,
  proxyAvailable = true,
  disabled = false,
  workSuspended = false,
}) {
  const normalizedMode = normalizePlaybackMode(mode);
  const target = Math.max(0, Number(decision?.target) || 0);
  const safetyCap = Math.max(target, Number(decision?.safetyCap) || 0);
  const health = workSuspended ? "suspended" : decision?.health || "unknown";
  const targetLabel = workSuspended
    ? "Media paused"
    : `${target}/${safetyCap} decoder${safetyCap === 1 ? "" : "s"}`;

  return (
    <div
      className={`playback-mode-control playback-mode-control--${health}`}
      title={MODE_DESCRIPTIONS[normalizedMode]}
    >
      <div className="playback-mode-control__row">
        <label className="playback-mode-control__label">
          <span>Playback</span>
          <select
            className="select-control playback-mode-control__select"
            aria-label="Playback mode"
            value={normalizedMode}
            onChange={(event) => onModeChange?.(event.target.value)}
            disabled={disabled}
          >
            <option value={PLAYBACK_MODES.BALANCED}>Balanced</option>
            <option value={PLAYBACK_MODES.ADAPTIVE_MOTION}>
              Adaptive Motion (safety capped)
            </option>
            <option value={PLAYBACK_MODES.ALL_MOTION}>
              All Motion (uncapped)
            </option>
            <option value={PLAYBACK_MODES.STATIC_HOVER}>
              Static + Hover
            </option>
          </select>
        </label>
        <span
          className="playback-mode-control__budget"
          aria-label={`Playback target: ${targetLabel}`}
        >
          {targetLabel}
        </span>
        <button
          type="button"
          className={`playback-mode-control__proxy ${
            proxyEnabled ? "active" : ""
          }`}
          aria-label="Use generated playback proxies"
          aria-pressed={proxyEnabled}
          title="Generate bounded 720p playback proxies in the background; originals are never changed"
          onClick={() => onProxyToggle?.()}
          disabled={disabled || !proxyAvailable}
        >
          Proxy
        </button>
      </div>
      {capabilityStatus && (
        <span className="playback-mode-control__capability">
          {capabilityStatus}
        </span>
      )}
    </div>
  );
}

export { MODE_DESCRIPTIONS };
