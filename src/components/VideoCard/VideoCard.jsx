// src/components/VideoCard/VideoCard.jsx
import React, { useState, useEffect, useRef, useCallback, memo, useMemo } from "react";
import { classifyMediaError } from "./mediaError";
import { toFileURL, hardDetach } from "./videoDom";
import { useVideoStallWatchdog } from "../../hooks/useVideoStallWatchdog";
import { thumbService, signatureForVideo } from "../../services/thumbService";

const RECOVERY_TIMEOUT_MS = 4000;

const waitForPlayableData = (
  element,
  timeoutMs = RECOVERY_TIMEOUT_MS,
  onCancelReady = null
) =>
  new Promise((resolve, reject) => {
    const readyThreshold =
      (typeof HTMLMediaElement !== "undefined" &&
        Number(HTMLMediaElement.HAVE_CURRENT_DATA)) ||
      2;
    if (element.readyState >= readyThreshold) {
      resolve();
      return;
    }

    let timeoutId = null;
    let settled = false;
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      element.removeEventListener("loadeddata", onReady);
      element.removeEventListener("canplay", onReady);
      element.removeEventListener("error", onError);
    };
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onReady = () => {
      if (element.readyState >= readyThreshold) finish();
      else finish(new Error("Media recovery did not produce playable data"));
    };
    const onError = (event) => {
      finish(event?.target?.error || new Error("Media recovery failed"));
    };

    element.addEventListener("loadeddata", onReady);
    element.addEventListener("canplay", onReady);
    element.addEventListener("error", onError);
    timeoutId = setTimeout(() => {
      finish(new Error("Timed out recovering media data"));
    }, timeoutMs);
    onCancelReady?.(() => finish(new Error("Media recovery cancelled")));
  });

