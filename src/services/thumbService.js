const RATE_LIMIT_MS = 100; // <= 10 native lookups/captures per second
const PER_CARD_COOLDOWN_MS = 2000;
const FAILURE_COOLDOWN_MS = 2000;
const NATIVE_LOOKUP_TIMEOUT_MS = 1500;
const NATIVE_WRITE_TIMEOUT_MS = 3000;

export const THUMB_SERVICE_LIMITS = Object.freeze({
  maxPending: 64,
  maxMetadataEntries: 2048,
});

const queue = [];
const tasksByToken = new Map();
const taskTokensByOwner = new Map();
const stateBySignature = new Map();
const pathToSignature = new Map();

let activeCapture = false;
let lastCaptureTimestamp = 0;
let delayedTaskTimer = null;
let activeTask = null;
let suspended = false;
let generation = 1;
let taskSequence = 0;

const metrics = {
  requested: 0,
  scheduled: 0,
  attempted: 0,
  succeeded: 0,
  failures: 0,
  nativeHits: 0,
  skippedInvisible: 0,
  cancelled: 0,
  overflowed: 0,
};

function now() {
  return Date.now();
}

function withTimeout(promise, timeoutMs, label) {
  let timeoutId = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`${label} timed out`)),
        timeoutMs
      );
    }),
  ]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function removeMetadataEntry(path, signature) {
  if (pathToSignature.get(path) === signature) {
    pathToSignature.delete(path);
  }
  const state = stateBySignature.get(signature);
  if (state && !state.pending) stateBySignature.delete(signature);
}

function trimMetadata() {
  let attempts = 0;
  while (
    pathToSignature.size > THUMB_SERVICE_LIMITS.maxMetadataEntries &&
    attempts <= pathToSignature.size
  ) {
    const oldest = pathToSignature.entries().next().value;
    if (!oldest) break;
    const [path, signature] = oldest;
    const state = stateBySignature.get(signature);
    if (state?.pending) {
      pathToSignature.delete(path);
      pathToSignature.set(path, signature);
      attempts += 1;
      continue;
    }
    removeMetadataEntry(path, signature);
    attempts = 0;
  }

  attempts = 0;
  while (
    stateBySignature.size > THUMB_SERVICE_LIMITS.maxMetadataEntries &&
    attempts <= stateBySignature.size
  ) {
    const oldest = stateBySignature.entries().next().value;
    if (!oldest) break;
    const [signature, state] = oldest;
    if (state.pending) {
      stateBySignature.delete(signature);
      stateBySignature.set(signature, state);
      attempts += 1;
      continue;
    }
    stateBySignature.delete(signature);
    if (pathToSignature.get(state.path) === signature) {
      pathToSignature.delete(state.path);
    }
    attempts = 0;
  }
}

function touchMetadata(path, signature, state = null) {
  if (pathToSignature.get(path) === signature) pathToSignature.delete(path);
  pathToSignature.set(path, signature);
  if (state) {
    stateBySignature.delete(signature);
    stateBySignature.set(signature, state);
  }
  trimMetadata();
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
  } else if (state.path !== path) {
    state.path = path;
  }
  touchMetadata(path, signature, state);
  return state;
}

function cleanupState(signature, taskToken = null) {
  const state = stateBySignature.get(signature);
  if (state && (taskToken === null || state.pendingTaskToken === taskToken)) {
    state.pending = false;
    state.pendingTaskToken = null;
  }
}

function releaseRendererReferences(task) {
  if (!task) return;
  task.elementRef = null;
  task.isVisible = null;
  task.cancelWait = null;
}

function removeOwnerToken(owner, token) {
  if (owner == null) return;
  const tokens = taskTokensByOwner.get(owner);
  if (!tokens) return;
  tokens.delete(token);
  if (!tokens.size) taskTokensByOwner.delete(owner);
}

function settleTask(task, result) {
  if (!task || task.settled) return false;
  task.settled = true;
  cleanupState(task.signature, task.token);
  tasksByToken.delete(task.token);
  removeOwnerToken(task.owner, task.token);
  releaseRendererReferences(task);
  task.resolveDone?.(
    Object.freeze({
      token: task.token,
      path: task.path,
      signature: task.signature,
      ...result,
    })
  );
  task.resolveDone = null;
  trimMetadata();
  return true;
}

