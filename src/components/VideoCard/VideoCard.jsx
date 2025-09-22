// src/components/VideoCard/VideoCard.jsx
import React, { useState, useEffect, useRef, useCallback, memo } from "react";
import { classifyMediaError } from "./mediaError";
import { toFileURL, hardDetach } from "./videoDom";
import { useVideoStallWatchdog } from "../../hooks/useVideoStallWatchdog";
import { hardTeardownVideo } from "../../utils/media";

const VideoCard = memo(function VideoCard({
  video,
  selected,
  onSelect,
  onContextMenu,

  // orchestration + metrics
  isPlaying,
  isLoaded,
  isLoading,
  isVisible,
  showFilenames = true,

  // limits & callbacks (owned by parent/orchestrator)
  canLoadMoreVideos,      // () => boolean
  onStartLoading,         // (id)
  onStopLoading,          // (id)
  onVideoLoad,            // (id, aspectRatio)
  onVideoPlay,            // (id)
  onVideoPause,           // (id)
  onPlayError,            // (id, error)
  reportPlayerCreationFailure,
  onVisibilityChange,     // (id, visible)
  onHover,                // (id)
  evictionVictims = [],

  // IO registry
  observeIntersection,    // (el, id, cb)
  unobserveIntersection,  // (el)=>void

  // optional init scheduler
  scheduleInit = null,
}) {
  const cardRef = useRef(null);
  const videoContainerRef = useRef(null);
  const videoRef = useRef(null);
  const objectUrlRef = useRef(null);
  const persistentListenersRef = useRef([]);
  const lastVisibilityRef = useRef(false);
  const isVisiblePropRef = useRef(isVisible);
  
  const clickTimeoutRef = useRef(null);
  const loadTimeoutRef = useRef(null);

  // local mirrors (parent is source of truth)
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const loadingStateRef = useRef(loading);
  const isLoadingPropRef = useRef(isLoading);
  const onStopLoadingRef = useRef(onStopLoading);

  // guards
  const loadRequestedRef = useRef(false);
  const metaNotifiedRef = useRef(false);
  const permanentErrorRef = useRef(false);
  const retryAttemptsRef   = useRef(0);
  const suppressErrorsRef  = useRef(false); // ignore unload-induced errors
  const lastCanLoadRef     = useRef(true);

  const [errorText, setErrorText] = useState(null);
  const videoId = video.id || video.fullPath || video.name;

  useEffect(() => {
    isVisiblePropRef.current = isVisible;
  }, [isVisible]);

  // Is this <video> currently adopted by the fullscreen modal?
  const isAdoptedByModal = useCallback(() => {
    const el = videoRef.current;
    return !!(el && el.dataset && el.dataset.adopted === "modal");
  }, []);

  const runHardTeardown = useCallback(() => {
    if (isAdoptedByModal()) return;

    const el = videoRef.current;
    const hadPendingLoad =
      loadRequestedRef.current ||
      loadingStateRef.current ||
      isLoadingPropRef.current;

    if (hadPendingLoad) {
      onStopLoadingRef.current?.(videoId);
    }

    if (loadTimeoutRef.current) {
      clearTimeout(loadTimeoutRef.current);
      loadTimeoutRef.current = null;
    }

    if (el) {
      try {
        suppressErrorsRef.current = true;
        hardTeardownVideo(el, {
          objectURL: objectUrlRef.current,
          listeners: persistentListenersRef.current,
        });
      } finally {
        setTimeout(() => {
          suppressErrorsRef.current = false;
        }, 0);
      }
    } else if (objectUrlRef.current) {
      try { URL.revokeObjectURL(objectUrlRef.current); } catch {}
    }

    videoRef.current = null;
    objectUrlRef.current = null;
    persistentListenersRef.current = [];
    loadRequestedRef.current = false;
    metaNotifiedRef.current = false;
    loadingStateRef.current = false;
    isLoadingPropRef.current = false;
    setLoaded(false);
    setLoading(false);
  }, [
    isAdoptedByModal,
    videoId,
  ]);

  // mirror flags
  useEffect(() => setLoaded(isLoaded), [isLoaded]);
  useEffect(() => setLoading(isLoading), [isLoading]);
  useEffect(() => {
    loadingStateRef.current = loading;
  }, [loading]);
  useEffect(() => {
    isLoadingPropRef.current = isLoading;
  }, [isLoading]);
  useEffect(() => {
    onStopLoadingRef.current = onStopLoading;
  }, [onStopLoading]);

  // If file content changed, clear sticky error so we can retry
  useEffect(() => {
    if (permanentErrorRef.current || errorText) {
      permanentErrorRef.current = false;
      retryAttemptsRef.current  = 0;
      setErrorText(null);
      loadRequestedRef.current = false;
      setLoaded(false);
      setLoading(false);
    }
  }, [video.id, video.size, video.dateModified]);

  useEffect(() => {
    const allowed = canLoadMoreVideos?.() ?? true;
    const prev = lastCanLoadRef.current;
    lastCanLoadRef.current = allowed;
    if (!allowed && prev) {
      runHardTeardown();
    }
  }, [canLoadMoreVideos, runHardTeardown]);

  // Teardown when parent says not loaded/not loading (unless adopted by modal)
  useEffect(() => {
    if (!isLoaded && !isLoading && videoRef.current && !isAdoptedByModal()) {
      runHardTeardown();
    }
  }, [isLoaded, isLoading, isAdoptedByModal, runHardTeardown]);

  useEffect(() => {
    if (!videoRef.current) return;
    if (!Array.isArray(evictionVictims) || evictionVictims.length === 0) return;
    if (!evictionVictims.includes(videoId)) return;
    runHardTeardown();
  }, [evictionVictims, videoId, runHardTeardown]);

  // IO registration for visibility
  useEffect(() => {
    const el = cardRef.current;
    if (!el || !observeIntersection || !unobserveIntersection) return;

    const handleVisible = (nowVisible /* boolean */, entry, info) => {
      const isNear = info?.near ?? false;
      if (lastVisibilityRef.current !== nowVisible) {
        lastVisibilityRef.current = nowVisible;
        onVisibilityChange?.(videoId, nowVisible);
      }

      if (
        (nowVisible || isNear) &&
        !loaded &&
        !loading &&
        !loadRequestedRef.current &&
        !videoRef.current &&
        !permanentErrorRef.current &&
        (canLoadMoreVideos?.() ?? true)
      ) {
        loadVideo();
      }
    };

    observeIntersection(el, videoId, handleVisible);
    return () => {
      unobserveIntersection(el);
    };
  }, [observeIntersection, unobserveIntersection, videoId, loaded, loading, canLoadMoreVideos, onVisibilityChange]);

  // Backup trigger if parent already flags visible
  useEffect(() => {
    if (
      (isVisible || isVisiblePropRef.current) &&
      !loaded &&
      !loading &&
      !loadRequestedRef.current &&
      !videoRef.current &&
      !permanentErrorRef.current &&
      (canLoadMoreVideos?.() ?? true)
    ) {
      Promise.resolve().then(() => {
        if (
          (isVisible || isVisiblePropRef.current) &&
          !loaded &&
          !loading &&
          !loadRequestedRef.current &&
          !videoRef.current &&
          !permanentErrorRef.current &&
          (canLoadMoreVideos?.() ?? true)
        ) {
          loadVideo();
        }
      });
    }
  }, [isVisible, loaded, loading, canLoadMoreVideos]);

  // Orchestrated play/pause + error handling
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    const handlePlaying = () => onVideoPlay?.(videoId);
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

    const listeners = [
      ["playing", handlePlaying],
      ["pause", handlePause],
      ["error", handleError],
    ];
    for (const [type, handler] of listeners) {
      el.addEventListener(type, handler);
    }
    persistentListenersRef.current = listeners;

    if (isPlaying && isVisible && loaded && !permanentErrorRef.current) {
      const p = el.play();
      if (p?.catch) p.catch((err) => handleError({ target: { error: err } }));
    } else {
      try { el.pause(); } catch {}
    }

    return () => {
      for (const [type, handler] of listeners) {
        el.removeEventListener(type, handler);
      }
      if (persistentListenersRef.current === listeners) {
        persistentListenersRef.current = [];
      }
    };
  }, [
    isPlaying,
    isVisible,
    loaded,
    videoId,
    onVideoPlay,
    onVideoPause,
    onPlayError,
  ]);

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
  const loadVideo = useCallback(() => {
    if (loading || loaded || loadRequestedRef.current || videoRef.current) return;
    if (!(canLoadMoreVideos?.() ?? true)) return;
    if (permanentErrorRef.current) return;
    setErrorText(null);

    loadRequestedRef.current = true;
    onStartLoading?.(videoId);
    loadingStateRef.current = true;
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
        loadingStateRef.current = false;
        isLoadingPropRef.current = false;
        setLoading(false);
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

        const container = videoContainerRef.current;
        if (container && !(el.dataset?.adopted === "modal")) {
          const staleVideos = Array.from(container.querySelectorAll("video"));
          for (const stale of staleVideos) {
            if (!stale || stale === el) continue;
            if (stale.dataset?.adopted === "modal") continue;

            const wasCurrent = stale === videoRef.current;
            try {
              hardTeardownVideo(stale, {
                listeners: wasCurrent ? persistentListenersRef.current : undefined,
              });
            } catch {}

            if (stale.parentNode === container) {
              try { container.removeChild(stale); } catch {}
            } else {
              try { stale.remove?.(); } catch {}
            }

            if (wasCurrent) {
              videoRef.current = null;
              persistentListenersRef.current = [];
            }
          }

          if (!container.contains(el)) {
            container.appendChild(el);
          }
        }

        videoRef.current = el;
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
              (canLoadMoreVideos?.() ?? true)
            ) {
              loadVideo();
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
        const assignObjectURL = (next) => {
          if (objectUrlRef.current && objectUrlRef.current !== next) {
            try { URL.revokeObjectURL(objectUrlRef.current); } catch {}
          }
          objectUrlRef.current = next;
        };

        if (video.isElectronFile && video.fullPath) {
          assignObjectURL(null);
          el.src = toFileURL(video.fullPath);
        } else if (video.file) {
          const url = URL.createObjectURL(video.file);
          assignObjectURL(url);
          el.src = url;
        } else if (video.fullPath || video.relativePath) {
          assignObjectURL(null);
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

    if (typeof scheduleInit === "function" && !isVisiblePropRef.current) {
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
    loaded,
    onStartLoading,
    onStopLoading,
    onVideoLoad,
    onPlayError,
    scheduleInit,
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
      if (lastVisibilityRef.current || isVisiblePropRef.current) {
        lastVisibilityRef.current = false;
        onVisibilityChange?.(videoId, false);
      }
      runHardTeardown();
    };
  }, [runHardTeardown, onVisibilityChange, videoId]);

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

  const renderPlaceholder = () => (
    <div
      className="video-placeholder"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        background: "linear-gradient(135deg, #1a1a1a, #2d2d2d)",
        color: "#888",
        fontSize: "0.9rem",
      }}
    >
      {errorText
        ? errorText
        : loading
        ? "📼 Loading…"
        : canLoadMoreVideos?.() ?? true
        ? "📼 Scroll to load"
        : "⏳ Waiting…"}
    </div>
  );

  return (
    <div
      ref={cardRef}
      className={`video-item ${selected ? "selected" : ""} ${loading ? "loading" : ""}`}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onContextMenu={handleContextMenu}
      data-filename={video.name}
      data-video-id={videoId}
      data-loaded={loaded.toString()}
      style={{
        userSelect: "none",
        position: "relative",
        width: "100%",
        height: "100%",
        borderRadius: "8px",
        overflow: "hidden",
        cursor: "pointer",
        border: selected ? "3px solid #007acc" : "1px solid #333",
        background: "#1a1a1a",
      }}
    >
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
