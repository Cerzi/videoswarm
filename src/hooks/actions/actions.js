/**
 * Pure action executors keyed by an action id.
 * They operate on an array of *video objects* and injected dependencies.
 * No React here. Easy to unit test.
 */

import { getOpaqueMediaSource, getWebMediaSource } from "../../utils/mediaSource";

export const ActionIds = {
    OPEN_EXTERNAL: 'open-external',
    COPY_PATH: 'copy-path',
    COPY_FILENAME: 'copy-filename',
    COPY_RELATIVE_PATH: 'copy-relative-path',
    COPY_LAST_FRAME: 'copy-last-frame',
    SHOW_IN_FOLDER: 'show-in-folder',
    FILE_PROPERTIES: 'file-properties',
    MOVE_TO_TRASH: 'move-to-trash',
    TRANSFER_FILES: 'transfer-files',
};

let frameCaptureSequence = 0;
let frameCaptureTail = Promise.resolve();

const scheduleFrameCapture = (task) => {
  const result = frameCaptureTail.catch(() => {}).then(task);
  frameCaptureTail = result.catch(() => {});
  return result;
};

const waitForEvent = (el, eventName, { timeoutMs = 6000, errorMessage } = {}) =>
  new Promise((resolve, reject) => {
    if (!el) {
      reject(new Error(errorMessage || "Missing media element"));
      return;
    }
    let timeoutId;
    const handleEvent = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error(errorMessage || "Failed to load media"));
    };
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      el.removeEventListener(eventName, handleEvent);
      el.removeEventListener("error", handleError);
    };
    el.addEventListener(eventName, handleEvent);
    el.addEventListener("error", handleError);
    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error(errorMessage || "Timed out waiting for media"));
    }, timeoutMs);
  });

const waitForFrame = (videoEl, { timeoutMs = 2000 } = {}) =>
  new Promise((resolve, reject) => {
    if (typeof videoEl?.requestVideoFrameCallback === "function") {
      let settled = false;
      let frameId = null;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (error) reject(error);
        else resolve();
      };
      const timeoutId = setTimeout(() => {
        try {
          if (
            frameId !== null &&
            typeof videoEl.cancelVideoFrameCallback === "function"
          ) {
            videoEl.cancelVideoFrameCallback(frameId);
          }
        } catch {}
        finish(new Error("Timed out waiting for video frame"));
      }, timeoutMs);
      try {
        frameId = videoEl.requestVideoFrameCallback(() => finish());
        return;
      } catch (error) {
        finish(error);
        return;
      }
    }
    setTimeout(resolve, 120);
  });

