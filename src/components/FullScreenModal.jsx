import React, {
  forwardRef,
  useCallback,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  FULLSCREEN_COMMANDS,
  FULLSCREEN_PLAYER_SHORTCUTS,
  resolveFullscreenShortcut,
} from "../hotkeys/shortcutCatalog";
import { getOpaqueMediaSource, getWebMediaSource } from "../utils/mediaSource";
import {
  formatFramePosition,
  frameCountFor,
  frameHoldDelay,
  frameIndexAt,
  resolveFrameRate,
  resolveFrameStep,
} from "../playback/frameStepping";
import "./FullScreenModal.css";

const LOAD_TIMEOUT_MS = 15_000;
// A backward step decodes from the preceding keyframe, so it is far slower
// than a forward one. This only bounds a wedged seek; it is not a budget.
const SEEK_TIMEOUT_MS = 4_000;
// How long a newly held key waits on a seek that is still settling.
const SETTLE_POLL_MS = 16;
// The media element is deliberately absent: it refuses focus so that Chromium's
// native controls cannot capture the keyboard. See `handleMediaFocus`.
const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const monotonicNow = () =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

let fullscreenOwnerSequence = 0;
let webObjectSequence = 0;
const webObjectIds = new WeakMap();

const objectIdentity = (value) => {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return "";
  }
  let identity = webObjectIds.get(value);
  if (!identity) {
    identity = `web-object:${++webObjectSequence}`;
    webObjectIds.set(value, identity);
  }
  return identity;
};

const cleanIdentityPart = (value) =>
  value == null ? "" : String(value).replaceAll("\u0000", "");

/**
 * Playback identity deliberately excludes tags, rating, review state, and
 * generation-sidecar presentation data. Replacing a record after a metadata
 * mutation therefore does not restart the modal-owned player.
 */
export const getFullscreenMediaIdentity = (
  video,
  collectionOwnerKey = "default"
) => {
  if (!video) return "";
  const opaqueSource = getOpaqueMediaSource(video) || "";
  const webSource = video.isElectronFile ? "" : getWebMediaSource(video) || "";
  const fileIdentity = objectIdentity(video.file);
  return [
    cleanIdentityPart(collectionOwnerKey),
    video.isElectronFile ? "native" : "web",
    cleanIdentityPart(video.instanceId),
    cleanIdentityPart(video.id),
    cleanIdentityPart(video.fullPath),
    cleanIdentityPart(video.relativePath),
    cleanIdentityPart(video.selectionOrdinal),
    cleanIdentityPart(video.size ?? video.file?.size),
    cleanIdentityPart(video.dateModified ?? video.lastModified ?? video.file?.lastModified),
    cleanIdentityPart(opaqueSource || webSource),
    fileIdentity,
  ].join("\u0000");
};

export const detachFullscreenMedia = (element) => {
  if (!element) return false;
  try {
    element.muted = true;
  } catch {}
  try {
    element.pause();
  } catch {}
  try {
    element.srcObject = null;
  } catch {}
  try {
    element.removeAttribute("src");
  } catch {}
  try {
    element.removeAttribute("data-file-path");
  } catch {}
  try {
    element.removeAttribute("data-media-identity");
  } catch {}
  try {
    element.load();
  } catch {}
  return true;
};

const isEditableTarget = (target) => {
  if (!target || typeof target !== "object") return false;
  const tagName = String(target.tagName || "").toUpperCase();
  return Boolean(
    target.isContentEditable ||
      tagName === "INPUT" ||
      tagName === "TEXTAREA" ||
      tagName === "SELECT" ||
      target.closest?.("[data-hotkey-exempt]")
  );
};

const preservesNativeSpaceActivation = (target) =>
  Boolean(
    target?.closest?.(
      "button, a[href], [role='button'], [role='menuitem'], [role='checkbox']"
    )
  );

const getFocusableElements = (dialog) =>
  Array.from(dialog?.querySelectorAll?.(FOCUSABLE_SELECTOR) || []).filter(
    (element) =>
      !element.hasAttribute?.("disabled") &&
      element.getAttribute?.("aria-hidden") !== "true"
  );

const renderSlot = (slot, context) =>
  typeof slot === "function" ? slot(context) : slot;

