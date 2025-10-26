// src/components/VideoCard/VideoCard.jsx
import React, { useState, useEffect, useRef, useCallback, memo, useMemo } from "react";
import { classifyMediaError } from "./mediaError";
import { toFileURL, hardDetach } from "./videoDom";
import { useVideoStallWatchdog } from "../../hooks/useVideoStallWatchdog";
import { thumbService, signatureForVideo } from "../../services/thumbService";

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
  showFilenames = true,

  // limits & callbacks (owned by parent/orchestrator)
  canLoadMoreVideos,      // (options?) => boolean
  onStartLoading,         // (id)
  onStopLoading,          // (id)
  onVideoLoad,            // (id, aspectRatio)
  onVideoPlay,            // (id)
  onVideoPause,           // (id)
  onPlayError,            // (id, error)
  reportPlayerCreationFailure,
  onVisibilityChange,     // (id, visible)
  onHover,                // (id)

  // IO registry
  observeIntersection,    // (el, id, cb)
  unobserveIntersection,  // (el)=>void
  isNear = () => true,
  scrollRootRef = null,
  layoutEpoch = 0,

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

  // local mirrors (parent is source of truth)
  const videoId = video.id || video.fullPath || video.name;
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

  const hasRenderableVideo = useCallback(() => {
    const el = videoRef.current;
    if (!el) return false;
    if (el.dataset?.adopted === "modal") return true;

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

  // Is this <video> currently adopted by the fullscreen modal?
  const isAdoptedByModal = useCallback(() => {
    const el = videoRef.current;
    return !!(el && el.dataset && el.dataset.adopted === "modal");
  }, []);

  const syncVideoIntoContainer = useCallback((container, el) => {
    if (!container || !el) return;
    if (el.dataset?.adopted === "modal") return;

    const nodes = Array.from(container.childNodes || []);
    for (const node of nodes) {
      if (node === el) continue;
      const isVideoNode =
        typeof node?.nodeName === "string" && node.nodeName.toLowerCase() === "video";
      if (isVideoNode && node?.parentNode === container) {
        try {
          container.removeChild(node);
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

  // If file content changed, clear sticky error so we can retry
  useEffect(() => {
    if (permanentErrorRef.current || errorText) {
      permanentErrorRef.current = false;
      retryAttemptsRef.current  = 0;
      setErrorText(null);
      loadRequestedRef.current = false;
      setLoaded(false);
      setLoading(false);
      lastFailureAtRef.current = 0;
    }
  }, [video.id, video.size, video.dateModified]);

  // Teardown when parent says not loaded/not loading (unless adopted by modal)
  useEffect(() => {
    if (isAdoptedByModal()) return;
    if (!isLoaded && !isLoading && videoRef.current) {
      const el = videoRef.current;
      try {
        suppressErrorsRef.current = true;
        if (el.src?.startsWith("blob:")) URL.revokeObjectURL(el.src);
        el.pause();
        el.removeAttribute("src");
        try { el.load(); } catch {}
        el.remove();
      } catch {}
      finally {
        setTimeout(() => { suppressErrorsRef.current = false; }, 0);
      }
      videoRef.current = null;
      loadRequestedRef.current = false;
      metaNotifiedRef.current = false;
      setLoaded(false);
      setLoading(false);
    }
  }, [isLoaded, isLoading, isAdoptedByModal]);

  // Orchestrated play/pause + error handling
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    const handlePlaying = () => {
      onVideoPlay?.(videoId);
      requestThumbnail("playing-event");
    };
    const handlePause   = () => onVideoPause?.(videoId);

    const handleError = async (e) => {
      if (suppressErrorsRef.current) return;
      const err = e?.target?.error || e;
      onPlayError?.(videoId, err);

      const { terminal, label } = classifyMediaError(err);
      const code = err?.code ?? null;
      const decodeWhileActive =
        code === 3 && el.currentSrc && !suppressErrorsRef.current;

      // Soft recovery first
      try {
        const t = el.currentTime || 0;
        el.pause();
        el.load();
        try { el.currentTime = t; } catch {}
        await el.play().catch(() => {});
        setErrorText(null);
        return;
      } catch {}

      if (terminal && decodeWhileActive) {
        permanentErrorRef.current = true;
      }
      setErrorText(`⚠️ ${label}`);
      hardDetach(el);
    };

    el.addEventListener("playing", handlePlaying);
    el.addEventListener("pause",   handlePause);
    el.addEventListener("error",   handleError);

    if (isPlaying && isVisible && loaded && !permanentErrorRef.current) {
      const p = el.play();
      if (p?.catch) p.catch((err) => handleError({ target: { error: err } }));
    } else {
      try { el.pause(); } catch {}
    }

    return () => {
      el.removeEventListener("playing", handlePlaying);
      el.removeEventListener("pause",   handlePause);
      el.removeEventListener("error",   handleError);
    };
  }, [isPlaying, isVisible, loaded, videoId, onVideoPlay, onVideoPause, onPlayError]);

  // Quiet stall watchdog (no visual changes)
  useEffect(() => {
    if (!videoRef.current) return;
    const enable =
      loaded && isPlaying && isVisible && !isAdoptedByModal() && !permanentErrorRef.current;
    let teardown = null;
    if (enable) {
      teardown = useVideoStallWatchdog(videoRef, {
        id: videoId,
        tickMs: 2500,        // slightly slower to reduce overhead
        minDeltaSec: 0.12,
        ticksToStall: 3,     // ~7.5s
        maxLogsPerMin: 1,
      });
    }
    return () => { if (teardown) teardown(); };
  }, [loaded, isPlaying, isVisible, isAdoptedByModal, videoId]);

  // create & load <video>
  const loadVideo = useCallback((options = {}) => {
    if (loading || loadRequestedRef.current) return;
    if (hasRenderableVideo()) return;
    const allowLoad = canLoadMoreVideos?.(options);
    if (allowLoad === false) return;
    if (permanentErrorRef.current) return;
    setErrorText(null);

    loadRequestedRef.current = true;
    onStartLoading?.(videoId);
    setLoading(true);

    const runInit = () => {
      const el = document.createElement("video");
      el.muted = true;
      el.loop = true;
      el.playsInline = true;
      el.preload = isVisible ? "auto" : "metadata";
      el.className = "video-element";
      el.dataset.videoId = videoId;
      el.style.width = "100%";
      el.style.height = "100%";
      el.style.objectFit = "cover";
      el.style.display = "block";

      const cleanupListeners = () => {
        el.removeEventListener("loadedmetadata", onMeta);
        el.removeEventListener("loadeddata",    onLoadedData);
        el.removeEventListener("error",         onErr);
      };

      const finishStopLoading = () => {
        onStopLoading?.(videoId);
        setLoading(false);
        lastFailureAtRef.current = 0;
      };

      const onMeta = () => {
        if (!metaNotifiedRef.current) {
          metaNotifiedRef.current = true;
          const ar =
            el.videoWidth && el.videoHeight
              ? el.videoWidth / el.videoHeight
              : 16 / 9;
          onVideoLoad?.(videoId, ar);
        }
      };

      const onLoadedData = () => {
        clearTimeout(loadTimeoutRef.current);
        cleanupListeners();
        finishStopLoading();
        setLoaded(true);
        videoRef.current = el;

        const container = videoContainerRef.current;
        syncVideoIntoContainer(container, el);
      };

      const onErr = async (e) => {
        if (suppressErrorsRef.current) return;
        clearTimeout(loadTimeoutRef.current);
        cleanupListeners();
        finishStopLoading();
        loadRequestedRef.current = false;

        const err = e?.target?.error || e;
        const { terminal, label } = classifyMediaError(err);

        const code = err?.code ?? null;
        const isLocal = Boolean(video.isElectronFile && video.fullPath);
        const looksTransientLocal = isLocal && code === 4 && retryAttemptsRef.current < 2;

        if (!looksTransientLocal) {
          lastFailureAtRef.current = Date.now();
        }

        // Soft recover once
        try {
          const t = el.currentTime || 0;
          el.pause();
          el.load();
          try { el.currentTime = t; } catch {}
          await el.play().catch(() => {});
          setErrorText(null);
          return;
        } catch {}

        const decodeWhileActive =
          code === 3 && el.currentSrc && !suppressErrorsRef.current;

        if (terminal && decodeWhileActive && !looksTransientLocal) {
          permanentErrorRef.current = true;
          reportPlayerCreationFailure?.();
        }

        setErrorText(`⚠️ ${looksTransientLocal ? "Temporary read error" : label}`);
        onPlayError?.(videoId, err);

        // Only detach permanently if confirmed decode error
        if (decodeWhileActive && !looksTransientLocal) {
          try {
            suppressErrorsRef.current = true;
            hardDetach(el);
          } finally {
            setTimeout(() => { suppressErrorsRef.current = false; }, 0);
          }
        }

        // Retry once for transient local errors
        if (!permanentErrorRef.current && looksTransientLocal) {
          retryAttemptsRef.current += 1;
          setTimeout(() => {
            if (
              isVisible &&
              !loaded &&
              !loading &&
              !loadRequestedRef.current &&
              !videoRef.current &&
              (canLoadMoreVideos?.({ assumeVisible: true }) ?? true)
            ) {
              loadVideo({ assumeVisible: true });
            }
          }, 1200);
        }
      };

      // Conditional load-timeout (cancelled when invisible)
      const armLoadTimeout = () => {
        clearTimeout(loadTimeoutRef.current);
        if (isVisible) {
          loadTimeoutRef.current = setTimeout(() => {
            if (isVisible) onErr({ target: { error: new Error("Loading timeout") } });
          }, 10000);
        }
      };
      armLoadTimeout();

      el.addEventListener("loadedmetadata", onMeta);
      el.addEventListener("loadeddata",    onLoadedData);
      el.addEventListener("error",         onErr);

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

    if (typeof scheduleInit === "function") {
      scheduleInit(runInit);
    } else {
      runInit();
    }
  }, [
    video,
    videoId,
    isVisible,
    canLoadMoreVideos,
    loading,
    hasRenderableVideo,
    onStartLoading,
    onStopLoading,
    onVideoLoad,
    onPlayError,
    scheduleInit,
    syncVideoIntoContainer,
  ]);

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

    const allow = canLoadMoreVideos?.(assumeVisible ? { assumeVisible: true } : undefined);
    if (allow === false) return false;

    loadVideo(assumeVisible ? { assumeVisible: true } : undefined);
    return true;
  }, [
    canLoadMoreVideos,
    loadVideo,
    loading,
    scrollRootRef,
    hasRenderableVideo,
    isVisible,
  ]);

  useEffect(() => {
    const el = videoRef.current;
    const container = videoContainerRef.current;
    syncVideoIntoContainer(container, el);
  }, [layoutEpoch, loaded, showFilenames, syncVideoIntoContainer]);

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
  }, [ensureVisibleAndLoad, layoutEpoch, shouldEnsureLoad]);

  // IO registration for visibility
  useEffect(() => {
    const el = cardRef.current;
    if (!el || !observeIntersection || !unobserveIntersection) return;

    const handleVisible = (nowVisible /* boolean */, entry) => {
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
      (canLoadMoreVideos?.({ assumeVisible: true }) ?? true)
    ) {
      Promise.resolve().then(() => {
        if (
          isVisible &&
          !loaded &&
          !loading &&
          !loadRequestedRef.current &&
          !videoRef.current &&
          !permanentErrorRef.current &&
          (canLoadMoreVideos?.({ assumeVisible: true }) ?? true)
        ) {
          ensureVisibleAndLoad();
        }
      });
    }
  }, [
    isVisible,
    loaded,
    loading,
    canLoadMoreVideos,
    ensureVisibleAndLoad,
  ]);

  // Cancel load timeout if we become invisible
  useEffect(() => {
    if (!isVisible && loadTimeoutRef.current) {
      clearTimeout(loadTimeoutRef.current);
      loadTimeoutRef.current = null;
    }
  }, [isVisible]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current);
      if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
      const el = videoRef.current;
      if (el && !(el.dataset?.adopted === "modal")) {
        try {
          suppressErrorsRef.current = true;
          if (el.src?.startsWith("blob:")) URL.revokeObjectURL(el.src);
          el.pause();
          el.removeAttribute("src");
          el.remove();
        } catch {}
        finally {
          setTimeout(() => { suppressErrorsRef.current = false; }, 0);
        }
      }
      videoRef.current = null;
      loadRequestedRef.current = false;
      metaNotifiedRef.current = false;
    };
  }, []);

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

  const handleMouseEnter = useCallback(() => onHover?.(videoId), [onHover, videoId]);

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

    const canLoad = canLoadMoreVideos?.(
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

    if (!isNearViewport) {
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
              {canLoad ? "Scroll closer to load" : statusText}
            </span>
            <span className="video-placeholder__subtext">
              Thumbnails idle until you're nearby
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

      {loaded && videoRef.current && !isAdoptedByModal() ? (
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