const playWithTimeout = async (element, timeoutMs = RECOVERY_TIMEOUT_MS) => {
  let timeoutId = null;
  try {
    const playResult = element.play();
    if (!playResult?.then) return;
    await Promise.race([
      playResult,
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Timed out restarting media playback")),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const VideoCard = memo(function VideoCard({
  video,
  selected,
  onSelect,
  onContextMenu,
  onNativeDragStart,

  // orchestration + metrics
  isPlaying,
  isLoaded,
  isLoading,
  isVisible,
  playbackSuspended = false,
  showFilenames = true,

  // limits & callbacks (owned by parent/orchestrator)
  canLoadVideo,           // (id, options?) => boolean
  canLoadMoreVideos,      // legacy: (options?) => boolean
  reserveLoadSlot,        // (id, options?) => opaque loader lease | null
  queueLoadSlot,          // (id, options, onGranted) => opaque waiter lease
  cancelQueuedLoadSlot,   // (waiter lease) => boolean
  finishLoadSlot,         // (lease, { ready }) => resident lease | boolean
  releaseMediaSlot,       // (resident lease) => boolean
  decoderLease = null,    // opaque decoder ownership for this card generation
  onStartLoading,         // (id)
  onStopLoading,          // (id)
  onVideoLoad,            // (id, aspectRatio)
  onVideoPlay,            // (id)
  onVideoPause,           // (id)
  onPlayError,            // (id, error)
  reportPlayerCreationFailure,
  onVisibilityChange,     // (id, visible)
  onHover,                // (id)
  hoverAudioEnabled = false,
  isHoverAudioActive = false,
  onHoverAudioStart,      // (id)
  onHoverAudioEnd,        // (id)
  onUnmount,              // (id)
  onMediaInvalidated,     // (id) file identity changed in-place

  // IO registry
  observeIntersection,    // (el, id, cb)
  unobserveIntersection,  // (el)=>void
  isNear = () => true,
  scrollRootRef = null,

  // optional init scheduler
  scheduleInit = null,
}) {
  const cardRef = useRef(null);
  const videoContainerRef = useRef(null);
  const videoRef = useRef(null);
  const visibilityRef = useRef(Boolean(isVisible));
  const fullPathRef = useRef(video?.fullPath ?? null);
  const signatureRef = useRef(null);

  const clickTimeoutRef = useRef(null);
  const loadTimeoutRef = useRef(null);
  const retryTimeoutRef = useRef(null);
  const mountedRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const scheduledInitCancelRef = useRef(null);
  const queuedLoadWaiterRef = useRef(null);
  const attemptCleanupRef = useRef(null);
  const loadingReservationRef = useRef(null);
  const mediaReservationRef = useRef(null);
  const pendingAspectRatioRef = useRef(null);
  const watchdogRecoveryRef = useRef(false);
  const loadVideoRef = useRef(null);

  // local mirrors (parent is source of truth)
  const videoId = video.id || video.fullPath || video.name;
  const mediaIdentity = `${videoId}::${video?.fullPath || ""}::${
    video?.size ?? ""
  }::${video?.dateModified ?? ""}`;
  const videoIdRef = useRef(videoId);
  const mediaIdentityRef = useRef({ signature: mediaIdentity, videoId });
  const onHoverAudioEndRef = useRef(onHoverAudioEnd);
  const onUnmountRef = useRef(onUnmount);
  videoIdRef.current = videoId;
  onHoverAudioEndRef.current = onHoverAudioEnd;
  onUnmountRef.current = onUnmount;
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);

  // guards
  const loadRequestedRef = useRef(false);
  const metaNotifiedRef = useRef(false);
  const permanentErrorRef = useRef(false);
  const retryAttemptsRef   = useRef(0);
  const suppressErrorsRef  = useRef(false); // ignore unload-induced errors
  const lastFailureAtRef   = useRef(0);

  const [errorText, setErrorText] = useState(null);
  const initialNear = (isNear?.(videoId) ?? true) === true;
  const [isNearViewport, setIsNearViewport] = useState(initialNear);
  const nearStateRef = useRef(initialNear);

  const lastObservedVisibilityRef = useRef(Boolean(isVisible));

  const shouldEnsureLoad = isVisible || isNearViewport;

  const checkCanLoad = useCallback(
    (options) => {
      if (typeof canLoadVideo === "function") {
        return canLoadVideo(videoId, options);
      }
      return canLoadMoreVideos?.(options);
    },
    [canLoadVideo, canLoadMoreVideos, videoId]
  );

  const hasRenderableVideo = useCallback(() => {
    const el = videoRef.current;
    if (!el) return false;

    const container = videoContainerRef.current;
    if (!container) {
      return typeof el.isConnected === "boolean" ? el.isConnected : true;
    }

    if (!container.contains(el)) return false;
    if (typeof el.isConnected === "boolean" && !el.isConnected) return false;

    return true;
  }, []);
  const fullPath = video?.fullPath ?? null;
  const thumbSignature = useMemo(() => signatureForVideo(video), [
    video.fullPath,
    video.size,
    video.dateModified,
  ]);
  const canStartNativeDrag = Boolean(video?.isElectronFile && video?.fullPath);

  const ratingValue =
    typeof video?.rating === "number" && Number.isFinite(video.rating)
      ? Math.max(0, Math.min(5, Math.round(video.rating)))
      : null;
  const hasTags = Array.isArray(video?.tags) && video.tags.length > 0;
  const tagPreview = hasTags ? video.tags.slice(0, 3) : [];
  const extraTagCount = hasTags ? Math.max(0, video.tags.length - tagPreview.length) : 0;

  const aspectRatioHint = (() => {
    const direct = Number(video?.aspectRatio);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const dimRatio = Number(video?.dimensions?.aspectRatio);
    if (Number.isFinite(dimRatio) && dimRatio > 0) return dimRatio;
    const width = Number(video?.dimensions?.width);
    const height = Number(video?.dimensions?.height);
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      return width / height;
    }
    return null;
  })();

  const effectiveAspectRatio = aspectRatioHint && aspectRatioHint > 0 ? aspectRatioHint : 16 / 9;

  const stopLoadingReservation = useCallback((generation = null, ready = false) => {
    const reservation = loadingReservationRef.current;
    if (!reservation) return null;
    if (generation !== null && reservation.generation !== generation) return null;

    loadingReservationRef.current = null;
    let residentLease = null;
    if (reservation.lease) {
      residentLease = finishLoadSlot?.(reservation.lease, { ready }) || null;
      if (ready && residentLease) {
        mediaReservationRef.current = residentLease;
      }
    }
    reservation.onStopLoading?.(reservation.videoId);
    return residentLease;
  }, [finishLoadSlot]);

  const releaseOwnedMediaSlot = useCallback(() => {
    const reservation = mediaReservationRef.current;
    if (!reservation) return false;
    mediaReservationRef.current = null;
    return releaseMediaSlot?.(reservation) ?? false;
  }, [releaseMediaSlot]);

  const cancelQueuedLoad = useCallback(() => {
    const waiterLease = queuedLoadWaiterRef.current;
    if (!waiterLease) return false;
    queuedLoadWaiterRef.current = null;
    return cancelQueuedLoadSlot?.(waiterLease) ?? false;
  }, [cancelQueuedLoadSlot]);

  const disposeVideoElement = useCallback((el) => {
    if (!el) return false;

    try {
      suppressErrorsRef.current = true;
      hardDetach(el);
      el.remove();
    } catch {}
    finally {
      suppressErrorsRef.current = false;
    }

    if (videoRef.current === el) videoRef.current = null;
    releaseOwnedMediaSlot();
    return true;
  }, [releaseOwnedMediaSlot]);

  const cancelLoadAttempt = useCallback(() => {
    loadGenerationRef.current += 1;

    cancelQueuedLoad();

    scheduledInitCancelRef.current?.();
    scheduledInitCancelRef.current = null;

    attemptCleanupRef.current?.();
    attemptCleanupRef.current = null;

    if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    retryTimeoutRef.current = null;

    const el = videoRef.current;
    if (el) disposeVideoElement(el);
    else releaseOwnedMediaSlot();

    stopLoadingReservation();

    loadRequestedRef.current = false;
    metaNotifiedRef.current = false;
    pendingAspectRatioRef.current = null;
  }, [
    cancelQueuedLoad,
    disposeVideoElement,
    releaseOwnedMediaSlot,
    stopLoadingReservation,
  ]);

  const syncVideoIntoContainer = useCallback((container, el) => {
    if (!container || !el) return;

    const nodes = Array.from(container.childNodes || []);
    for (const node of nodes) {
      if (node === el) continue;
      const isVideoNode =
        typeof node?.nodeName === "string" && node.nodeName.toLowerCase() === "video";
      if (isVideoNode && node?.parentNode === container) {
        try {
          hardDetach(node);
          node.remove?.();
        } catch {}
      }
    }

    const parent = el.parentNode;
    if (parent && parent !== container && parent.contains?.(el)) {
      try {
        parent.removeChild(el);
      } catch {}
    }

    if (el.parentNode !== container) {
      container.appendChild(el);
    } else if (container.lastChild !== el) {
      container.appendChild(el);
    }
  }, []);

  useEffect(() => {
    const nextVisible = Boolean(isVisible);
    visibilityRef.current = nextVisible;
    lastObservedVisibilityRef.current = nextVisible;
  }, [isVisible]);

  useEffect(() => {
    fullPathRef.current = fullPath;
  }, [fullPath]);

  useEffect(() => {
    const nextNear = (isNear?.(videoId) ?? true) === true;
    nearStateRef.current = nextNear;
    setIsNearViewport((prev) => (prev === nextNear ? prev : nextNear));
  }, [isNear, videoId]);

  useEffect(() => {
    signatureRef.current = thumbSignature;
    if (!shouldEnsureLoad) return;
    if (fullPath && thumbSignature) {
      thumbService.noteVideoMetadata(fullPath, thumbSignature);
    }
  }, [fullPath, thumbSignature, shouldEnsureLoad]);

  const requestThumbnail = useCallback(
    (reason) => {
      if (!canStartNativeDrag) return;
      const path = fullPathRef.current;
      const signature = signatureRef.current;
      const element = videoRef.current;
      if (!path || !signature || !element) return;
      thumbService.requestCapture({
        path,
        signature,
        videoElement: element,
        isVisible: () => visibilityRef.current,
        reason,
      });
    },
    [canStartNativeDrag]
  );

  // mirror flags
  useEffect(() => setLoaded(isLoaded), [isLoaded]);
  useEffect(() => setLoading(isLoading), [isLoading]);

  const isPlayingRef = useRef(isPlaying);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    if (visibilityRef.current && isPlayingRef.current) {
      requestThumbnail("visible-change");
    }
  }, [isVisible, requestThumbnail]);

  // A same-key file update must invalidate every closure and lease from the
  // prior file generation before a replacement can start.
  useEffect(() => {
    const previous = mediaIdentityRef.current;
    if (previous.signature === mediaIdentity) return;

    cancelLoadAttempt();
    onMediaInvalidated?.(previous.videoId);
    mediaIdentityRef.current = { signature: mediaIdentity, videoId };
    permanentErrorRef.current = false;
    retryAttemptsRef.current = 0;
    setErrorText(null);
    setLoaded(false);
    setLoading(false);
    lastFailureAtRef.current = 0;
  }, [cancelLoadAttempt, mediaIdentity, onMediaInvalidated, videoId]);

  // Teardown when parent says this card no longer owns media resources.
  useEffect(() => {
    if (!isLoaded && !isLoading && videoRef.current) {
      cancelLoadAttempt();
      setLoaded(false);
      setLoading(false);
    }
  }, [isLoaded, isLoading, cancelLoadAttempt]);

  // Orchestrated play/pause + error handling
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const effectGeneration = loadGenerationRef.current;
    let effectDisposed = false;
    let recoveryInFlight = false;
    const isCurrentElement = () =>
      !effectDisposed &&
      mountedRef.current &&
      loadGenerationRef.current === effectGeneration &&
      videoRef.current === el;

    const handlePlaying = () => {
      if (!isCurrentElement()) return;
      const accepted = onVideoPlay?.(videoId, decoderLease);
      if (accepted === false) {
        try { el.pause(); } catch {}
        onVideoPause?.(videoId, decoderLease);
        return;
      }
      requestThumbnail("playing-event");
    };
    const handlePause = () => {
      if (
        !isCurrentElement() ||
        recoveryInFlight ||
        watchdogRecoveryRef.current ||
        el.dataset.mediaOperation === "frame-capture"
      ) {
        return;
      }
      onVideoPause?.(videoId, decoderLease);
    };

    const handleError = async (e) => {
      if (
        suppressErrorsRef.current ||
        !isCurrentElement() ||
        recoveryInFlight
      ) {
        return;
      }
      const err = e?.target?.error || e;
      const { terminal, label } = classifyMediaError(err);
      recoveryInFlight = true;
      let recovered = false;

      if (!terminal) {
        try {
          const t = el.currentTime || 0;
          el.pause();
          el.load();
          try { el.currentTime = t; } catch {}
          await playWithTimeout(el);
          const readyThreshold =
            (typeof HTMLMediaElement !== "undefined" &&
              Number(HTMLMediaElement.HAVE_CURRENT_DATA)) ||
            2;
          if (el.readyState < readyThreshold) {
            throw new Error("Media recovery did not produce playable data");
          }
          recovered = isCurrentElement();
        } catch {}
      }
      recoveryInFlight = false;

      if (recovered) {
        setErrorText(null);
        return;
      }
      if (!isCurrentElement()) return;

      const currentMediaLease = mediaReservationRef.current;
      const accepted = onPlayError?.(
        videoId,
        err,
        decoderLease,
        currentMediaLease
      );
      if (accepted === false) return;

      if (terminal) {
        permanentErrorRef.current = true;
        if (err?.code === 3 && el.currentSrc) {
          reportPlayerCreationFailure?.();
        }
      }
      lastFailureAtRef.current = Date.now();
      setErrorText(`⚠️ ${label}`);
      setLoaded(false);
      setLoading(false);
      loadRequestedRef.current = false;
      disposeVideoElement(el);
      if (!terminal) {
        retryTimeoutRef.current = setTimeout(() => {
          retryTimeoutRef.current = null;
          if (
            mountedRef.current &&
            visibilityRef.current &&
            !videoRef.current &&
            !loadRequestedRef.current
          ) {
            setErrorText(null);
            loadVideoRef.current?.({ assumeVisible: true });
          }
        }, 2500);
      }
    };

    el.addEventListener("playing", handlePlaying);
    el.addEventListener("pause",   handlePause);
    el.addEventListener("error",   handleError);

    const shouldPlay =
      !playbackSuspended &&
      isPlaying &&
      isVisible &&
      loaded &&
      !permanentErrorRef.current;
    if (shouldPlay) {
      el.dataset.playbackDesired = "true";
      el.muted = !isHoverAudioActive;
      if (isHoverAudioActive) {
        el.volume = 1;
      }
      const p = el.play();
      if (p?.catch) {
        p.catch((err) => {
          if (isHoverAudioActive && err?.name === "NotAllowedError") {
            try {
              el.muted = true;
              el.play()?.catch?.((retryError) => {
                if (isCurrentElement()) {
                  handleError({ target: { error: retryError } });
                }
              });
            } catch {}
            return;
          }
          if (isCurrentElement()) {
            handleError({ target: { error: err } });
          }
        });
      }
    } else {
      el.dataset.playbackDesired = "false";
      el.muted = true;
      try { el.pause(); } catch {}
      onVideoPause?.(videoId, decoderLease);
    }

    return () => {
      effectDisposed = true;
      el.removeEventListener("playing", handlePlaying);
      el.removeEventListener("pause",   handlePause);
      el.removeEventListener("error",   handleError);
    };
  }, [
    isPlaying,
    isVisible,
    loaded,
    playbackSuspended,
    isHoverAudioActive,
    videoId,
    onVideoPlay,
    onVideoPause,
    onPlayError,
    decoderLease,
    disposeVideoElement,
    reportPlayerCreationFailure,
  ]);

  // Quiet stall watchdog (no visual changes)
  useEffect(() => {
    const watchedElement = videoRef.current;
    if (!watchedElement) return;
    const enable =
      !playbackSuspended &&
      loaded &&
      isPlaying &&
      isVisible &&
      !permanentErrorRef.current;
    let teardown = null;
    if (enable) {
      teardown = useVideoStallWatchdog(videoRef, {
        id: videoId,
        tickMs: 2500,        // slightly slower to reduce overhead
        minDeltaSec: 0.12,
        ticksToStall: 3,     // ~7.5s
        maxLogsPerMin: 1,
        onRecoveryStart: () => {
          watchdogRecoveryRef.current = true;
        },
        onRecoveryEnd: () => {
          watchdogRecoveryRef.current = false;
        },
        onRecoveryError: (error) => {
          if (!mountedRef.current || videoRef.current !== watchedElement) return;
          const accepted = onPlayError?.(
            videoId,
            error,
            decoderLease,
            mediaReservationRef.current
          );
          if (accepted === false) return;
          lastFailureAtRef.current = Date.now();
          setErrorText("⚠️ Playback stalled");
          setLoaded(false);
          setLoading(false);
          loadRequestedRef.current = false;
          disposeVideoElement(watchedElement);
          retryTimeoutRef.current = setTimeout(() => {
            retryTimeoutRef.current = null;
            if (
              mountedRef.current &&
              visibilityRef.current &&
              !videoRef.current &&
              !loadRequestedRef.current
            ) {
              setErrorText(null);
              loadVideoRef.current?.({ assumeVisible: true });
            }
          }, 2500);
        },
      });
    }
    return () => { if (teardown) teardown(); };
  }, [
    isPlaying,
    isVisible,
    loaded,
    playbackSuspended,
    videoId,
    decoderLease,
    disposeVideoElement,
    onPlayError,
  ]);

  // create & load <video>
  const loadVideo = useCallback((options = {}) => {
    if (!mountedRef.current) return;
    if (
      loading ||
      loadRequestedRef.current ||
      queuedLoadWaiterRef.current
    ) {
      return;
    }
    if (hasRenderableVideo()) return;
    if (permanentErrorRef.current) return;

    // A detached/stale resident must be physically torn down before its slot
    // becomes available to a replacement generation.
    if (videoRef.current || mediaReservationRef.current) {
      const staleElement = videoRef.current;
      if (staleElement) disposeVideoElement(staleElement);
      else releaseOwnedMediaSlot();
      setLoaded(false);
      onMediaInvalidated?.(videoId);
    }

    const admissionOptions = {
      ...options,
      replaceResident: false,
    };
    const beginReservedLoad = (loaderLease = null) => {
      if (
        !mountedRef.current ||
        loadRequestedRef.current ||
        hasRenderableVideo() ||
        permanentErrorRef.current
      ) {
        return false;
      }

      setErrorText(null);
      metaNotifiedRef.current = false;
      pendingAspectRatioRef.current = null;

      const generation = loadGenerationRef.current + 1;
      loadGenerationRef.current = generation;
      loadRequestedRef.current = true;
      loadingReservationRef.current = {
        generation,
        videoId,
        onStopLoading,
        lease: loaderLease,
      };
      onStartLoading?.(videoId);
      setLoading(true);

      const runInit = () => {
        scheduledInitCancelRef.current = null;
        if (!mountedRef.current || loadGenerationRef.current !== generation) {
          stopLoadingReservation(generation, false);
          return;
        }

        const el = document.createElement("video");
        // Track the node before starting any asynchronous media work. An unmount
        // that happens before loadeddata must still be able to release its source.
        videoRef.current = el;

        el.muted = true;
        el.loop = true;
        el.playsInline = true;
        // Admission is already bounded. `metadata` can stop before loadeddata and
        // strand a loader forever, so every granted attempt uses one clear ready
        // transition and a bounded timeout.
        el.preload = "auto";
        el.className = "video-element";
        el.dataset.videoId = videoId;
        el.style.width = "100%";
        el.style.height = "100%";
        el.style.objectFit = "cover";
        el.style.display = "block";

        const isCurrentAttempt = () =>
          mountedRef.current &&
          loadGenerationRef.current === generation &&
          videoRef.current === el;

        const cleanupAttempt = () => {
          clearTimeout(loadTimeoutRef.current);
          loadTimeoutRef.current = null;
          el.removeEventListener("loadedmetadata", onMeta);
          el.removeEventListener("loadeddata",    onLoadedData);
          el.removeEventListener("error",         onErr);
          if (attemptCleanupRef.current === cleanupAttempt) {
            attemptCleanupRef.current = null;
          }
        };

        const finishStopLoading = (ready = false) => {
          const hadSchedulerLease = Boolean(
            loadingReservationRef.current?.lease
          );
          const residentLease = stopLoadingReservation(generation, ready);
          if (mountedRef.current && loadGenerationRef.current === generation) {
            setLoading(false);
            if (ready) {
              loadRequestedRef.current = false;
              lastFailureAtRef.current = 0;
            }
          }
          return !ready || !hadSchedulerLease || Boolean(residentLease);
        };

        const onMeta = () => {
          if (!isCurrentAttempt()) return;
          if (!metaNotifiedRef.current) {
            metaNotifiedRef.current = true;
            pendingAspectRatioRef.current =
              el.videoWidth && el.videoHeight
                ? el.videoWidth / el.videoHeight
                : 16 / 9;
          }
        };

        const notifyReady = () => {
          onMeta();
          onVideoLoad?.(
            videoId,
            pendingAspectRatioRef.current || 16 / 9
          );
        };

        const onLoadedData = () => {
          if (!isCurrentAttempt()) return;
          cleanupAttempt();
          syncVideoIntoContainer(videoContainerRef.current, el);
          if (!finishStopLoading(true)) {
            disposeVideoElement(el);
            return;
          }
          setLoaded(true);
          notifyReady();
        };

        let recoveryInFlight = false;
        const onErr = async (e) => {
          if (
            suppressErrorsRef.current ||
            !isCurrentAttempt() ||
            recoveryInFlight
          ) {
            return;
          }
          recoveryInFlight = true;
          cleanupAttempt();

          const err = e?.target?.error || e;
          const { terminal, label } = classifyMediaError(err);

          const code = err?.code ?? null;
          const isLocal = Boolean(video.isElectronFile && video.fullPath);
          const looksTransientLocal =
            isLocal && code === 4 && retryAttemptsRef.current < 1;

          let recovered = false;
          if (!terminal) {
            let cancelRecovery = null;
            const cleanupRecovery = () => {
              cancelRecovery?.();
              if (attemptCleanupRef.current === cleanupRecovery) {
                attemptCleanupRef.current = null;
              }
            };
            attemptCleanupRef.current = cleanupRecovery;
            try {
              const t = el.currentTime || 0;
              const readyPromise = waitForPlayableData(
                el,
                RECOVERY_TIMEOUT_MS,
                (cancel) => {
                  cancelRecovery = cancel;
                }
              );
              el.pause();
              el.load();
              try { el.currentTime = t; } catch {}
              await readyPromise;
              recovered = isCurrentAttempt();
            } catch {}
            if (attemptCleanupRef.current === cleanupRecovery) {
              attemptCleanupRef.current = null;
            }
          }

          recoveryInFlight = false;
          if (recovered) {
            syncVideoIntoContainer(videoContainerRef.current, el);
            if (!finishStopLoading(true)) {
              disposeVideoElement(el);
              return;
            }
            setLoaded(true);
            setErrorText(null);
            notifyReady();
            return;
          }

          if (!isCurrentAttempt()) return;

          const currentLoaderLease = loadingReservationRef.current?.lease || null;
          const accepted = onPlayError?.(
            videoId,
            err,
            null,
            currentLoaderLease
          );
          const shouldDeratePlayerLimit = code === 3 && Boolean(el.currentSrc);

          loadRequestedRef.current = false;
          lastFailureAtRef.current = Date.now();
          disposeVideoElement(el);
          finishStopLoading(false);
          if (accepted === false) return;

          if (terminal && !looksTransientLocal) {
            permanentErrorRef.current = true;
            if (shouldDeratePlayerLimit) {
              reportPlayerCreationFailure?.();
            }
          }

          setErrorText(
            `⚠️ ${looksTransientLocal ? "Temporary read error" : label}`
          );

          // Retry once for transient local errors. A fresh attempt must obtain
          // a fresh scheduler lease (or wait in its priority queue).
          if (!permanentErrorRef.current && (looksTransientLocal || !terminal)) {
            if (looksTransientLocal) retryAttemptsRef.current += 1;
            retryTimeoutRef.current = setTimeout(() => {
              retryTimeoutRef.current = null;
              if (
                mountedRef.current &&
                loadGenerationRef.current === generation &&
                visibilityRef.current &&
                !loadRequestedRef.current &&
                !videoRef.current
              ) {
                loadVideo({ assumeVisible: true });
              }
            }, looksTransientLocal ? 1200 : 2500);
          }
        };

        // A granted loader always has a deadline, including near-viewport work.
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = setTimeout(() => {
          if (isCurrentAttempt()) {
            onErr({ target: { error: new Error("Loading timeout") } });
          }
        }, 10000);

        el.addEventListener("loadedmetadata", onMeta);
        el.addEventListener("loadeddata",    onLoadedData);
        el.addEventListener("error",         onErr);
        attemptCleanupRef.current = cleanupAttempt;

        try {
          if (video.isElectronFile && video.fullPath) {
            el.src = toFileURL(video.fullPath);
          } else if (video.file) {
            el.src = URL.createObjectURL(video.file);
          } else if (video.fullPath || video.relativePath) {
            el.src = video.fullPath || video.relativePath;
          } else {
            throw new Error("No valid video source");
          }

          el.load();
          // No warm-start play/pause (keeps CPU/GPU quieter)
        } catch (err) {
          onErr({ target: { error: err } });
        }
      };

      const startInit = () => {
        try {
          runInit();
        } catch (error) {
          const currentLoaderLease =
            loadingReservationRef.current?.lease || null;
          const accepted = onPlayError?.(
            videoId,
            error,
            null,
            currentLoaderLease
          );
          const el = videoRef.current;
          if (el) disposeVideoElement(el);
          stopLoadingReservation(generation, false);
          loadRequestedRef.current = false;
          setLoading(false);
          if (accepted !== false) {
            setErrorText("⚠️ Failed to initialize player");
            reportPlayerCreationFailure?.();
          }
        }
      };

      if (typeof scheduleInit === "function") {
        let started = false;
        const cancel = scheduleInit(() => {
          started = true;
          startInit();
        });
        if (!started && typeof cancel === "function") {
          scheduledInitCancelRef.current = cancel;
        }
      } else {
        startInit();
      }
      return true;
    };

    let loaderLease = null;
    if (typeof reserveLoadSlot === "function") {
      loaderLease = reserveLoadSlot(videoId, admissionOptions);
      if (!loaderLease) {
        const shouldQueue =
          typeof queueLoadSlot === "function" &&
          (Boolean(options?.assumeVisible) || visibilityRef.current);
        if (!shouldQueue) return;

        let waiterLease = null;
        waiterLease = queueLoadSlot(
          videoId,
          { ...admissionOptions, assumeVisible: true },
          (grantedLease) => {
            if (queuedLoadWaiterRef.current !== waiterLease) return false;
            queuedLoadWaiterRef.current = null;
            if (!visibilityRef.current) return false;
            return beginReservedLoad(grantedLease);
          }
        );
        if (waiterLease) queuedLoadWaiterRef.current = waiterLease;
        return;
      }
    } else {
      const allowLoad = checkCanLoad(admissionOptions);
      if (allowLoad === false) return;
    }

    beginReservedLoad(loaderLease);
  }, [
    video,
    videoId,
    checkCanLoad,
    reserveLoadSlot,
    queueLoadSlot,
    loading,
    hasRenderableVideo,
    onStartLoading,
    onStopLoading,
    onVideoLoad,
    onPlayError,
    scheduleInit,
    syncVideoIntoContainer,
    disposeVideoElement,
    releaseOwnedMediaSlot,
    stopLoadingReservation,
    reportPlayerCreationFailure,
    onMediaInvalidated,
  ]);
  loadVideoRef.current = loadVideo;

  const ensureVisibleAndLoad = useCallback(() => {
    if (!isVisible && !nearStateRef.current) {
      return false;
    }
    if (loading || loadRequestedRef.current || hasRenderableVideo()) {
      return false;
    }
    if (permanentErrorRef.current) return false;
    const lastFailureAt = lastFailureAtRef.current;
    if (lastFailureAt && Date.now() - lastFailureAt < 2000) return false;

    const card = cardRef.current;
    if (!card || typeof card.getBoundingClientRect !== "function") return false;

    const rect = card.getBoundingClientRect();
    const rootEl = scrollRootRef?.current;
    let top = 0;
    let bottom = typeof window !== "undefined" ? window.innerHeight : 0;

    if (rootEl && typeof rootEl.getBoundingClientRect === "function") {
      const rootRect = rootEl.getBoundingClientRect();
      top = rootRect.top;
      bottom = rootRect.bottom;
    }

    const inView = rect.bottom > top && rect.top < bottom;
    let assumeVisible = inView;
    if (!inView) {
      const degenerateHeight = Math.abs(rect.bottom - rect.top);
      const degenerateWidth = Math.abs(rect.right - rect.left);
      const isDegenerate = degenerateHeight < 1 && degenerateWidth < 1;
      if (isDegenerate && visibilityRef.current) {
        assumeVisible = true;
      } else {
        return false;
      }
    }

    const loadOptions = assumeVisible ? { assumeVisible: true } : undefined;
    const allow = checkCanLoad(loadOptions);
    if (allow === false && typeof queueLoadSlot !== "function") return false;

    loadVideo(loadOptions);
    return true;
  }, [
    checkCanLoad,
    loadVideo,
    loading,
    scrollRootRef,
    hasRenderableVideo,
    isVisible,
    queueLoadSlot,
  ]);

  useEffect(() => {
    const el = videoRef.current;
    const container = videoContainerRef.current;
    syncVideoIntoContainer(container, el);
  }, [loaded, showFilenames, syncVideoIntoContainer]);

  useEffect(() => {
    if (!shouldEnsureLoad) return undefined;

    let raf = 0;
    const run = () => {
      raf = 0;
      ensureVisibleAndLoad();
    };

    if (typeof requestAnimationFrame === "function") {
      raf = requestAnimationFrame(run);
      return () => {
        if (raf && typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(raf);
        }
      };
    }

    run();
    return undefined;
  }, [ensureVisibleAndLoad, shouldEnsureLoad]);

  useEffect(() => {
    if (!isVisible) cancelQueuedLoad();
  }, [cancelQueuedLoad, isVisible]);

  // IO registration for visibility
  useEffect(() => {
    const el = cardRef.current;
    if (!el || !observeIntersection || !unobserveIntersection) return;

    const handleVisible = (nowVisible /* boolean */, entry) => {
      visibilityRef.current = Boolean(nowVisible);
      if (entry) {
        const nextNear = (isNear?.(videoId) ?? true) === true;
        if (nearStateRef.current !== nextNear) {
          nearStateRef.current = nextNear;
          setIsNearViewport((prev) => (prev === nextNear ? prev : nextNear));
        }
      }

      if (lastObservedVisibilityRef.current !== nowVisible) {
        lastObservedVisibilityRef.current = nowVisible;
        onVisibilityChange?.(videoId, nowVisible);
      }

      if (nowVisible) {
        ensureVisibleAndLoad();
      }
    };

    observeIntersection(el, videoId, handleVisible);
    return () => {
      unobserveIntersection(el);
    };
  }, [
    observeIntersection,
    unobserveIntersection,
    videoId,
    onVisibilityChange,
    ensureVisibleAndLoad,
  ]);

  // Backup trigger if parent already flags visible
  useEffect(() => {
    if (
      isVisible &&
      !loaded &&
      !loading &&
      !loadRequestedRef.current &&
      !videoRef.current &&
      !permanentErrorRef.current &&
      ((checkCanLoad({ assumeVisible: true }) ?? true) ||
        typeof queueLoadSlot === "function")
    ) {
      Promise.resolve().then(() => {
        if (
          mountedRef.current &&
          isVisible &&
          !loaded &&
          !loading &&
          !loadRequestedRef.current &&
          !videoRef.current &&
          !permanentErrorRef.current &&
          ((checkCanLoad({ assumeVisible: true }) ?? true) ||
            typeof queueLoadSlot === "function")
        ) {
          ensureVisibleAndLoad();
        }
      });
    }
  }, [
    isVisible,
    loaded,
    loading,
    checkCanLoad,
    ensureVisibleAndLoad,
    queueLoadSlot,
  ]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current);
      if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
      cancelLoadAttempt();
      videoRef.current = null;
      onHoverAudioEndRef.current?.(videoIdRef.current);
      onUnmountRef.current?.(videoIdRef.current);
    };
  }, [cancelLoadAttempt]);

  // UI handlers (unchanged)
  const handleClick = useCallback((e) => {
    e.stopPropagation();
    if (clickTimeoutRef.current) {
      clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = null;
      onSelect?.(videoId, e.ctrlKey || e.metaKey, e.shiftKey, true);
      return;
    }
    clickTimeoutRef.current = setTimeout(() => {
      onSelect?.(videoId, e.ctrlKey || e.metaKey, e.shiftKey, false);
      clickTimeoutRef.current = null;
    }, 300);
  }, [onSelect, videoId]);

  const handleContextMenu = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu?.(e, video);
  }, [onContextMenu, video]);

  const handleMouseEnter = useCallback(() => {
    onHover?.(videoId);
    if (hoverAudioEnabled) {
      onHoverAudioStart?.(videoId);
    }
  }, [onHover, videoId, hoverAudioEnabled, onHoverAudioStart]);

  const handleMouseLeave = useCallback(() => {
    if (hoverAudioEnabled) {
      onHoverAudioEnd?.(videoId);
    }
  }, [hoverAudioEnabled, onHoverAudioEnd, videoId]);

  const handleDragStart = useCallback(
    (reactEvent) => {
      if (!onNativeDragStart || !canStartNativeDrag) return;
      reactEvent.preventDefault();
      reactEvent.stopPropagation();
      const nativeEvent = reactEvent.nativeEvent;
      if (nativeEvent?.dataTransfer) {
        try {
          nativeEvent.dataTransfer.effectAllowed = "copy";
          nativeEvent.dataTransfer.dropEffect = "copy";
        } catch (err) {}
      }
      onNativeDragStart(nativeEvent, video);
    },
    [onNativeDragStart, video, canStartNativeDrag]
  );

  const renderPlaceholder = () => {
    if (errorText) {
      const sanitizedErrorText = (() => {
        if (typeof errorText !== "string") return errorText;
        const stripped = errorText.replace(/^\s*⚠️\s*/u, "").trim();
        return stripped.length > 0 ? stripped : errorText;
      })();
      return (
        <div className="error-indicator" role="alert">
          <div className="error-indicator__icon" aria-hidden="true" />
          <div className="error-indicator__message">{sanitizedErrorText}</div>
        </div>
      );
    }

    const canLoad = checkCanLoad(
      isVisible ? { assumeVisible: true } : undefined
    ) ?? true;
    const statusText = loading
      ? "Loading video…"
      : canLoad
      ? "Scroll to load"
      : "Waiting for next chunk";
    const subtext = loading
      ? "Preparing playback"
      : canLoad
      ? "Keep scrolling to fetch more clips"
      : "All caught up for now";

    if (!isNearViewport || !loading) {
      return (
        <div
          className="video-placeholder video-placeholder--static"
          role="status"
          aria-live="polite"
        >
          <div className="video-placeholder__media" aria-hidden="true">
            <div className="video-placeholder__static-block" />
          </div>
          <div className="video-placeholder__text">
            <span className="video-placeholder__message">
              {!isNearViewport && canLoad ? "Scroll closer to load" : statusText}
            </span>
            <span className="video-placeholder__subtext">
              {!isNearViewport
                ? "Thumbnails idle until you're nearby"
                : subtext}
            </span>
          </div>
        </div>
      );
    }

    const spinnerClassName = `video-placeholder__spinner${
      loading ? "" : " video-placeholder__spinner--paused"
    }`;

    return (
      <div className="video-placeholder" role="status" aria-live="polite">
        <div className="video-placeholder__media" aria-hidden="true">
          <div className="video-placeholder__sheen" />
          <div className={spinnerClassName} />
        </div>
        <div className="video-placeholder__text">
          <span className="video-placeholder__message">{statusText}</span>
          <span className="video-placeholder__subtext">{subtext}</span>
        </div>
      </div>
    );
  };

  return (
    <div
      ref={cardRef}
      className={`video-item ${selected ? "selected" : ""} ${loading ? "loading" : ""}`}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onContextMenu={handleContextMenu}
      onDragStart={handleDragStart}
      draggable={canStartNativeDrag}
      data-filename={video.name}
      data-video-id={videoId}
      data-loaded={loaded.toString()}
      data-loading={loading.toString()}
      data-aspect-ratio={effectiveAspectRatio}
      style={{
        userSelect: "none",
        position: "relative",
        width: "100%",
        borderRadius: "8px",
        overflow: "hidden",
        cursor: "pointer",
        border: selected ? "3px solid #007acc" : "1px solid #333",
        background: "#1a1a1a",
        aspectRatio: effectiveAspectRatio,
      }}
    >
      {ratingValue !== null && (
        <div className="video-item-rating" title={`Rated ${ratingValue} / 5`}>
          {Array.from({ length: 5 }).map((_, index) => (
            <span key={index} className={index < ratingValue ? "filled" : ""}>
              ★
            </span>
          ))}
        </div>
      )}

      {hasTags && (
        <div
          className={`video-item-tags ${showFilenames ? "with-filename" : ""}`}
          title={video.tags.join(", ")}
        >
          {tagPreview.map((tag) => (
            <span key={tag} className="video-item-tag">
              #{tag}
            </span>
          ))}
          {extraTagCount > 0 && (
            <span className="video-item-tag more">+{extraTagCount}</span>
          )}
        </div>
      )}

      {loaded && videoRef.current ? (
        <div
          className="video-container"
          style={{ width: "100%", height: showFilenames ? "calc(100% - 40px)" : "100%" }}
          ref={videoContainerRef}
        />
      ) : (
        <div
          className="video-container"
          style={{ width: "100%", height: showFilenames ? "calc(100% - 40px)" : "100%" }}
          ref={videoContainerRef}
        >
          {renderPlaceholder()}
        </div>
      )}

      {showFilenames && (
        <div
          className="video-filename"
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            height: "40px",
            background: "rgba(0, 0, 0, 0.8)",
            color: "#fff",
            padding: "8px",
            fontSize: "0.75rem",
            lineHeight: "1.2",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            display: "flex",
            alignItems: "center",
          }}
        >
          {video.name}
        </div>
      )}
    </div>
  );
});

export default VideoCard;
