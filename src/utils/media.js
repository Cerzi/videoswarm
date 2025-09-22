// src/utils/media.js
// Utilities for aggressively releasing media resources

/**
 * Fully detach a <video> element from its sources and listeners.
 * Ensures Chromium frees decoders, file handles, and GPU resources.
 */
export function hardTeardownVideo(video, opts = {}) {
  if (!video) return;

  const {
    objectURL = null,
    listeners = [],
    mediaSource = null,
  } = opts;

  try { video.pause(); } catch {}

  if (Array.isArray(listeners)) {
    for (const [type, handler] of listeners) {
      if (!type || !handler) continue;
      try { video.removeEventListener(type, handler); } catch {}
    }
  }

  try { video.removeAttribute("src"); } catch {}
  try { video.srcObject = null; } catch {}
  try { video.src = ""; } catch {}

  const currentSrc = (() => {
    try { return typeof video.currentSrc === "string" && video.currentSrc ? video.currentSrc : video.src; }
    catch { return ""; }
  })();

  if (objectURL) {
    try { URL.revokeObjectURL(objectURL); } catch {}
  } else if (currentSrc && currentSrc.startsWith("blob:")) {
    try { URL.revokeObjectURL(currentSrc); } catch {}
  }

  if (mediaSource && typeof mediaSource.endOfStream === "function") {
    try { mediaSource.endOfStream(); } catch {}
  }

  try { video.load(); } catch {}

  try { video.remove(); } catch {}
}