export const isPointInsideContainedVideo = (event, element) => {
  const width = Number(element?.videoWidth);
  const height = Number(element?.videoHeight);
  const rect = element?.getBoundingClientRect?.();
  if (
    !rect ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return true;
  }
  const scale = Math.min(rect.width / width, rect.height / height);
  const renderedWidth = width * scale;
  const renderedHeight = height * scale;
  const left = rect.left + (rect.width - renderedWidth) / 2;
  const top = rect.top + (rect.height - renderedHeight) / 2;
  const x = Number(event?.clientX);
  const y = Number(event?.clientY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
  return (
    x >= left &&
    x <= left + renderedWidth &&
    y >= top &&
    y <= top + renderedHeight
  );
};

const safeCloseDialog = (dialog) => {
  if (!dialog) return;
  try {
    if (dialog.open && typeof dialog.close === "function") {
      dialog.close();
      return;
    }
  } catch {}
  try {
    dialog.removeAttribute("open");
  } catch {}
};

const safeShowModal = (dialog) => {
  if (!dialog) return;
  try {
    if (!dialog.open && typeof dialog.showModal === "function") {
      dialog.showModal();
      return;
    }
  } catch {}
  try {
    dialog.setAttribute("open", "");
  } catch {}
};

const resolveSource = (video) => {
  if (!video) return { src: "", ownedBlobUrl: null };
  if (video.isElectronFile) {
    return { src: getOpaqueMediaSource(video) || "", ownedBlobUrl: null };
  }
  if (typeof video.blobUrl === "string" && video.blobUrl) {
    return { src: video.blobUrl, ownedBlobUrl: null };
  }
  if (video.file) {
    const ownedBlobUrl = URL.createObjectURL(video.file);
    return { src: ownedBlobUrl, ownedBlobUrl };
  }
  return { src: getWebMediaSource(video) || "", ownedBlobUrl: null };
};

const FullScreenModal = forwardRef(function FullScreenModal(
  {
    video,
    onClose,
    onNavigate,
    showFilenames,
    mediaScheduler = null,
    workSuspended = false,
    collectionOwnerKey = "default",
    canNavigatePrevious = true,
    canNavigateNext = true,
    onBoundary,
    onPlaybackFeedback,
    onRetry,
    onToggleDetails,
    onOpenHelp,
    onShortcut,
    onCopyFrame,
    detailsOpen,
    audioEnabled = false,
    onAudioEnabledChange,
    transientOpen = false,
    onDismissTransient,
    inertTargetRef = null,
    appRootId = "root",
    resolveReturnFocus,
    returnFocusRef = null,
    fallbackFocusRef = null,
    dialogLabel = "Fullscreen review",
    dialogDescription =
      "Review one video at a time. Use the arrow keys to move and Escape to close.",
    positionLabel = null,
    progressContent = null,
    headerContent = null,
    actionsContent = null,
    reviewRail = null,
    detailsDock = null,
    statusContent = null,
    className = "",
  },
  forwardedRef
) {
  const dialogRef = useRef(null);
  const closeButtonRef = useRef(null);
  const mediaRef = useRef(null);
  const activeReleaseRef = useRef(null);
  const closeRequestedRef = useRef(false);
  const previousFocusRef = useRef(null);
  const previousOwnerRef = useRef(collectionOwnerKey);
  const playbackIntentRef = useRef(false);
  const schedulerOwnerIdRef = useRef(null);
  if (!schedulerOwnerIdRef.current) {
    schedulerOwnerIdRef.current = `fullscreen:${++fullscreenOwnerSequence}`;
  }

  const callbackRef = useRef({});
  callbackRef.current = {
    onAudioEnabledChange,
    onBoundary,
    onClose,
    onCopyFrame,
    onDismissTransient,
    onNavigate,
    onOpenHelp,
    onPlaybackFeedback,
    onRetry,
    onShortcut,
    onToggleDetails,
    resolveReturnFocus,
    returnFocusRef,
    fallbackFocusRef,
  };

  const videoRef = useRef(video);
  videoRef.current = video;
  const workSuspendedRef = useRef(Boolean(workSuspended));
  workSuspendedRef.current = Boolean(workSuspended);
  const persistedAudioEnabledRef = useRef(Boolean(audioEnabled));
  persistedAudioEnabledRef.current = Boolean(audioEnabled);
  const mutedPreferenceRef = useRef(!audioEnabled);

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState("");
  const [videoLoaded, setVideoLoaded] = useState(false);
  const [isMuted, setIsMuted] = useState(!audioEnabled);
  const [retryRevision, setRetryRevision] = useState(0);
  const [frameIndex, setFrameIndex] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [isStepping, setIsStepping] = useState(false);
  const [isCopyingFrame, setIsCopyingFrame] = useState(false);
  const steppingRef = useRef(false);
  const frameHoldRef = useRef(null);

  const reactId = useId().replaceAll(":", "");
  const titleId = `fullscreen-review-title-${reactId}`;
  const descriptionId = `fullscreen-review-description-${reactId}`;
  const liveId = `fullscreen-review-live-${reactId}`;

  const mediaIdentity = useMemo(
    () => getFullscreenMediaIdentity(video, collectionOwnerKey),
    [
      collectionOwnerKey,
      video?.dateModified,
      video?.file,
      video?.fullPath,
      video?.id,
      video?.instanceId,
      video?.isElectronFile,
      video?.lastModified,
      video?.relativePath,
      video?.selectionOrdinal,
      video?.size,
      video?.sourceUrl,
      video?.blobUrl,
    ]
  );

  // Teardown already leaves the released element muted. Restoring only the
  // preference and its control state keeps that invariant intact while letting
  // the next session start from the persisted choice, which the source-load
  // effect applies to the element it actually plays.
  const restoreAudioPreference = useCallback(() => {
    const nextMuted = !persistedAudioEnabledRef.current;
    mutedPreferenceRef.current = nextMuted;
    setIsMuted(nextMuted);
  }, []);

  const releaseActiveSource = useCallback(
    ({ resetAudio = false } = {}) => {
      const release = activeReleaseRef.current;
      const released = typeof release === "function" ? release() : false;
      if (resetAudio) restoreAudioPreference();
      return released;
    },
    [restoreAudioPreference]
  );

  // A late settings load must not be overridden by the mount-time default, but
  // a live session owns its own audio state until it is released.
  useLayoutEffect(() => {
    if (activeReleaseRef.current) return;
    restoreAudioPreference();
  }, [audioEnabled, restoreAudioPreference]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      releaseNow({ resetAudio = true } = {}) {
        return releaseActiveSource({ resetAudio });
      },
    }),
    [releaseActiveSource]
  );

  const publishPlaybackFeedback = useCallback((message, errorValue = null) => {
    setNotice(message);
    callbackRef.current.onPlaybackFeedback?.({
      message,
      error: errorValue,
      video: videoRef.current,
    });
  }, []);

  const attemptPlay = useCallback(
    async (element = mediaRef.current, release = activeReleaseRef.current) => {
      if (!element || workSuspendedRef.current || typeof element.play !== "function") {
        return false;
      }
      playbackIntentRef.current = true;
      try {
        await element.play();
        return true;
      } catch (playError) {
        if (
          activeReleaseRef.current !== release ||
          !playbackIntentRef.current
        ) {
          return false;
        }
        playbackIntentRef.current = false;
        const message =
          playError?.name === "NotAllowedError"
            ? "Autoplay was blocked. Use the player controls to start playback."
            : "Playback did not start. Use the player controls to retry.";
        publishPlaybackFeedback(message, playError);
        return false;
      }
    },
    [publishPlaybackFeedback]
  );

  const togglePlayback = useCallback(() => {
    if (workSuspendedRef.current) return false;
    const element = mediaRef.current;
    if (!element) return false;

    if (playbackIntentRef.current || !element.paused) {
      playbackIntentRef.current = false;
      try {
        element.pause();
      } catch {}
      return true;
    }

    playbackIntentRef.current = true;
    void attemptPlay(element, activeReleaseRef.current);
    return true;
  }, [attemptPlay]);

  const toggleAudio = useCallback(() => {
    const nextMuted = !mutedPreferenceRef.current;
    mutedPreferenceRef.current = nextMuted;
    const element = mediaRef.current;
    if (element) {
      try {
        element.muted = nextMuted;
      } catch {}
    }
    setIsMuted(nextMuted);
    setNotice(nextMuted ? "Audio muted" : "Audio on");
    callbackRef.current.onAudioEnabledChange?.(!nextMuted);
  }, []);

  const frameRate = useMemo(
    () => resolveFrameRate(video?.dimensions?.frameRate ?? video?.frameRate),
    [video?.dimensions?.frameRate, video?.frameRate]
  );
  const frameRateRef = useRef(frameRate);
  frameRateRef.current = frameRate;

  const syncFramePosition = useCallback((element = mediaRef.current) => {
    if (!element) return;
    const fps = frameRateRef.current;
    setFrameIndex(frameIndexAt(element.currentTime, fps));
    setFrameCount(frameCountFor(element.duration, fps));
  }, []);

  /**
   * Step exactly one frame. Playback is stopped first because stepping while
   * decoding races the next presented frame, and concurrent steps are dropped
   * rather than queued so a held key cannot outrun the decoder's seeks.
   */
  const stepFrame = useCallback(
    async (direction) => {
      if (workSuspendedRef.current || steppingRef.current) return false;
      const element = mediaRef.current;
      if (!element || !activeReleaseRef.current) return false;

      playbackIntentRef.current = false;
      try {
        element.pause();
      } catch {}

      const step = resolveFrameStep({
        currentTime: element.currentTime,
        duration: element.duration,
        frameRate: frameRateRef.current,
        direction,
      });
      if (!step) {
        setNotice(direction < 0 ? "At the first frame" : "At the last frame");
        syncFramePosition(element);
        return false;
      }

      steppingRef.current = true;
      setIsStepping(true);
      const release = activeReleaseRef.current;
      try {
        await new Promise((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            element.removeEventListener("seeked", finish);
            resolve();
          };
          const timeoutId = setTimeout(finish, SEEK_TIMEOUT_MS);
          element.addEventListener("seeked", finish);
          try {
            element.currentTime = step.time;
          } catch {
            finish();
          }
        });
        // The source can be replaced or released while a seek is in flight.
        if (activeReleaseRef.current !== release) return false;
        syncFramePosition(element);
        return true;
      } finally {
        steppingRef.current = false;
        setIsStepping(false);
      }
    },
    [syncFramePosition]
  );

  /**
   * End a held step. Called with no argument this always ends the hold; a
   * released key passes what it knows about itself so that letting go of one
   * frame key cannot cancel a hold the other key has already taken over.
   */
  const stopFrameHold = useCallback((released = null) => {
    const hold = frameHoldRef.current;
    if (!hold) return false;
    if (released) {
      const sameKey = Boolean(
        released.code && hold.code && released.code === hold.code
      );
      const sameDirection =
        released.direction != null && released.direction === hold.direction;
      if (!sameKey && !sameDirection) return false;
    }
    frameHoldRef.current = null;
    if (hold.timeoutId !== null) clearTimeout(hold.timeoutId);
    return true;
  }, []);

  /**
   * Press-and-hold scrubbing. Each repeat is scheduled from the step that
   * precedes it rather than from the operating system's key-repeat stream, so
   * a held key can never queue seeks faster than the decoder retires them, and
   * the gap shrinks with every repeat until a hold reads as a scrub. A step
   * that reports no movement means the clip ended, which ends the hold instead
   * of spinning against the clamp.
   */
  const startFrameHold = useCallback(
    (direction, code = null) => {
      stopFrameHold();
      const hold = { direction, code, repeats: 0, timeoutId: null };
      frameHoldRef.current = hold;

      const advance = async () => {
        // Reversing direction mid-seek would otherwise be dropped as a
        // concurrent step and the press would do nothing at all. Waiting for
        // the seek in flight costs a frame of latency and cannot outlive it:
        // stepping always clears itself, at worst on its own timeout.
        if (steppingRef.current) {
          hold.timeoutId = setTimeout(() => {
            hold.timeoutId = null;
            void advance();
          }, SETTLE_POLL_MS);
          return;
        }
        const startedAt = monotonicNow();
        const stepped = await stepFrame(direction);
        if (frameHoldRef.current !== hold) return;
        if (!stepped) {
          frameHoldRef.current = null;
          return;
        }
        const delay = frameHoldDelay(hold.repeats);
        // The very first gap is the hold threshold, which is measured from the
        // press so that a tap stays a tap; later gaps absorb the seek that has
        // just completed so the ramp keeps its intended cadence.
        const spent = hold.repeats === 0 ? 0 : monotonicNow() - startedAt;
        hold.repeats += 1;
        hold.timeoutId = setTimeout(() => {
          hold.timeoutId = null;
          void advance();
        }, Math.max(0, delay - spent));
      };

      void advance();
    },
    [stepFrame, stopFrameHold]
  );

  /**
   * Draw the frame currently on screen. The modal owns this element, so the
   * capture stays inside that ownership rather than handing the element out;
   * callers receive only the resulting image. No seek or decoder lease is
   * needed because the frame is already decoded and displayed.
   */
  const captureCanvasFrame = useCallback(async () => {
    const element = mediaRef.current;
    if (!element) return null;
    const width = Number(element.videoWidth) || 0;
    const height = Number(element.videoHeight) || 0;
    if (!width || !height) return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(element, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/png");
    const blob = await new Promise((resolve) => {
      canvas.toBlob((result) => resolve(result), "image/png");
    });
    if (!blob) return null;
    return { blob, dataUrl, width, height };
  }, []);

  const copyCurrentFrame = useCallback(async () => {
    if (workSuspendedRef.current || steppingRef.current) return false;
    const element = mediaRef.current;
    const current = videoRef.current;
    if (!element || !current) return false;
    const handler = callbackRef.current.onCopyFrame;
    if (typeof handler !== "function") return false;

    setIsCopyingFrame(true);
    setNotice("Copying frame…");
    try {
      // The element's own position is authoritative: the readout can lag a
      // frame behind a seek that is still settling.
      const result = await handler({
        video: current,
        atSeconds: Number(element.currentTime) || 0,
        frameIndex: frameIndexAt(element.currentTime, frameRateRef.current),
        captureCanvasFrame,
      });
      const failed = result === false || result?.success === false;
      setNotice(failed ? "Could not copy the frame" : "Frame copied");
      return !failed;
    } catch {
      setNotice("Could not copy the frame");
      return false;
    } finally {
      setIsCopyingFrame(false);
    }
  }, [captureCanvasFrame]);

  const retryPlayback = useCallback(() => {
    releaseActiveSource({ resetAudio: false });
    setError(null);
    setNotice("Retrying playback");
    setIsLoading(true);
    setVideoLoaded(false);
    setRetryRevision((revision) => revision + 1);
    callbackRef.current.onRetry?.(videoRef.current);
  }, [releaseActiveSource]);

  const requestClose = useCallback(
    (reason = "close") => {
      if (closeRequestedRef.current) return false;
      closeRequestedRef.current = true;
      stopFrameHold();
      releaseActiveSource({ resetAudio: true });
      safeCloseDialog(dialogRef.current);
      callbackRef.current.onClose?.(reason);
      return true;
    },
    [releaseActiveSource, stopFrameHold]
  );

  const requestNavigate = useCallback(
    (direction) => {
      stopFrameHold();
      const allowed =
        direction === "next" ? canNavigateNext !== false : canNavigatePrevious !== false;
      if (!allowed) {
        const message = direction === "next" ? "End of current view" : "Start of current view";
        setNotice(message);
        callbackRef.current.onBoundary?.(direction, message);
        return false;
      }
      // App owns the atomic peek -> releaseNow(false) -> controller transition.
      // Delegating without detaching prevents a stale boundary callback from
      // leaving this stable media identity blank.
      return callbackRef.current.onNavigate?.(direction) !== false;
    },
    [canNavigateNext, canNavigatePrevious, stopFrameHold]
  );

  // Owner replacement is a session boundary even if a caller accidentally
  // reuses the same record ID and keeps this component mounted.
  useLayoutEffect(() => {
    if (Object.is(previousOwnerRef.current, collectionOwnerKey)) return;
    previousOwnerRef.current = collectionOwnerKey;
    releaseActiveSource({ resetAudio: true });
  }, [collectionOwnerKey, releaseActiveSource]);

  // Fullscreen owns this media element and its exact external decoder lease.
  // A layout effect makes cleanup precede paint/grid resumption on identity and
  // work-suspension transitions; the imperative ref handles event boundaries.
  useLayoutEffect(() => {
    const element = mediaRef.current;
    if (!videoRef.current || !element || workSuspended) {
      if (workSuspended) {
        releaseActiveSource({ resetAudio: true });
        setIsLoading(false);
        setVideoLoaded(false);
        setNotice("Playback paused while the app is inactive");
      }
      return undefined;
    }

    let source;
    try {
      source = resolveSource(videoRef.current);
    } catch (sourceError) {
      setIsLoading(false);
      setVideoLoaded(false);
      setError(sourceError?.message || "No valid video source");
      return undefined;
    }

    if (!source.src) {
      setIsLoading(false);
      setVideoLoaded(false);
      setError("No valid video source");
      return undefined;
    }

    const decoderLease =
      mediaScheduler?.reserveExternalDecoder?.(schedulerOwnerIdRef.current) || null;
    if (mediaScheduler?.reserveExternalDecoder && !decoderLease) {
      if (source.ownedBlobUrl) {
        try {
          URL.revokeObjectURL(source.ownedBlobUrl);
        } catch {}
      }
      setIsLoading(false);
      setVideoLoaded(false);
      setError("Fullscreen playback capacity is busy");
      return undefined;
    }

    let released = false;
    let ownedBlobUrl = source.ownedBlobUrl;
    let loadTimeoutId = null;

    const release = () => {
      if (released) return false;
      released = true;
      playbackIntentRef.current = false;
      if (activeReleaseRef.current === release) activeReleaseRef.current = null;
      if (loadTimeoutId !== null) clearTimeout(loadTimeoutId);
      loadTimeoutId = null;
      element.removeEventListener("canplay", handlePlayable);
      element.removeEventListener("loadeddata", handlePlayable);
      element.removeEventListener("error", handleMediaError);
      detachFullscreenMedia(element);
      if (ownedBlobUrl) {
        try {
          URL.revokeObjectURL(ownedBlobUrl);
        } catch {}
        ownedBlobUrl = null;
      }
      if (decoderLease) mediaScheduler?.releaseDecoder?.(decoderLease);
      return true;
    };

    let readySettled = false;
    const settleReady = () => {
      if (released || readySettled) return;
      readySettled = true;
      element.removeEventListener("canplay", handlePlayable);
      element.removeEventListener("loadeddata", handlePlayable);
      if (loadTimeoutId !== null) clearTimeout(loadTimeoutId);
      loadTimeoutId = null;
      setIsLoading(false);
      setError(null);
      setVideoLoaded(true);
      setNotice("");
      if (playbackIntentRef.current) void attemptPlay(element, release);
    };

    function handlePlayable() {
      settleReady();
    }

    function handleMediaError(event) {
      if (released) return;
      const mediaError = event?.target?.error;
      setIsLoading(false);
      setVideoLoaded(false);
      setError(mediaError?.message || "Failed to load video");
      release();
    }

    activeReleaseRef.current = release;
    setIsLoading(true);
    setError(null);
    setNotice("");
    setVideoLoaded(false);
    setFrameIndex(0);
    setFrameCount(0);
    playbackIntentRef.current = true;

    element.addEventListener("canplay", handlePlayable);
    element.addEventListener("loadeddata", handlePlayable);
    element.addEventListener("error", handleMediaError);
    element.preload = "auto";
    element.crossOrigin = "anonymous";
    element.loop = true;
    element.playsInline = true;
    element.muted = mutedPreferenceRef.current;
    setIsMuted(mutedPreferenceRef.current);
    element.dataset.mediaIdentity = mediaIdentity;
    if (videoRef.current.isElectronFile && videoRef.current.fullPath) {
      element.dataset.filePath = videoRef.current.fullPath;
    } else {
      element.removeAttribute("data-file-path");
    }

    try {
      // `currentSrc` may retain the detached source after removeAttribute +
      // load(). Always restore the actual source attribute for a new logical
      // identity, including two records that intentionally share one URL.
      if (element.getAttribute("src") !== source.src) element.src = source.src;
      element.load();
    } catch (loadError) {
      handleMediaError({ target: { error: loadError } });
      return release;
    }

    const readyThreshold =
      (typeof HTMLMediaElement !== "undefined" &&
        Number(HTMLMediaElement.HAVE_CURRENT_DATA)) ||
      2;
    if (element.readyState >= readyThreshold) {
      settleReady();
    } else {
      loadTimeoutId = setTimeout(() => {
        handleMediaError({
          target: { error: new Error("Timed out loading video") },
        });
      }, LOAD_TIMEOUT_MS);
    }

    return release;
  }, [
    attemptPlay,
    mediaIdentity,
    mediaScheduler,
    releaseActiveSource,
    retryRevision,
    workSuspended,
  ]);

  // Native modal lifecycle, inert background, exact body style restoration,
  // and focus return are independent of source navigation.
  useLayoutEffect(() => {
    if (!video || typeof document === "undefined") return undefined;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    previousFocusRef.current = document.activeElement;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const inertTarget = inertTargetRef?.current || document.getElementById(appRootId);
    const mayInert = inertTarget && !inertTarget.contains?.(dialog);
    const hadInertAttribute = Boolean(mayInert && inertTarget.hasAttribute("inert"));
    const previousInertValue = mayInert ? inertTarget.inert : undefined;
    if (mayInert) {
      try {
        inertTarget.inert = true;
        inertTarget.setAttribute("inert", "");
      } catch {}
    }

    safeShowModal(dialog);
    const focusTarget = closeButtonRef.current || dialog;
    try {
      focusTarget.focus({ preventScroll: true });
    } catch {
      try {
        focusTarget.focus();
      } catch {}
    }

    return () => {
      releaseActiveSource({ resetAudio: true });
      safeCloseDialog(dialog);
      document.body.style.overflow = previousBodyOverflow;
      if (mayInert) {
        try {
          inertTarget.inert = previousInertValue;
          if (!hadInertAttribute) inertTarget.removeAttribute("inert");
        } catch {}
      }

      const callbacks = callbackRef.current;
      const resolved = callbacks.resolveReturnFocus?.();
      const returnTarget = [
        resolved,
        callbacks.returnFocusRef?.current,
        callbacks.fallbackFocusRef?.current,
        previousFocusRef.current,
        document.querySelector?.('[role="region"][aria-label="Video gallery"]'),
      ].find(
        (candidate) =>
          candidate?.isConnected !== false &&
          typeof candidate?.focus === "function"
      );
      if (returnTarget) {
        try {
          returnTarget.focus({ preventScroll: true });
        } catch {
          try {
            returnTarget.focus();
          } catch {}
        }
      }
    };
  }, [appRootId, inertTargetRef, releaseActiveSource, video ? true : false]);

  const handleEscape = useCallback(() => {
    if (transientOpen && typeof callbackRef.current.onDismissTransient === "function") {
      callbackRef.current.onDismissTransient();
      return;
    }
    requestClose("escape");
  }, [requestClose, transientOpen]);

  useLayoutEffect(() => {
    if (!video || typeof document === "undefined") return undefined;

    const handleKeyDown = (event) => {
      const binding = resolveFullscreenShortcut(event);

      if (binding?.command === FULLSCREEN_COMMANDS.CLOSE) {
        event.preventDefault();
        event.stopPropagation();
        handleEscape();
        return;
      }

      if (event.key === "Tab") {
        const dialog = dialogRef.current;
        const focusable = getFocusableElements(dialog);
        if (!focusable.length) {
          event.preventDefault();
          dialog?.focus?.();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !dialog?.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || !dialog?.contains(active))) {
          event.preventDefault();
          first.focus();
        }
        return;
      }

      if (isEditableTarget(event.target)) return;
      if (
        binding?.command === FULLSCREEN_COMMANDS.PLAYBACK &&
        preservesNativeSpaceActivation(event.target)
      ) {
        return;
      }
      if (event.repeat) {
        if (binding) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      const key = String(event.key || "").toLowerCase();

      switch (binding?.command) {
        case FULLSCREEN_COMMANDS.PREVIOUS:
          event.preventDefault();
          event.stopPropagation();
          requestNavigate("prev");
          return;
        case FULLSCREEN_COMMANDS.NEXT:
          event.preventDefault();
          event.stopPropagation();
          requestNavigate("next");
          return;
        case FULLSCREEN_COMMANDS.PLAYBACK: {
          event.preventDefault();
          event.stopPropagation();
          togglePlayback();
          return;
        }
        case FULLSCREEN_COMMANDS.MUTE:
          event.preventDefault();
          event.stopPropagation();
          toggleAudio();
          return;
        case FULLSCREEN_COMMANDS.FRAME_BACK:
        case FULLSCREEN_COMMANDS.FRAME_FORWARD: {
          event.preventDefault();
          event.stopPropagation();
          startFrameHold(
            binding.command === FULLSCREEN_COMMANDS.FRAME_BACK ? -1 : 1,
            event.code || null
          );
          return;
        }
        case FULLSCREEN_COMMANDS.COPY_FRAME: {
          if (!callbackRef.current.onCopyFrame) break;
          event.preventDefault();
          event.stopPropagation();
          void copyCurrentFrame();
          return;
        }
        case FULLSCREEN_COMMANDS.DETAILS:
          if (callbackRef.current.onToggleDetails) {
            event.preventDefault();
            event.stopPropagation();
            callbackRef.current.onToggleDetails();
            return;
          }
          break;
        case FULLSCREEN_COMMANDS.HELP:
          if (callbackRef.current.onOpenHelp) {
            event.preventDefault();
            event.stopPropagation();
            callbackRef.current.onOpenHelp();
            return;
          }
          break;
        default:
          break;
      }

      const handled = callbackRef.current.onShortcut?.({
        event,
        key,
        video: videoRef.current,
      });
      if (handled === true) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    const handleKeyUp = (event) => {
      const binding = resolveFullscreenShortcut(event);

      // Released before anything else, and without the editable-target guard:
      // a hold that outlives its key would keep scrubbing on its own. Physical
      // key identity is preferred over the printable one because a modifier
      // pressed mid-hold changes `key` but never `code`.
      const releasedDirection =
        binding?.command === FULLSCREEN_COMMANDS.FRAME_BACK
          ? -1
          : binding?.command === FULLSCREEN_COMMANDS.FRAME_FORWARD
            ? 1
            : null;
      stopFrameHold({
        direction: releasedDirection,
        code: event.code || null,
      });

      if (isEditableTarget(event.target)) return;
      // Chromium's native video controls can also react to Space on keyup.
      // Consume that half of the gesture so one press produces one toggle.
      if (binding?.command !== FULLSCREEN_COMMANDS.PLAYBACK) return;
      if (preservesNativeSpaceActivation(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    // A key released while the window is in the background never reports a
    // keyup here, so the hold has to end with the interaction that owns it.
    const handleInterrupt = () => {
      stopFrameHold();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") stopFrameHold();
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("keyup", handleKeyUp, true);
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("blur", handleInterrupt);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("keyup", handleKeyUp, true);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("blur", handleInterrupt);
      stopFrameHold();
    };
  }, [
    copyCurrentFrame,
    handleEscape,
    requestNavigate,
    startFrameHold,
    stopFrameHold,
    toggleAudio,
    togglePlayback,
    video ? true : false,
  ]);

  const handleBackdropClick = useCallback(
    (event) => {
      if (event.target === dialogRef.current) requestClose("backdrop");
    },
    [requestClose]
  );

  const handleDismissAreaClick = useCallback(
    (event) => {
      if (event.target === event.currentTarget) requestClose("backdrop");
    },
    [requestClose]
  );

  const handleVideoClick = useCallback(
    (event) => {
      event.stopPropagation();
      if (!isPointInsideContainedVideo(event, event.currentTarget)) {
        requestClose("backdrop");
      }
    },
    [requestClose]
  );

  const handleNativeCancel = useCallback(
    (event) => {
      event.preventDefault();
      handleEscape();
    },
    [handleEscape]
  );

  const setMediaElement = useCallback((element) => {
    mediaRef.current = element;
    if (element) element.muted = true;
  }, []);

  /**
   * The step buttons hold exactly like the frame keys do. The press itself
   * takes the first step, so the click that follows it must not take a second
   * one — only an activation with no click count behind it (keyboard, or a
   * programmatic `click()`) still steps here.
   */
  const beginStepGesture = useCallback(
    (event, direction) => {
      if (event.button != null && event.button !== 0) return;
      startFrameHold(direction);
    },
    [startFrameHold]
  );

  const endStepGesture = useCallback(() => {
    stopFrameHold();
  }, [stopFrameHold]);

  const stepFromActivation = useCallback(
    (event, direction) => {
      if (event.detail !== 0) return;
      void stepFrame(direction);
    },
    [stepFrame]
  );

  /**
   * Refuse focus on the media element. Clicking one of Chromium's native
   * controls moves focus into the element's shadow DOM, and while it sits
   * there key events are consumed by the controls before they reach the
   * document at all — every loupe shortcut would silently stop working until
   * something else was clicked. Handing focus straight back to the dialog
   * costs nothing: the controls stay fully usable by pointer, and the keyboard
   * interface is the shortcut catalog, not the shadow DOM's own tab stops.
   */
  const handleMediaFocus = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog || document.activeElement !== mediaRef.current) return;
    try {
      dialog.focus({ preventScroll: true });
    } catch {
      try {
        dialog.focus();
      } catch {}
    }
  }, []);

  const handleVolumeChange = useCallback((event) => {
    if (closeRequestedRef.current || !activeReleaseRef.current) return;
    const element = event.currentTarget;

    // Native player controls are an equal source of truth while a fullscreen
    // source is active. Teardown clears activeReleaseRef before synchronously
    // muting, so its delayed volume event cannot overwrite the preference. A
    // replacement source restores the preference before any later event reads
    // the reused element's current value.
    const nextMuted = Boolean(element.muted);
    const didChange = mutedPreferenceRef.current !== nextMuted;
    mutedPreferenceRef.current = nextMuted;
    setIsMuted(nextMuted);
    if (didChange) {
      setNotice(nextMuted ? "Audio muted" : "Audio on");
      callbackRef.current.onAudioEnabledChange?.(!nextMuted);
    }
  }, []);

  if (!video || typeof document === "undefined") return null;

  const slotContext = {
    video,
    isLoading,
    error,
    notice,
    videoLoaded,
    isMuted,
    toggleAudio,
    retryPlayback,
    requestClose,
    requestNavigate,
  };
  const renderedHeader = renderSlot(headerContent, slotContext);
  const renderedActions = renderSlot(actionsContent, slotContext);
  const renderedReviewRail = renderSlot(reviewRail, slotContext);
  const renderedDetailsDock = renderSlot(detailsDock, slotContext);
  const showDetails = detailsOpen ?? Boolean(renderedDetailsDock);
  const workspaceClassName = [
    "fullscreen-review__workspace",
    renderedReviewRail ? "fullscreen-review__workspace--with-review" : "",
    showDetails && renderedDetailsDock
      ? "fullscreen-review__workspace--with-details"
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  return createPortal(
    <dialog
      ref={dialogRef}
      className={["fullscreen-modal", "fullscreen-review", className]
        .filter(Boolean)
        .join(" ")}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-modal="true"
      role="dialog"
      onClick={handleBackdropClick}
      onCancel={handleNativeCancel}
      tabIndex={-1}
    >
      <div className="fullscreen-review__surface">
        <p id={descriptionId} className="fullscreen-review__sr-only">
          {dialogDescription}
        </p>

        <header className="fullscreen-review__header">
          <div className="fullscreen-review__identity">
            <h2 id={titleId} className="fullscreen-review__title">
              {dialogLabel}
            </h2>
            {renderedHeader || (
              <div className="fullscreen-review__record-line">
                {showFilenames ? video.relativePath || video.name : "Current clip"}
              </div>
            )}
          </div>
          <div className="fullscreen-review__header-status">
            {positionLabel ? (
              <span className="fullscreen-review__position">{positionLabel}</span>
            ) : null}
            {progressContent}
          </div>
          <div className="fullscreen-review__header-actions">
            <div
              className="fullscreen-review__frames"
              role="group"
              aria-label="Frame picker"
            >
              <button
                type="button"
                className="fullscreen-review__button fullscreen-review__button--step"
                onPointerDown={(event) => beginStepGesture(event, -1)}
                onPointerUp={endStepGesture}
                onPointerLeave={endStepGesture}
                onPointerCancel={endStepGesture}
                onClick={(event) => stepFromActivation(event, -1)}
                // Deliberately not disabled while a step is in flight: a hold
                // retires several a second and would strobe the control.
                // `stepFrame` already drops a request it cannot serve.
                disabled={!videoLoaded}
                aria-label="Previous frame"
                title="Previous frame (,) — hold to scrub"
              >
                ‹
              </button>
              <span
                className="fullscreen-review__frame-position"
                aria-live="off"
                title={`Frame ${formatFramePosition(frameIndex, frameCount)} at ${frameRate.toFixed(2)} fps`}
              >
                {formatFramePosition(frameIndex, frameCount)}
              </span>
              <button
                type="button"
                className="fullscreen-review__button fullscreen-review__button--step"
                onPointerDown={(event) => beginStepGesture(event, 1)}
                onPointerUp={endStepGesture}
                onPointerLeave={endStepGesture}
                onPointerCancel={endStepGesture}
                onClick={(event) => stepFromActivation(event, 1)}
                disabled={!videoLoaded}
                aria-label="Next frame"
                title="Next frame (.) — hold to scrub"
              >
                ›
              </button>
              {onCopyFrame ? (
                <button
                  type="button"
                  className="fullscreen-review__button"
                  onClick={() => void copyCurrentFrame()}
                  disabled={isCopyingFrame || isStepping || !videoLoaded}
                  aria-label="Copy current frame"
                  title="Copy current frame (C)"
                >
                  {isCopyingFrame ? "Copying…" : "Copy frame"}
                </button>
              ) : null}
            </div>
            <button
              type="button"
              className="fullscreen-review__button"
              onClick={toggleAudio}
              aria-pressed={!isMuted}
              aria-label={isMuted ? "Turn audio on" : "Mute audio"}
              title="Toggle audio (M)"
            >
              {isMuted ? "Muted" : "Audio on"}
            </button>
            {onToggleDetails || renderedDetailsDock ? (
              <button
                type="button"
                className="fullscreen-review__button"
                onClick={() => callbackRef.current.onToggleDetails?.()}
                aria-pressed={Boolean(showDetails)}
                aria-label={showDetails ? "Hide details" : "Show details"}
                title="Toggle details (I)"
              >
                Details
              </button>
            ) : null}
            {renderedActions}
            <button
              ref={closeButtonRef}
              type="button"
              className="fullscreen-review__button fullscreen-review__button--close"
              onClick={() => requestClose("button")}
              aria-label="Close fullscreen review"
              title="Close (Esc)"
            >
              ×
            </button>
          </div>
        </header>

        <div className={workspaceClassName}>
          {renderedReviewRail ? (
            <aside
              className="fullscreen-review__review-rail"
              aria-label="Review controls"
            >
              {renderedReviewRail}
            </aside>
          ) : null}

          <main
            className="fullscreen-review__stage"
            onClick={handleDismissAreaClick}
          >
            <button
              type="button"
              className="fullscreen-review__nav fullscreen-review__nav--previous"
              onClick={() => requestNavigate("prev")}
              disabled={canNavigatePrevious === false}
              aria-label="Previous clip"
              title="Previous (Left arrow or Q)"
            >
              ←
            </button>

            <div
              className="fullscreen-review__media-wrap"
              onClick={handleDismissAreaClick}
            >
              {isLoading ? (
                <div className="fullscreen-review__loading" role="status">
                  <span className="fullscreen-review__spinner" aria-hidden="true" />
                  Loading video…
                </div>
              ) : null}

              {error ? (
                <div className="fullscreen-review__error" role="alert">
                  <strong>Couldn’t play this clip</strong>
                  <span>{error}</span>
                  <button
                    type="button"
                    className="fullscreen-review__button"
                    onClick={retryPlayback}
                  >
                    Retry
                  </button>
                </div>
              ) : null}

              <video
                ref={setMediaElement}
                className="fullscreen-review__video"
                loop
                controls
                playsInline
                tabIndex={-1}
                onFocus={handleMediaFocus}
                onClick={handleVideoClick}
                onPlay={() => {
                  playbackIntentRef.current = true;
                }}
                onPause={() => {
                  playbackIntentRef.current = false;
                  syncFramePosition();
                }}
                // timeupdate fires a few times a second rather than per frame,
                // which is enough for a readout and costs no per-frame render.
                // Native scrubbing lands on seeked, and stepping syncs itself.
                onTimeUpdate={() => syncFramePosition()}
                onSeeked={() => syncFramePosition()}
                onLoadedMetadata={() => syncFramePosition()}
                onVolumeChange={handleVolumeChange}
              />

              {showFilenames && videoLoaded ? (
                <div className="fullscreen-review__filename">{video.name}</div>
              ) : null}
            </div>

            <button
              type="button"
              className="fullscreen-review__nav fullscreen-review__nav--next"
              onClick={() => requestNavigate("next")}
              disabled={canNavigateNext === false}
              aria-label="Next clip"
              title="Next (Right arrow or E)"
            >
              →
            </button>
          </main>

          {showDetails && renderedDetailsDock ? (
            <aside
              className="fullscreen-review__details"
              aria-label="Clip details"
              data-hotkey-exempt
            >
              {renderedDetailsDock}
            </aside>
          ) : null}
        </div>

        <footer className="fullscreen-review__footer">
          <div className="fullscreen-review__shortcuts" aria-hidden="true">
            {FULLSCREEN_PLAYER_SHORTCUTS.map((shortcut) => (
              <span key={shortcut.id}>
                {shortcut.keys.join(" / ")} {shortcut.label}
              </span>
            ))}
          </div>
          <div
            id={liveId}
            className="fullscreen-review__live"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {statusContent || notice}
          </div>
        </footer>
      </div>
    </dialog>,
    document.body
  );
});

export default FullScreenModal;
