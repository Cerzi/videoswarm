import { PLAYBACK_MODES } from "./playbackPolicy";

// The playback modes as the View menu and Preferences list them.
export const PLAYBACK_MODE_OPTIONS = Object.freeze([
  { value: PLAYBACK_MODES.BALANCED, label: "Balanced" },
  { value: PLAYBACK_MODES.ADAPTIVE_MOTION, label: "Adaptive Motion (safety capped)" },
  { value: PLAYBACK_MODES.ALL_MOTION, label: "All Motion (uncapped)" },
  { value: PLAYBACK_MODES.STATIC_HOVER, label: "Static + Hover" },
]);

// What each playback mode does: the View menu's hints, Preferences' text.
export const MODE_DESCRIPTIONS = Object.freeze({
  [PLAYBACK_MODES.BALANCED]:
    "Uses a conservative system-aware decoder budget based on CPU, memory and source resolution.",
  [PLAYBACK_MODES.ADAPTIVE_MOTION]:
    "Uses a higher system-aware decoder budget while retaining structural safety limits.",
  [PLAYBACK_MODES.ALL_MOTION]:
    "Requests every visible clip using the original unrestricted scheduling path; this can use substantial CPU and memory.",
  [PLAYBACK_MODES.STATIC_HOVER]:
    "Keeps still first-frame previews and plays only hovered or selected clips.",
});
