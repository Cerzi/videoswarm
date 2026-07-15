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
import "./FullScreenModal.css";

const LOAD_TIMEOUT_MS = 15_000;
const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "video[controls]",
].join(",");

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
    detailsOpen,
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
    onBoundary,
    onClose,
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
  const mutedPreferenceRef = useRef(true);

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState("");
  const [videoLoaded, setVideoLoaded] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [retryRevision, setRetryRevision] = useState(0);

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

  const resetSessionAudio = useCallback(() => {
    mutedPreferenceRef.current = true;
    const element = mediaRef.current;
    if (element) {
      try {
        element.muted = true;
      } catch {}
    }
    setIsMuted(true);
  }, []);

  const releaseActiveSource = useCallback(
    ({ resetAudio = false } = {}) => {
      const release = activeReleaseRef.current;
      const released = typeof release === "function" ? release() : false;
      if (resetAudio) resetSessionAudio();
      return released;
    },
    [resetSessionAudio]
  );

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
  }, []);

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
      releaseActiveSource({ resetAudio: true });
      safeCloseDialog(dialogRef.current);
      callbackRef.current.onClose?.(reason);
      return true;
    },
    [releaseActiveSource]
  );

  const requestNavigate = useCallback(
    (direction) => {
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
    [canNavigateNext, canNavigatePrevious]
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

    // Chromium's native video controls can also react to Space on keyup.
    // Consume that half of the gesture so one press produces one toggle.
    const handleKeyUp = (event) => {
      if (isEditableTarget(event.target)) return;
      const binding = resolveFullscreenShortcut(event);
      if (binding?.command !== FULLSCREEN_COMMANDS.PLAYBACK) return;
      if (preservesNativeSpaceActivation(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("keyup", handleKeyUp, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("keyup", handleKeyUp, true);
    };
  }, [handleEscape, requestNavigate, toggleAudio, togglePlayback, video ? true : false]);

  const handleBackdropClick = useCallback(
    (event) => {
      if (event.target === dialogRef.current) requestClose("backdrop");
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
    if (didChange) setNotice(nextMuted ? "Audio muted" : "Audio on");
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

          <main className="fullscreen-review__stage">
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

            <div className="fullscreen-review__media-wrap">
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
                onClick={(event) => event.stopPropagation()}
                onPlay={() => {
                  playbackIntentRef.current = true;
                }}
                onPause={() => {
                  playbackIntentRef.current = false;
                }}
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
