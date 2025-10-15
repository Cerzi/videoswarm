const RATE_LIMIT_MS = 100; // <= 10 captures per second
const PER_CARD_COOLDOWN_MS = 2000;
const FAILURE_COOLDOWN_MS = 2000;
const MAX_MEMORY_ENTRIES = 500;

const queue = [];
let activeCapture = false;
let lastCaptureTimestamp = 0;

const memoryCache = new Map(); // signature -> { base64, capturedAt }
const stateBySignature = new Map();
const pathToSignature = new Map();

const metrics = {
  requested: 0,
  scheduled: 0,
  attempted: 0,
  succeeded: 0,
  failures: 0,
  nativeHits: 0,
  skippedInvisible: 0,
};

function now() {
  return Date.now();
}

function remember(signature, base64) {
  if (!signature || !base64) return;
  memoryCache.delete(signature);
  memoryCache.set(signature, {
    base64,
    capturedAt: now(),
  });
  while (memoryCache.size > MAX_MEMORY_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value;
    if (!oldestKey) break;
    memoryCache.delete(oldestKey);
  }
}

function ensureState(path, signature) {
  let state = stateBySignature.get(signature);
  if (!state) {
    state = {
      path,
      pending: false,
      lastSuccess: 0,
      cooldownUntil: 0,
      lastFailureLogged: 0,
      nativeAvailable: false,
      checkedNativeAt: 0,
      lastRequested: 0,
    };
    stateBySignature.set(signature, state);
  } else if (state.path !== path) {
    state.path = path;
  }
  return state;
}

function checkNativeAvailability(state, path, signature) {
  const api = window?.electronAPI;
  if (!api?.thumbs?.get) {
    return false;
  }

  const nowTs = now();
  if (state.checkedNativeAt && nowTs - state.checkedNativeAt < 1000) {
    return state.nativeAvailable;
  }

  try {
    const response = api.thumbs.get({ path, signature });
    state.nativeAvailable = Boolean(response?.available);
    state.checkedNativeAt = nowTs;
    if (state.nativeAvailable) {
      state.lastSuccess = nowTs;
      state.cooldownUntil = nowTs + PER_CARD_COOLDOWN_MS;
      metrics.nativeHits += 1;
    }
  } catch (error) {
    // Ignore IPC failures; we'll fall back to capture attempts
    state.nativeAvailable = false;
    state.checkedNativeAt = nowTs;
  }

  return state.nativeAvailable;
}

async function waitForStableFrame(video) {
  if (!video) return;
  if (typeof video.requestVideoFrameCallback === "function") {
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        video.requestVideoFrameCallback(() => {
          done();
        });
      } catch (error) {
        done();
      }
      setTimeout(done, 180);
    });
  } else {
    await new Promise((resolve) => setTimeout(resolve, 160));
  }
}

function drawRoundedThumbnail(video, size = 96) {
  const width = Number(video?.videoWidth) || 0;
  const height = Number(video?.videoHeight) || 0;
  if (!width || !height) {
    throw new Error("Invalid video dimensions");
  }

  const ratio = Math.min(1, size / Math.max(width, height));
  const canvasWidth = Math.max(1, Math.round(width * ratio));
  const canvasHeight = Math.max(1, Math.round(height * ratio));

  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to acquire canvas context");
  }

  const radius = Math.round(Math.min(canvasWidth, canvasHeight) * 0.1);
  ctx.save();
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(0, 0, canvasWidth, canvasHeight, radius);
  } else {
    const r = radius;
    ctx.moveTo(r, 0);
    ctx.lineTo(canvasWidth - r, 0);
    ctx.quadraticCurveTo(canvasWidth, 0, canvasWidth, r);
    ctx.lineTo(canvasWidth, canvasHeight - r);
    ctx.quadraticCurveTo(canvasWidth, canvasHeight, canvasWidth - r, canvasHeight);
    ctx.lineTo(r, canvasHeight);
    ctx.quadraticCurveTo(0, canvasHeight, 0, canvasHeight - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
  }
  ctx.closePath();
  ctx.clip();

  ctx.drawImage(video, 0, 0, canvasWidth, canvasHeight);
  ctx.restore();

  const overlaySize = Math.min(canvasWidth, canvasHeight) * 0.45;
  const overlayPadding = Math.min(canvasWidth, canvasHeight) * 0.08;
  const centerX = canvasWidth / 2;
  const centerY = canvasHeight / 2;

  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
  ctx.beginPath();
  const half = overlaySize / 2;
  ctx.moveTo(centerX - half, centerY - half);
  ctx.lineTo(centerX + half, centerY);
  ctx.lineTo(centerX - half, centerY + half);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
  ctx.lineWidth = Math.max(1, overlayPadding / 2);
  ctx.beginPath();
  ctx.moveTo(overlayPadding, overlayPadding);
  ctx.lineTo(canvasWidth - overlayPadding, overlayPadding);
  ctx.lineTo(canvasWidth - overlayPadding, canvasHeight - overlayPadding);
  ctx.lineTo(overlayPadding, canvasHeight - overlayPadding);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  return canvas.toDataURL("image/png");
}

function cleanupState(signature) {
  const state = stateBySignature.get(signature);
  if (state) {
    state.pending = false;
  }
}