function isTaskCurrent(task) {
  if (
    !task ||
    task.settled ||
    task.cancelled ||
    suspended ||
    task.generation !== generation ||
    tasksByToken.get(task.token) !== task
  ) {
    return false;
  }

  const state = stateBySignature.get(task.signature);
  if (!state || state.pendingTaskToken !== task.token) return false;
  return pathToSignature.get(task.path) === task.signature;
}

function cancelTask(task, reason = "cancelled") {
  if (!task || task.settled || task.cancelled) return false;
  task.cancelled = true;
  metrics.cancelled += 1;
  try {
    task.cancelWait?.();
  } catch {}
  task.cancelWait = null;
  settleTask(task, { status: "cancelled", reason });
  return true;
}

function cancelRequest(requestOrToken, reason = "request-cancelled") {
  const token =
    typeof requestOrToken === "number"
      ? requestOrToken
      : Number(requestOrToken?.token);
  if (!Number.isFinite(token)) return false;
  const task = tasksByToken.get(token);
  if (!task) return false;

  const queuedIndex = queue.indexOf(task);
  if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
  const cancelled = cancelTask(task, reason);
  if (!activeCapture) processQueue();
  return cancelled;
}

function cancelOwner(owner, reason = "owner-cancelled") {
  if (owner == null) return 0;
  const tokens = taskTokensByOwner.get(owner);
  if (!tokens?.size) return 0;
  let cancelled = 0;
  for (const token of Array.from(tokens)) {
    if (cancelRequest(token, reason)) cancelled += 1;
  }
  return cancelled;
}

