/**
 * Pure action executors keyed by an action id.
 * They operate on an array of *video objects* and injected dependencies.
 * No React here. Easy to unit test.
 */

import { toFileURL } from "../../components/VideoCard/videoDom";

export const ActionIds = {
    OPEN_EXTERNAL: 'open-external',
    COPY_PATH: 'copy-path',
    COPY_FILENAME: 'copy-filename',
    COPY_RELATIVE_PATH: 'copy-relative-path',
    COPY_LAST_FRAME: 'copy-last-frame',
    SHOW_IN_FOLDER: 'show-in-folder',
    FILE_PROPERTIES: 'file-properties',
    MOVE_TO_TRASH: 'move-to-trash',
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

const waitForFrame = (videoEl) =>
  new Promise((resolve) => {
    if (typeof videoEl?.requestVideoFrameCallback === "function") {
      try {
        videoEl.requestVideoFrameCallback(() => resolve());
        return;
      } catch {}
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

const resolveVideoSource = (video) => {
  if (!video) return {};
  if (video.isElectronFile && video.fullPath) {
    return { src: toFileURL(video.fullPath) };
  }
  if (video.fullPath) {
    return { src: toFileURL(video.fullPath) };
  }
  if (video.blobUrl) {
    return { src: video.blobUrl };
  }
  if (video.file) {
    const objectUrl = URL.createObjectURL(video.file);
    return { src: objectUrl, revoke: () => URL.revokeObjectURL(objectUrl) };
  }
  return {};
};

const captureLastFrame = async (video) => {
  const existingVideo = findExistingVideoElement(video);
  const { src, revoke } = resolveVideoSource(video);
  if (!existingVideo && !src) {
    throw new Error("No video source available");
  }

  const ownsElement = !existingVideo;
  const videoEl = existingVideo || document.createElement("video");
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
    try {
      videoEl.removeAttribute("src");
      videoEl.load();
    } catch {}
    revoke?.();
  };

  try {
    const startingTime = videoEl.currentTime || 0;
    const wasPaused = videoEl.paused;

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
    const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
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

    if (!ownsElement) {
      try {
        if (!wasPaused) {
          videoEl.play().catch(() => {});
        }
        videoEl.currentTime = startingTime;
      } catch {}
    }

    return { blob, dataUrl };
  } finally {
    cleanup();
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

    [ActionIds.COPY_LAST_FRAME]: async (videos, { electronAPI, notify }) => {
        const video = videos[0];
        if (!video) return;

        try {
          const { blob, dataUrl } = await captureLastFrame(video);
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

    [ActionIds.MOVE_TO_TRASH]: async (
        videos,
        {
          electronAPI,
          notify,
          confirm,
          confirmMoveToTrash,
          postConfirmRecovery,
          releaseVideoHandlesForAsync,      // inject this
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
          ? await confirmMoveToTrash({ count: candidates.length, sampleName })
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
      
        // 1) Pre-release (awaited)
        try { await releaseVideoHandlesForAsync?.(candidates); } catch {}
      
        // 2) First bulk attempt
        let result = await electronAPI?.bulkMoveToTrash?.(candidates);
        const failed = Array.isArray(result?.failed) ? result.failed.slice() : [];
      
        // 3) Targeted retries on transient errors (per-file; bounded)
        const retryList = failed
          .filter(f => isTransient(String(f.error || '').toLowerCase()))
          .map(f => f.path)
          .filter(Boolean);
      
        const finalFailed = failed.filter(f => !retryList.includes(f.path));
        for (const p of retryList) {
          let ok = false;
          for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
            await sleep(100 * attempt);
            try { await releaseVideoHandlesForAsync?.([p]); } catch {}
            const res = await electronAPI?.bulkMoveToTrash?.([p]);
            if (res?.moved?.includes?.(p)) ok = true;
            else {
              const err = res?.failed?.find?.(f => f.path === p)?.error;
              if (!isTransient(String(err || '')) || attempt === 2) {
                finalFailed.push({ path: p, error: err || 'Unknown error' });
              }
            }
          }
          if (ok) {
            result.moved = [...(result.moved || []), p];
          }
        }
      
        const moved = new Set(result?.moved || []);
      
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
      },

};
