import { PLAYBACK_MODES } from "./playbackPolicy";

// What each playback mode does, shown as the View menu's hints.
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
