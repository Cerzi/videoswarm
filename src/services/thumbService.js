const RATE_LIMIT_MS = 100; // <= 10 captures per second
const PER_CARD_COOLDOWN_MS = 2000;
const FAILURE_COOLDOWN_MS = 2000;
const MAX_MEMORY_ENTRIES = 500;

const queue = [];
let activeCapture = false;
let lastCaptureTimestamp = 0;
let delayedTaskTimer = null;
let activeTask = null;
let suspended = false;
let generation = 1;
let taskSequence = 0;

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
  cancelled: 0,
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
      pendingTaskToken: null,
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
  const api = typeof window !== "undefined" ? window.electronAPI : null;
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

async function waitForStableFrame(task) {
  let video = task?.videoElement;
  if (!video) return;

  await new Promise((resolve) => {
    let settled = false;
    let timeoutId = null;
    let frameId = null;
    const done = () => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      task.cancelWait = null;
      video = null;
      resolve();
    };

    task.cancelWait = () => {
      if (
        frameId !== null &&
        typeof video?.cancelVideoFrameCallback === "function"
      ) {
        try {
          video.cancelVideoFrameCallback(frameId);
        } catch {}
      }
      done();
    };

    if (typeof video.requestVideoFrameCallback === "function") {
      try {
        frameId = video.requestVideoFrameCallback(done);
      } catch {
        done();
        return;
      }
      timeoutId = setTimeout(done, 180);
      return;
    }

    timeoutId = setTimeout(done, 160);
  });
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

function cleanupState(signature, taskToken = null) {
  const state = stateBySignature.get(signature);
  if (state && (taskToken === null || state.pendingTaskToken === taskToken)) {
    state.pending = false;
    state.pendingTaskToken = null;
  }
}

function isTaskCurrent(task) {
  if (
    !task ||
    task.cancelled ||
    suspended ||
    task.generation !== generation
  ) {
    return false;
  }

  const state = stateBySignature.get(task.signature);
  if (!state || state.pendingTaskToken !== task.token) return false;
  const currentSignature = pathToSignature.get(task.path);
  return !currentSignature || currentSignature === task.signature;
}

function cancelTask(task) {
  if (!task || task.cancelled) return false;
  task.cancelled = true;
  metrics.cancelled += 1;
  try {
    task.cancelWait?.();
  } catch {}
  task.cancelWait = null;
  cleanupState(task.signature, task.token);
  task.videoElement = null;
  task.isVisible = null;
  return true;
}

function finalizeTask(task) {
  if (!task) return;
  cleanupState(task.signature, task.token);
  task.videoElement = null;
  task.isVisible = null;
  task.cancelWait = null;
}

async function executeCapture(task) {
  if (!isTaskCurrent(task)) return;
  if (!task.videoElement || typeof task.videoElement !== "object") return;

  const stillVisible =
    typeof task.isVisible === "function" ? task.isVisible() : true;
  if (!stillVisible) {
    metrics.skippedInvisible += 1;
    return;
  }

  if (task.videoElement.readyState < 2) return;
  if (task.videoElement.paused) return;
  if (!task.videoElement.isConnected) return;

  metrics.attempted += 1;
  try {
    await waitForStableFrame(task);
    if (!isTaskCurrent(task)) return;
    if (typeof task.isVisible === "function" && !task.isVisible()) {
      metrics.skippedInvisible += 1;
      return;
    }

    let videoElement = task.videoElement;
    if (!videoElement?.isConnected) return;
    const dataUrl = drawRoundedThumbnail(videoElement);
    videoElement = null;
    if (!isTaskCurrent(task)) return;

    const api = typeof window !== "undefined" ? window.electronAPI : null;
    if (!api?.thumbs?.put) {
      throw new Error("thumb:put unavailable");
    }

    // Drop live renderer references before an asynchronous native write. The
    // generation check immediately above guarantees suspended/stale work never
    // starts a write after its frame wait completes.
    task.videoElement = null;
    task.isVisible = null;
    const response = await Promise.resolve(api.thumbs.put({
      path: task.path,
      signature: task.signature,
      base64: dataUrl,
    }));

    if (!isTaskCurrent(task)) return;

    if (!response || response.ok !== true) {
      throw new Error(response?.error || "thumb:put failed");
    }

    const state = stateBySignature.get(task.signature);
    if (!state || state.pendingTaskToken !== task.token) return;
    const ts = now();
    remember(task.signature, dataUrl);
    state.nativeAvailable = true;
    state.lastSuccess = ts;
    state.cooldownUntil = ts + PER_CARD_COOLDOWN_MS;
    metrics.succeeded += 1;
  } catch (error) {
    if (!isTaskCurrent(task)) return;
    const state = stateBySignature.get(task.signature);
    if (!state || state.pendingTaskToken !== task.token) return;
    const ts = now();
    state.cooldownUntil = ts + FAILURE_COOLDOWN_MS;
    if (!state.lastFailureLogged || ts - state.lastFailureLogged > FAILURE_COOLDOWN_MS) {
      console.warn(`[thumbs] Capture failed for ${task.path}:`, error);
      state.lastFailureLogged = ts;
    }
    metrics.failures += 1;
  } finally {
    finalizeTask(task);
  }
}