async function waitForStableFrame(task, sourceVideo) {
  let video = sourceVideo;
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
  if (!width || !height) throw new Error("Invalid video dimensions");

  const ratio = Math.min(1, size / Math.max(width, height));
  const canvasWidth = Math.max(1, Math.round(width * ratio));
  const canvasHeight = Math.max(1, Math.round(height * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to acquire canvas context");

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

async function checkNativeAvailability(task, state) {
  const api = typeof window !== "undefined" ? window.electronAPI : null;
  if (!api?.thumbs?.get) return false;

  const nowTs = now();
  if (state.checkedNativeAt && nowTs - state.checkedNativeAt < 1000) {
    return state.nativeAvailable;
  }

  try {
    const response = await withTimeout(
      api.thumbs.get({ path: task.path, signature: task.signature }),
      NATIVE_LOOKUP_TIMEOUT_MS,
      "thumb:get"
    );
    if (!isTaskCurrent(task)) return false;
    state.nativeAvailable = Boolean(response?.available);
    state.checkedNativeAt = now();
    if (state.nativeAvailable) {
      state.lastSuccess = state.checkedNativeAt;
      state.cooldownUntil = state.checkedNativeAt + PER_CARD_COOLDOWN_MS;
      metrics.nativeHits += 1;
    }
  } catch {
    if (!isTaskCurrent(task)) return false;
    state.nativeAvailable = false;
    state.checkedNativeAt = now();
  }
  return state.nativeAvailable;
}

async function executeCapture(task) {
  if (!isTaskCurrent(task)) return { status: "cancelled", reason: "stale" };
  const state = stateBySignature.get(task.signature);
  if (!state) return { status: "cancelled", reason: "metadata-evicted" };

  if (await checkNativeAvailability(task, state)) {
    return { status: "native-hit" };
  }
  if (!isTaskCurrent(task)) return { status: "cancelled", reason: "stale" };

  let videoElement = task.elementRef?.deref?.() || null;
  const stillVisible =
    typeof task.isVisible === "function" ? task.isVisible() : true;
  if (!stillVisible) {
    metrics.skippedInvisible += 1;
    videoElement = null;
    return { status: "skipped", reason: "invisible" };
  }
  if (!videoElement?.isConnected) {
    videoElement = null;
    return { status: "skipped", reason: "detached" };
  }
  if (videoElement.readyState < 2 || videoElement.paused) {
    videoElement = null;
    return { status: "skipped", reason: "not-playing" };
  }

  metrics.attempted += 1;
  try {
    await waitForStableFrame(task, videoElement);
    if (!isTaskCurrent(task)) {
      videoElement = null;
      return { status: "cancelled", reason: "stale" };
    }
    if (typeof task.isVisible === "function" && !task.isVisible()) {
      metrics.skippedInvisible += 1;
      videoElement = null;
      return { status: "skipped", reason: "invisible" };
    }
    if (!videoElement?.isConnected) {
      videoElement = null;
      return { status: "skipped", reason: "detached" };
    }

    const dataUrl = drawRoundedThumbnail(videoElement);
    videoElement = null;
    if (!isTaskCurrent(task)) {
      return { status: "cancelled", reason: "stale" };
    }

    const api = typeof window !== "undefined" ? window.electronAPI : null;
    if (!api?.thumbs?.put) throw new Error("thumb:put unavailable");

    // Never retain a renderer media node while native I/O is in flight.
    releaseRendererReferences(task);
    const response = await withTimeout(
      api.thumbs.put({
        path: task.path,
        signature: task.signature,
        base64: dataUrl,
      }),
      NATIVE_WRITE_TIMEOUT_MS,
      "thumb:put"
    );
    if (!isTaskCurrent(task)) {
      return { status: "cancelled", reason: "stale" };
    }
    if (!response || response.ok !== true) {
      throw new Error(response?.error || "thumb:put failed");
    }

    const ts = now();
    state.nativeAvailable = true;
    state.lastSuccess = ts;
    state.cooldownUntil = ts + PER_CARD_COOLDOWN_MS;
    metrics.succeeded += 1;
    return { status: "succeeded" };
  } catch (error) {
    videoElement = null;
    if (!isTaskCurrent(task)) {
      return { status: "cancelled", reason: "stale" };
    }
    const ts = now();
    state.cooldownUntil = ts + FAILURE_COOLDOWN_MS;
    if (
      !state.lastFailureLogged ||
      ts - state.lastFailureLogged > FAILURE_COOLDOWN_MS
    ) {
      console.warn(`[thumbs] Capture failed for ${task.path}:`, error);
      state.lastFailureLogged = ts;
    }
    metrics.failures += 1;
    return { status: "failed", error: error?.message || String(error) };
  }
}

function runNextTask() {
  delayedTaskTimer = null;
  if (suspended) {
    activeCapture = false;
    return;
  }

  let task = queue.shift();
  while (task?.settled || task?.cancelled) task = queue.shift();
  if (!task) {
    activeCapture = false;
    return;
  }

  activeTask = task;
  executeCapture(task)
    .then((result) => settleTask(task, result))
    .catch((error) =>
      settleTask(task, {
        status: "failed",
        error: error?.message || String(error),
      })
    )
    .finally(() => {
      if (activeTask !== task) return;
      activeTask = null;
      lastCaptureTimestamp = now();
      activeCapture = false;
      processQueue();
    });
}

function processQueue() {
  if (suspended || activeCapture || !queue.length) return;
  const sinceLast = now() - lastCaptureTimestamp;
  const delay = Math.max(0, RATE_LIMIT_MS - sinceLast);
  activeCapture = true;
  delayedTaskTimer = delay > 0 ? setTimeout(runNextTask, delay) : null;
  if (!delayedTaskTimer) runNextTask();
}

function makeImmediateHandle(status, details = {}) {
  const result = Object.freeze({ status, ...details });
  return Object.freeze({
    accepted: false,
    token: null,
    done: Promise.resolve(result),
    cancel: () => false,
  });
}

function createTask(options) {
  const token = ++taskSequence;
  let resolveDone = null;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const task = {
    token,
    generation,
    path: options.path,
    signature: options.signature,
    owner: options.owner ?? null,
    elementRef: new WeakRef(options.videoElement),
    isVisible: options.isVisible,
    reason: options.reason,
    cancelled: false,
    settled: false,
    cancelWait: null,
    resolveDone,
  };
  const handle = Object.freeze({
    accepted: true,
    token,
    done,
    cancel: () => cancelRequest(token),
  });
  return { task, handle };
}

function enqueue(task) {
  tasksByToken.set(task.token, task);
  if (task.owner != null) {
    const tokens = taskTokensByOwner.get(task.owner) || new Set();
    tokens.add(task.token);
    taskTokensByOwner.set(task.owner, tokens);
  }
  queue.push(task);
  metrics.scheduled += 1;
  processQueue();
}

function cancelPendingWork({ advanceGeneration = true } = {}) {
  if (advanceGeneration) generation += 1;
  if (delayedTaskTimer) {
    clearTimeout(delayedTaskTimer);
    delayedTaskTimer = null;
    activeCapture = false;
  }

  for (const task of queue.splice(0, queue.length)) {
    cancelTask(task, "generation-reset");
  }
  if (activeTask) cancelTask(activeTask, "generation-reset");
  stateBySignature.forEach((state) => {
    state.pending = false;
    state.pendingTaskToken = null;
  });
}

function shouldSkip(state) {
  const timestamp = now();
  return Boolean(state.pending || timestamp < state.cooldownUntil);
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
    const previousState = stateBySignature.get(previousSignature);
    if (previousState?.pendingTaskToken) {
      cancelRequest(previousState.pendingTaskToken, "signature-changed");
    }
    removeMetadataEntry(path, previousSignature);
  }
  ensureState(path, signature);
}

export const thumbService = {
  metrics,
  limits: THUMB_SERVICE_LIMITS,
  noteVideoMetadata,
  cancelRequest,
  cancelOwner,
  setSuspended(nextSuspended) {
    const next = Boolean(nextSuspended);
    if (next === suspended) return suspended;
    suspended = next;
    if (suspended) cancelPendingWork({ advanceGeneration: true });
    else processQueue();
    return suspended;
  },
  resetGeneration() {
    cancelPendingWork({ advanceGeneration: true });
    stateBySignature.clear();
    pathToSignature.clear();
    lastCaptureTimestamp = 0;
    return generation;
  },
  requestCapture(options) {
    const {
      path,
      signature,
      videoElement,
      isVisible,
      owner = null,
      reason = "unknown",
    } = options || {};
    metrics.requested += 1;

    if (suspended || !path || !signature || !videoElement) {
      return makeImmediateHandle("rejected", { reason: "invalid-or-suspended" });
    }
    if (!videoElement.isConnected) {
      return makeImmediateHandle("rejected", { reason: "detached" });
    }

    const state = ensureState(path, signature);
    state.lastRequested = now();
    if (shouldSkip(state)) {
      return makeImmediateHandle("deduplicated", { reason: "pending-or-cooldown" });
    }
    if (typeof isVisible === "function" && !isVisible()) {
      return makeImmediateHandle("rejected", { reason: "invisible" });
    }
    if (queue.length >= THUMB_SERVICE_LIMITS.maxPending) {
      metrics.overflowed += 1;
      return makeImmediateHandle("overflow", {
        reason: "pending-capacity",
        limit: THUMB_SERVICE_LIMITS.maxPending,
      });
    }

    const { task, handle } = createTask({
      path,
      signature,
      videoElement,
      isVisible,
      owner,
      reason,
    });
    state.pending = true;
    state.pendingTaskToken = task.token;
    enqueue(task);
    return handle;
  },
  getDebugSnapshot() {
    return {
      suspended,
      generation,
      queued: queue.filter((task) => !task.settled).length,
      active: Boolean(activeTask && !activeTask.settled),
      delayed: Boolean(delayedTaskTimer),
      pendingStates: Array.from(stateBySignature.values()).filter(
        (state) => state.pending
      ).length,
      memoryEntries: 0,
      memoryBytes: 0,
      signatureEntries: stateBySignature.size,
      metadataEntries: pathToSignature.size,
      ownerEntries: taskTokensByOwner.size,
      trackedTasks: tasksByToken.size,
      limits: THUMB_SERVICE_LIMITS,
    };
  },
};