const safeEscapeSelector = (value) => {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(String(value));
  }
  return String(value).replace(/["\\]/g, "\\$&");
};

const findExistingVideoElement = (video) => {
  const id = video?.id ?? video?.fullPath ?? video?.name;
  if (!id || typeof document === "undefined") return null;
  try {
    return document.querySelector(
      `video.video-element[data-video-id="${safeEscapeSelector(id)}"]`
    );
  } catch {
    return null;
  }
};

export const resolveVideoSource = (video) => {
  if (!video) return {};
  const opaqueSource = getOpaqueMediaSource(video);
  if (opaqueSource) {
    return { src: opaqueSource };
  }
  const webSource = getWebMediaSource(video);
  if (webSource) {
    return { src: webSource };
  }
  if (video.file) {
    const objectUrl = URL.createObjectURL(video.file);
    return { src: objectUrl, revoke: () => URL.revokeObjectURL(objectUrl) };
  }
  return {};
};

const captureLastFrame = async (video, mediaScheduler = null) => {
  const existingVideo = findExistingVideoElement(video);
  const ownsElement = !existingVideo;
  const { src, revoke } = ownsElement ? resolveVideoSource(video) : {};
  if (!existingVideo && !src) {
    throw new Error("No video source available");
  }

  const videoEl = existingVideo || document.createElement("video");
  let auxiliaryLease = null;
  const needsAuxiliaryLease =
    ownsElement || existingVideo?.dataset?.playbackDesired !== "true";
  const reserveAuxiliary =
    mediaScheduler?.reserveAuxiliaryDecoder ||
    mediaScheduler?.reserveExternalDecoder;
  if (needsAuxiliaryLease && reserveAuxiliary) {
    auxiliaryLease = reserveAuxiliary.call(
      mediaScheduler,
      `frame-capture:${++frameCaptureSequence}`
    );
    if (!auxiliaryLease) {
      revoke?.();
      throw new Error("Media capture capacity is busy");
    }
  }
  if (ownsElement) {
    videoEl.preload = "auto";
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.crossOrigin = "anonymous";
  }

  const cleanup = () => {
    if (!ownsElement) return;
    try {
      videoEl.pause();
    } catch {}
    try { videoEl.removeAttribute("src"); } catch {}
    try { videoEl.srcObject = null; } catch {}
    try { videoEl.load(); } catch {}
    try { videoEl.remove?.(); } catch {}
    try { revoke?.(); } catch {}
  };

  const startingTime = videoEl.currentTime || 0;
  const wasPaused = videoEl.paused;
  const startingLoop =
    typeof videoEl.loop === "boolean" ? videoEl.loop : undefined;

  const restoreExistingElement = () => {
    if (ownsElement) return;
    const shouldResume = videoEl.dataset?.playbackDesired !== "false";
    try { videoEl.currentTime = startingTime; } catch {}
    if (typeof startingLoop === "boolean") videoEl.loop = startingLoop;
    if (videoEl.dataset) delete videoEl.dataset.mediaOperation;
    if (!wasPaused && shouldResume && typeof videoEl.play === "function") {
      try { videoEl.play()?.catch?.(() => {}); } catch {}
    }
  };

  try {
    if (!ownsElement && videoEl.dataset) {
      videoEl.dataset.mediaOperation = "frame-capture";
    }
    if (!wasPaused && typeof videoEl.pause === "function") {
      try {
        videoEl.pause();
      } catch {}
    }
    if (!ownsElement && typeof videoEl.loop === "boolean") {
      videoEl.loop = false;
    }

    if (ownsElement) {
      videoEl.src = src;
      await waitForEvent(videoEl, "loadedmetadata", {
        errorMessage: "Failed to load video metadata",
      });
    } else if (videoEl.readyState < 1) {
      await waitForEvent(videoEl, "loadedmetadata", {
        errorMessage: "Failed to load video metadata",
      });
    }

    const duration = Number(videoEl.duration);
    const seekableEnd = (() => {
      try {
        if (videoEl.seekable && videoEl.seekable.length > 0) {
          return Number(videoEl.seekable.end(videoEl.seekable.length - 1));
        }
      } catch {}
      return NaN;
    })();
    const safeDuration =
      Number.isFinite(seekableEnd) && seekableEnd > 0
        ? seekableEnd
        : Number.isFinite(duration) && duration > 0
          ? duration
          : 0;
    const targetTime = Math.max(0, safeDuration - 0.05);

    if (Number.isFinite(targetTime) && targetTime > 0) {
      videoEl.currentTime = targetTime;
      await waitForEvent(videoEl, "seeked", {
        errorMessage: "Failed to seek to last frame",
      });
    } else {
      await waitForEvent(videoEl, "loadeddata", {
        errorMessage: "Failed to load video frame",
      });
    }

    await waitForFrame(videoEl);

    const width = Number(videoEl.videoWidth) || 0;
    const height = Number(videoEl.videoHeight) || 0;
    if (!width || !height) {
      throw new Error("Invalid video dimensions");
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to acquire canvas context");
    }
    ctx.drawImage(videoEl, 0, 0, width, height);

    const dataUrl = canvas.toDataURL("image/png");
    const blob = await new Promise((resolve) => {
      canvas.toBlob((result) => resolve(result), "image/png");
    });
    if (!blob) {
      throw new Error("Failed to create image blob");
    }

    return { blob, dataUrl };
  } finally {
    restoreExistingElement();
    cleanup();
    if (auxiliaryLease) mediaScheduler?.releaseDecoder?.(auxiliaryLease);
  }
};

export const actionRegistry = {
    [ActionIds.OPEN_EXTERNAL]: async (videos, { electronAPI, notify }) => {
        const playable = videos.filter(v => v.isElectronFile && v.fullPath);
        for (const v of playable) {
            const res = await electronAPI?.openInExternalPlayer?.(v.fullPath);
            if (res?.success === false) notify(`Failed to open "${v.name}"`, 'error');
            else notify(`Opened "${v.name}"`, 'success');
        }
    },

    [ActionIds.COPY_PATH]: async (videos, { electronAPI, notify }) => {
        const text = videos.map(v => v.fullPath || v.relativePath || v.name).join('\n');
        if (electronAPI?.copyToClipboard) await electronAPI.copyToClipboard(text);
        else if (navigator?.clipboard?.writeText) await navigator.clipboard.writeText(text);
        notify('Path(s) copied to clipboard', 'success');
    },

    [ActionIds.COPY_FILENAME]: async (videos, { electronAPI, notify }) => {
        const text = videos.map(v => v.name).join('\n');
        if (electronAPI?.copyToClipboard) await electronAPI.copyToClipboard(text);
        else if (navigator?.clipboard?.writeText) await navigator.clipboard.writeText(text);
        notify('Filename(s) copied to clipboard', 'success');
    },

    [ActionIds.COPY_RELATIVE_PATH]: async (videos, { electronAPI, notify }) => {
        const text = videos.map(v => v.relativePath || v.name).join('\n');
        if (electronAPI?.copyToClipboard) await electronAPI.copyToClipboard(text);
        else if (navigator?.clipboard?.writeText) await navigator.clipboard.writeText(text);
        notify('Relative path(s) copied', 'success');
    },

    [ActionIds.COPY_LAST_FRAME]: async (
      videos,
      { electronAPI, notify, mediaScheduler, workSuspended }
    ) => {
        const video = videos[0];
        if (!video) return;
        if (workSuspended) {
          notify('Restore the app before capturing a frame', 'error');
          return;
        }

        try {
          if (video.isElectronFile && video.fullPath && electronAPI?.copyLastFrameFromFile) {
            const result = await electronAPI.copyLastFrameFromFile(video.fullPath);
            if (result?.success === false) {
              throw new Error(result?.error || "Clipboard copy failed");
            }
            notify('Last frame copied to clipboard', 'success');
            return;
          }

          const { blob, dataUrl } = await scheduleFrameCapture(() =>
            captureLastFrame(video, mediaScheduler)
          );
          if (electronAPI?.copyImageToClipboard) {
            const result = await electronAPI.copyImageToClipboard(dataUrl);
            if (result?.success === false) {
              throw new Error(result?.error || "Clipboard copy failed");
            }
          } else if (navigator?.clipboard?.write && window?.ClipboardItem) {
            await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          } else {
            throw new Error("Clipboard image copy not supported");
          }
          notify('Last frame copied to clipboard', 'success');
        } catch (error) {
          console.error("Failed to copy last frame:", error);
          notify('Failed to copy last frame', 'error');
        }
    },

    [ActionIds.SHOW_IN_FOLDER]: async (videos, { electronAPI, notify }) => {
        for (const v of videos) {
            if (v.isElectronFile && v.fullPath) {
                const res = await electronAPI?.showItemInFolder?.(v.fullPath);
                if (res?.success === false) notify(`Failed to show "${v.name}"`, 'error');
                else notify(`Opened folder for "${v.name}"`, 'success');
            }
        }
    },

    [ActionIds.FILE_PROPERTIES]: async (videos, { /* electronAPI, */ notify, showProperties }) => {
        // Delegate a proper modal to UI if you have one
        if (showProperties) showProperties(videos);
        else notify(`Properties: ${videos.map(v => v.name).join(', ')}`, 'info');
    },

    [ActionIds.TRANSFER_FILES]: async (videos, { notify, onRequestTransfer }) => {
        if (typeof onRequestTransfer !== 'function') {
          notify('Transfers are unavailable', 'error');
          return;
        }
        // Only indexed local clips can be named to the catalog by id; the
        // dialog reports the rest rather than pretending they were included.
        const transferable = videos.filter(
          (video) =>
            video?.isElectronFile &&
            Number.isSafeInteger(Number(video.instanceId)) &&
            Number(video.instanceId) > 0
        );
        if (!transferable.length) {
          notify('Select indexed local clips to move or copy', 'error');
          return;
        }
        onRequestTransfer(videos);
    },

    [ActionIds.MOVE_TO_TRASH]: async (
        videos,
        {
          electronAPI,
          notify,
          confirm,
          confirmMoveToTrash,
          postConfirmRecovery,
          releaseVideoHandlesForAsync,      // inject this
          beginMediaMutation,
          endMediaMutation,
          onItemsRemoved,                   // inject: (movedSet: Set<string>) => void
        }
      ) => {
        const candidates = videos
          .filter(v => v.isElectronFile && v.fullPath)
          .map(v => v.fullPath);

        if (candidates.length === 0) {
          notify('Nothing to trash', 'info');
          return;
        }

        const sampleName = videos[0]?.name || '';
        const confirmResult = confirmMoveToTrash
          ? await confirmMoveToTrash({
              paths: candidates,
              count: candidates.length,
              sampleName,
            })
          : (() => {
              const fn = typeof confirm === 'function' ? confirm : window?.confirm;
              const message = candidates.length === 1
                ? (sampleName ? `Move "${sampleName}" to Recycle Bin?` : 'Move this item to Recycle Bin?')
                : `Move ${candidates.length} item(s) to Recycle Bin?`;
              const confirmed = typeof fn === 'function' ? fn(message) : true;
              postConfirmRecovery?.({ cancelled: !confirmed, lastFocusedSelector: null });
              return { confirmed: !!confirmed, lastFocusedSelector: null };
            })();

        if (!confirmResult?.confirmed) return;

        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const isTransient = (msg = '') =>
          /aborted|busy|access is denied|used by another process|locked|eperm|eacces|ebusy/i.test(msg);

        beginMediaMutation?.(candidates);
        let moved = new Set();
        try {
          // 1) Pre-release (awaited)
          try { await releaseVideoHandlesForAsync?.(candidates); } catch {}

          // 2) First bulk attempt consumes the one-shot confirmation grant.
          let result = await electronAPI?.bulkMoveToTrash?.(
            candidates,
            confirmResult?.confirmationToken
          );
          for (const path of result?.moved || []) moved.add(path);
          const initialFailures = Array.isArray(result?.failed)
            ? result.failed.slice()
            : [];
          let retryPaths = initialFailures
            .filter((failure) =>
              isTransient(String(failure.error || '').toLowerCase())
            )
            .map((failure) => failure.path)
            .filter(Boolean);
          let retryToken = result?.retryConfirmationToken || null;
          const retrySet = new Set(retryPaths);
          const finalFailed = initialFailures.filter(
            (failure) => !retrySet.has(failure.path)
          );
          if (!retryToken) {
            finalFailed.push(
              ...initialFailures.filter((failure) => retrySet.has(failure.path))
            );
            retryPaths = [];
          }

          // 3) Retry the remaining confirmed set as a batch. Each native
          // response returns a new one-shot token only for unchanged failures.
          for (let attempt = 1; attempt <= 2 && retryPaths.length; attempt++) {
            await sleep(100 * attempt);
            try { await releaseVideoHandlesForAsync?.(retryPaths); } catch {}
            result = await electronAPI?.bulkMoveToTrash?.(retryPaths, retryToken);
            for (const path of result?.moved || []) moved.add(path);
            const failures = Array.isArray(result?.failed)
              ? result.failed.slice()
              : retryPaths.map((path) => ({ path, error: 'Unknown error' }));
            const canRetryAgain = attempt < 2 && result?.retryConfirmationToken;
            const nextRetry = canRetryAgain
              ? failures.filter((failure) =>
                  isTransient(String(failure.error || '').toLowerCase())
                )
              : [];
            const nextRetrySet = new Set(nextRetry.map((failure) => failure.path));
            finalFailed.push(
              ...failures.filter((failure) => !nextRetrySet.has(failure.path))
            );
            retryPaths = nextRetry.map((failure) => failure.path).filter(Boolean);
            retryToken = result?.retryConfirmationToken || null;
          }

          // 4) Optimistically update the model NOW (so cards unmount immediately)
          if (moved.size) onItemsRemoved?.(moved);

          // 5) Final release pass for the confirmed moved files
          if (moved.size) {
            try { await releaseVideoHandlesForAsync?.(Array.from(moved)); } catch {}
          }

          // 6) Notify
          const movedCount = moved.size;
          const failedCount = finalFailed.length;
          if (movedCount && !failedCount) {
            notify(`Moved ${movedCount} item(s) to Recycle Bin`, 'success');
          } else if (movedCount && failedCount) {
            notify(`Moved ${movedCount}, ${failedCount} failed (in use)`, 'warning');
            console.warn('[trash] failed entries:', finalFailed);
          } else {
            notify('Failed to move items to Recycle Bin', 'error');
            console.warn('[trash] bulk failure:', result);
          }

          postConfirmRecovery?.({
            cancelled: false,
            lastFocusedSelector: confirmResult?.lastFocusedSelector ?? null,
          });
        } finally {
          endMediaMutation?.(candidates, moved);
        }
      },

};
