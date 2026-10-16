// Still frames for grid cards whose video is not loaded.
//
// A card shows its clip's first frame while it waits for a decoder, so cards
// scrolled back into view (or evicted to stay within the resident cap) look
// settled immediately instead of blank. The frame is taken from the card's
// own video soon after its first `loadeddata`, close to where a reloaded
// video starts, so the swap from still to motion barely shows.
//
// Capture is idle-time work: one frame per idle callback, scaled down and
// JPEG-encoded off the main thread (OffscreenCanvas.convertToBlob). Frames
// live in memory only, bounded by entry count and encoded bytes, keyed by the
// file signature so an edited file never shows its previous frame.

const DEFAULTS = Object.freeze({
  maxEntries: 2000,
  maxBytes: 64 * 1024 * 1024,
  maxPending: 32,
  maxWidth: 480,
  quality: 0.72,
});

const HAVE_CURRENT_DATA = 2;

function defaultCreateCanvas(width, height) {
  // Electron provides OffscreenCanvas. Without it (jsdom) there is no capture.
  if (typeof OffscreenCanvas !== "function") return null;
  return new OffscreenCanvas(width, height);
}

function defaultScheduleIdle(callback) {
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(callback, { timeout: 1000 });
    return;
  }
  setTimeout(callback, 50);
}

function encodeJpeg(canvas, quality) {
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type: "image/jpeg", quality });
  }
  if (typeof canvas.toBlob === "function") {
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  }
  return Promise.resolve(null);
}

export function createPosterFrameCache({
  maxEntries = DEFAULTS.maxEntries,
  maxBytes = DEFAULTS.maxBytes,
  maxPending = DEFAULTS.maxPending,
  maxWidth = DEFAULTS.maxWidth,
  quality = DEFAULTS.quality,
  createCanvas = defaultCreateCanvas,
  scheduleIdle = defaultScheduleIdle,
  createObjectURL = (blob) => URL.createObjectURL(blob),
  revokeObjectURL = (url) => URL.revokeObjectURL(url),
} = {}) {
  const entries = new Map(); // signature -> { url, bytes }, oldest first
  const pending = new Map(); // signature -> video element, oldest first
  let totalBytes = 0;
  let pumpScheduled = false;
  let capturing = false;
  let suspended = false;
  let generation = 0;

  const evictOverflow = () => {
    while (entries.size > maxEntries || totalBytes > maxBytes) {
      const oldest = entries.entries().next().value;
      if (!oldest) break;
      const [signature, entry] = oldest;
      entries.delete(signature);
      totalBytes -= entry.bytes;
      revokeObjectURL(entry.url);
    }
  };

  const store = (signature, blob) => {
    const bytes = Number(blob?.size) || 0;
    if (bytes <= 0 || bytes > maxBytes) return;
    const url = createObjectURL(blob);
    entries.set(signature, { url, bytes });
    totalBytes += bytes;
    evictOverflow();
  };

  const captureNow = async (signature, element, captureGeneration) => {
    if (!element?.isConnected || element.readyState < HAVE_CURRENT_DATA) return;
    const sourceWidth = Number(element.videoWidth) || 0;
    const sourceHeight = Number(element.videoHeight) || 0;
    if (sourceWidth <= 0 || sourceHeight <= 0) return;

    const scale = Math.min(1, maxWidth / sourceWidth);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = createCanvas(width, height);
    const context = canvas?.getContext?.("2d", {
      alpha: false,
      willReadFrequently: true,
    });
    if (!context) return;
    try {
      context.drawImage(element, 0, 0, width, height);
    } catch {
      return;
    }

    let blob = null;
    try {
      blob = await encodeJpeg(canvas, quality);
    } catch {
      blob = null;
    }
    if (!blob || captureGeneration !== generation || entries.has(signature)) {
      return;
    }
    store(signature, blob);
  };

  const schedulePump = () => {
    if (pumpScheduled || capturing || suspended || pending.size === 0) return;
    pumpScheduled = true;
    scheduleIdle(pump);
  };

  function pump() {
    pumpScheduled = false;
    if (suspended || capturing) return;
    const next = pending.entries().next().value;
    if (!next) return;
    const [signature, element] = next;
    pending.delete(signature);
    capturing = true;
    captureNow(signature, element, generation)
      .catch(() => {})
      .finally(() => {
        capturing = false;
        schedulePump();
      });
  }

  return {
    /** The still frame's object URL, or null. Marks it recently used. */
    get(signature) {
      if (!signature) return null;
      const entry = entries.get(signature);
      if (!entry) return null;
      entries.delete(signature);
      entries.set(signature, entry);
      return entry.url;
    },

    /** Queue a capture of the element's current frame, once per signature. */
    capture(signature, element) {
      if (!signature || !element || suspended) return false;
      if (entries.has(signature) || pending.has(signature)) return false;
      while (pending.size >= maxPending) {
        // The newest requests are the cards on screen now.
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
      pending.set(signature, element);
      schedulePump();
      return true;
    },

    /** Hidden or minimized windows do no capture work. */
    setSuspended(value) {
      suspended = Boolean(value);
      if (suspended) {
        pending.clear();
      } else {
        schedulePump();
      }
    },

    clear() {
      generation += 1;
      pending.clear();
      for (const entry of entries.values()) revokeObjectURL(entry.url);
      entries.clear();
      totalBytes = 0;
    },

    getSnapshot() {
      return {
        entries: entries.size,
        bytes: totalBytes,
        pending: pending.size,
        maxEntries,
        maxBytes,
        maxPending,
      };
    },
  };
}

export const posterFrames = createPosterFrameCache();
