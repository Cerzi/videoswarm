// src/components/VideoCard/VideoCard.jsx
import React, { useState, useEffect, useRef, useCallback, memo } from "react";
import { classifyMediaError } from "./mediaError";
import { toFileURL, hardDetach } from "./videoDom";
import { useVideoStallWatchdog } from "../../hooks/useVideoStallWatchdog";

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
  aspectRatioHint = null,

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

  // IO registry
  observeIntersection,    // (el, id, cb)
  unobserveIntersection,  // (el)=>void

  // optional init scheduler
  scheduleInit = null,
}) {
  const cardRef = useRef(null);
  const videoContainerRef = useRef(null);
  const videoRef = useRef(null);

  const clickTimeoutRef = useRef(null);
  const loadTimeoutRef = useRef(null);

  // local mirrors (parent is source of truth)
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);

  // guards
  const loadRequestedRef = useRef(false);
  const metaNotifiedRef = useRef(false);
  const permanentErrorRef = useRef(false);
  const retryAttemptsRef   = useRef(0);
  const suppressErrorsRef  = useRef(false); // ignore unload-induced errors

  const [errorText, setErrorText] = useState(null);
  const videoId = video.id || video.fullPath || video.name;

  const ratingValue =
    typeof video?.rating === "number" && Number.isFinite(video.rating)
      ? Math.max(0, Math.min(5, Math.round(video.rating)))
      : null;
  const hasTags = Array.isArray(video?.tags) && video.tags.length > 0;
  const tagPreview = hasTags ? video.tags.slice(0, 3) : [];
  const extraTagCount = hasTags ? Math.max(0, video.tags.length - tagPreview.length) : 0;

  const effectiveAspectRatio =
    Number.isFinite(aspectRatioHint) && aspectRatioHint > 0 ? aspectRatioHint : 16 / 9;

  // Is this <video> currently adopted by the fullscreen modal?
  const isAdoptedByModal = useCallback(() => {
    const el = videoRef.current;
    return !!(el && el.dataset && el.dataset.adopted === "modal");
  }, []);

  // mirror flags
  useEffect(() => setLoaded(isLoaded), [isLoaded]);
  useEffect(() => setLoading(isLoading), [isLoading]);

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

  // IO registration for visibility
  useEffect(() => {
    const el = cardRef.current;
    if (!el || !observeIntersection || !unobserveIntersection) return;

    const handleVisible = (nowVisible /* boolean */) => {
      onVisibilityChange?.(videoId, nowVisible);

      if (
        nowVisible &&
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
      isVisible &&
      !loaded &&
      !loading &&
      !loadRequestedRef.current &&
      !videoRef.current &&
      !permanentErrorRef.current &&
      (canLoadMoreVideos?.() ?? true)
    ) {
      Promise.resolve().then(() => {
        if (
          isVisible &&
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
  const loadVideo = useCallback(() => {
    if (loading || loaded || loadRequestedRef.current || videoRef.current) return;
    if (!(canLoadMoreVideos?.() ?? true)) return;
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
        if (container && !container.contains(el) && !(el.dataset?.adopted === "modal")) {
          container.appendChild(el);
        }
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

  const renderPlaceholder = () => {
    if (errorText) {
      return (
        <div className="video-placeholder video-placeholder--error" role="alert">
          <span className="video-placeholder__label">{errorText}</span>
        </div>
      );
    }

    if (loading) {
      return (
        <div
          className="video-placeholder video-placeholder--loading"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="video-placeholder__spinner" aria-hidden="true" />
          <span className="video-placeholder__label">Loading video</span>
        </div>
      );
    }

    const canRequestMore = canLoadMoreVideos?.() ?? true;

    return (
      <div
        className={`video-placeholder video-placeholder--idle${
          canRequestMore ? "" : " video-placeholder--waiting"
        }`}
        aria-live="polite"
      >
        <div className="video-placeholder__skeleton" aria-hidden="true" />
        <span className="video-placeholder__label">
          {canRequestMore ? "Scroll to load" : "Waiting for capacity"}
        </span>
      </div>
    );
  };

  const videoAreaHeight = showFilenames ? "calc(100% - 40px)" : "100%";
  const videoContainerStyle = {
    width: "100%",
    height: videoAreaHeight,
    aspectRatio: effectiveAspectRatio,
  };

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
          style={videoContainerStyle}
          ref={videoContainerRef}
        />
      ) : (
        <div
          className="video-container"
          style={videoContainerStyle}
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