function runNextTask() {
  delayedTaskTimer = null;
  if (suspended) {
    activeCapture = false;
    return;
  }

  let task = queue.shift();
  while (task?.cancelled) task = queue.shift();
  if (!task) {
    activeCapture = false;
    return;
  }

  activeTask = task;
  executeCapture(task)
    .catch(() => {})
    .finally(() => {
      finalizeTask(task);
      if (activeTask !== task) return;
      activeTask = null;
      lastCaptureTimestamp = now();
      activeCapture = false;
      processQueue();
    });
}

function processQueue() {
  if (suspended) return;
  if (activeCapture) return;
  if (!queue.length) return;

  const sinceLast = now() - lastCaptureTimestamp;
  const delay = Math.max(0, RATE_LIMIT_MS - sinceLast);
  activeCapture = true;
  if (delay > 0) {
    delayedTaskTimer = setTimeout(runNextTask, delay);
  } else {
    runNextTask();
  }
}

function enqueue(task) {
  if (suspended || task.generation !== generation) {
    cancelTask(task);
    return false;
  }
  queue.push(task);
  metrics.scheduled += 1;
  processQueue();
  return true;
}

function cancelPendingWork({ advanceGeneration = true } = {}) {
  if (advanceGeneration) generation += 1;

  if (delayedTaskTimer) {
    clearTimeout(delayedTaskTimer);
    delayedTaskTimer = null;
  }

  const queuedTasks = queue.splice(0, queue.length);
  queuedTasks.forEach(cancelTask);
  if (activeTask) cancelTask(activeTask);
  activeTask = null;
  activeCapture = false;

  stateBySignature.forEach((state) => {
    state.pending = false;
    state.pendingTaskToken = null;
  });
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
  setSuspended(nextSuspended) {
    const next = Boolean(nextSuspended);
    if (next === suspended) return suspended;
    suspended = next;
    if (suspended) {
      cancelPendingWork({ advanceGeneration: true });
    } else {
      processQueue();
    }
    return suspended;
  },
  resetGeneration() {
    cancelPendingWork({ advanceGeneration: true });
    memoryCache.clear();
    stateBySignature.clear();
    pathToSignature.clear();
    lastCaptureTimestamp = 0;
    return generation;
  },
  requestCapture(options) {
    const { path, signature, videoElement, isVisible, reason = "unknown" } =
      options || {};

    if (suspended || !path || !signature || !videoElement) return false;
    if (!videoElement.isConnected) return false;

    const state = ensureState(path, signature);
    metrics.requested += 1;
    state.lastRequested = now();

    if (shouldSkip(state)) {
      return false;
    }

    if (checkNativeAvailability(state, path, signature)) {
      return false;
    }

    const visibilityOk = typeof isVisible === "function" ? isVisible() : true;
    if (!visibilityOk) {
      return false;
    }

    const cacheEntry = memoryCache.get(signature);
    if (cacheEntry && cacheEntry.base64) {
      const api = typeof window !== "undefined" ? window.electronAPI : null;
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
            return false;
          }
        }
      } catch (error) {
        // fall through to capture
      }
    }

    const task = {
      token: ++taskSequence,
      generation,
      path,
      signature,
      videoElement,
      isVisible,
      reason,
      cancelled: false,
      cancelWait: null,
    };
    state.pending = true;
    state.pendingTaskToken = task.token;
    return enqueue(task);
  },
  getDebugSnapshot() {
    return {
      suspended,
      generation,
      queued: queue.length,
      active: Boolean(activeTask),
      delayed: Boolean(delayedTaskTimer),
      pendingStates: Array.from(stateBySignature.values()).filter(
        (state) => state.pending
      ).length,
      memoryEntries: memoryCache.size,
      metadataEntries: pathToSignature.size,
    };
  },
};