async function executeCapture(task) {
  const { path, signature, videoElement, isVisible } = task;
  const state = stateBySignature.get(signature);
  if (!state) {
    return;
  }

  const currentSignature = pathToSignature.get(path);
  if (currentSignature && currentSignature !== signature) {
    cleanupState(signature);
    return;
  }

  if (!videoElement || typeof videoElement !== "object") {
    cleanupState(signature);
    return;
  }

  const stillVisible = typeof isVisible === "function" ? isVisible() : true;
  if (!stillVisible) {
    metrics.skippedInvisible += 1;
    cleanupState(signature);
    return;
  }

  if (videoElement.readyState < 2) {
    cleanupState(signature);
    return;
  }

  if (videoElement.paused) {
    cleanupState(signature);
    return;
  }

  if (!videoElement.isConnected) {
    cleanupState(signature);
    return;
  }

  metrics.attempted += 1;
  try {
    await waitForStableFrame(videoElement);
    if (typeof isVisible === "function" && !isVisible()) {
      metrics.skippedInvisible += 1;
      cleanupState(signature);
      return;
    }

    const dataUrl = drawRoundedThumbnail(videoElement);
    remember(signature, dataUrl);

    const api = window?.electronAPI;
    if (!api?.thumbs?.put) {
      throw new Error("thumb:put unavailable");
    }

    const response = api.thumbs.put({
      path,
      signature,
      base64: dataUrl,
    });

    if (!response || response.ok !== true) {
      throw new Error(response?.error || "thumb:put failed");
    }

    const ts = now();
    state.nativeAvailable = true;
    state.lastSuccess = ts;
    state.cooldownUntil = ts + PER_CARD_COOLDOWN_MS;
    metrics.succeeded += 1;
  } catch (error) {
    const ts = now();
    state.cooldownUntil = ts + FAILURE_COOLDOWN_MS;
    if (!state.lastFailureLogged || ts - state.lastFailureLogged > FAILURE_COOLDOWN_MS) {
      console.warn(`[thumbs] Capture failed for ${path}:`, error);
      state.lastFailureLogged = ts;
    }
    metrics.failures += 1;
  } finally {
    cleanupState(signature);
  }
}

function runNextTask() {
  const task = queue.shift();
  if (!task) {
    activeCapture = false;
    return;
  }

  executeCapture(task)
    .catch(() => {})
    .finally(() => {
      lastCaptureTimestamp = now();
      activeCapture = false;
      processQueue();
    });
}

function processQueue() {
  if (activeCapture) return;
  if (!queue.length) return;

  const sinceLast = now() - lastCaptureTimestamp;
  const delay = Math.max(0, RATE_LIMIT_MS - sinceLast);
  activeCapture = true;
  if (delay > 0) {
    setTimeout(runNextTask, delay);
  } else {
    runNextTask();
  }
}

function enqueue(task) {
  queue.push(task);
  metrics.scheduled += 1;
  processQueue();
}

function shouldSkip(state) {
  const ts = now();
  if (state.pending) return true;
  if (state.nativeAvailable && ts < state.cooldownUntil) return true;
  if (ts < state.cooldownUntil) return true;
  return false;
}

export function signatureForVideo(video) {
  if (!video || typeof video !== "object") return null;
  const fullPath = typeof video.fullPath === "string" ? video.fullPath : null;
  if (!fullPath) return null;
  const size = Number(video.size) || 0;
  const modified = (() => {
    const value = video.dateModified;
    if (!value) return 0;
    if (value instanceof Date) return value.getTime();
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = new Date(value);
    const time = parsed.getTime();
    return Number.isFinite(time) ? time : 0;
  })();
  return `${fullPath}::${size}::${modified}`;
}

export function noteVideoMetadata(path, signature) {
  if (!path || !signature) return;
  const previousSignature = pathToSignature.get(path);
  if (previousSignature && previousSignature !== signature) {
    stateBySignature.delete(previousSignature);
    memoryCache.delete(previousSignature);
  }
  pathToSignature.set(path, signature);
}

export const thumbService = {
  metrics,
  noteVideoMetadata,
  requestCapture(options) {
    const { path, signature, videoElement, isVisible, reason = "unknown" } =
      options || {};

    if (!path || !signature || !videoElement) return;
    if (!videoElement.isConnected) return;

    const state = ensureState(path, signature);
    metrics.requested += 1;
    state.lastRequested = now();

    if (shouldSkip(state)) {
      return;
    }

    if (checkNativeAvailability(state, path, signature)) {
      return;
    }

    const visibilityOk = typeof isVisible === "function" ? isVisible() : true;
    if (!visibilityOk) {
      return;
    }

    const cacheEntry = memoryCache.get(signature);
    if (cacheEntry && cacheEntry.base64) {
      const api = window?.electronAPI;
      try {
        if (api?.thumbs?.put) {
          const response = api.thumbs.put({
            path,
            signature,
            base64: cacheEntry.base64,
          });
          if (response?.ok) {
            state.nativeAvailable = true;
            state.cooldownUntil = now() + PER_CARD_COOLDOWN_MS;
            state.lastSuccess = now();
            return;
          }
        }
      } catch (error) {
        // fall through to capture
      }
    }

    state.pending = true;
    enqueue({
      path,
      signature,
      videoElement,
      isVisible,
      reason,
    });
  },
};
