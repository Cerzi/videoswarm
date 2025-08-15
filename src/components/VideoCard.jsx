import React, { useState, useEffect, useRef, useCallback, memo } from "react";

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

  // limits & callbacks (all owned by parent/orchestrator)
  canLoadMoreVideos, // () => boolean
  onStartLoading, // (id)
  onStopLoading, // (id)
  onVideoLoad, // (id, aspectRatio)
  onVideoPlay, // (id) - fires on 'playing' event
  onVideoPause, // (id) - fires on 'pause' event
  onPlayError, // (id, error)
  onVisibilityChange, // (id, visible)
  onHover, // (id)

  // IO root (scroll container)
  ioRoot,
}) {
  const containerRef = useRef(null);
  const videoRef = useRef(null);

  const clickTimeoutRef = useRef(null);
  const loadTimeoutRef = useRef(null);

  // local mirrors to reduce chatter (parent is source of truth)
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);

  // one-shot guards
  const loadRequestedRef = useRef(false);
  const metaNotifiedRef = useRef(false);

  const videoId = video.id || video.fullPath || video.name;

  // keep mirrors in sync
  useEffect(() => setLoaded(isLoaded), [isLoaded]);
  useEffect(() => setLoading(isLoading), [isLoading]);

  useEffect(() => {
    if (!isLoaded && !isLoading && videoRef.current) {
      // Parent has decided this video should no longer be loaded
      // Clean up and reset guards so it can load again later
      const el = videoRef.current;
      try {
        if (el.src?.startsWith("blob:")) URL.revokeObjectURL(el.src);
        el.pause();
        el.removeAttribute("src");
        el.load();
        el.remove();
      } catch {}

      videoRef.current = null;
      loadRequestedRef.current = false;
      metaNotifiedRef.current = false;
      setLoaded(false);
      setLoading(false);
    }
  }, [isLoaded, isLoading]);

  // IntersectionObserver: report visibility + opportunistic load
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const rootEl = ioRoot?.current || null;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const nowVisible = entry.isIntersecting;
          onVisibilityChange?.(videoId, nowVisible);

          // Opportunistic load when it first becomes visible and we're allowed
          if (
            nowVisible &&
            !loaded &&
            !loading &&
            !loadRequestedRef.current &&
            !videoRef.current &&
            (canLoadMoreVideos?.() ?? true)
          ) {
            loadVideo();
          }
        }
      },
      {
        root: rootEl,
        rootMargin: "200px 0px",
        threshold: [0, 0.15],
      }
    );

    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ioRoot, loaded, loading, canLoadMoreVideos, onVisibilityChange, videoId]);

  // React to orchestration: play/pause only if orchestrator says so
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    // attach *actual* media events ⇒ bubble up to orchestrator
    const handlePlaying = () => onVideoPlay?.(videoId);
    const handlePause = () => onVideoPause?.(videoId);
    const handleError = (e) => onPlayError?.(videoId, e?.target?.error || e);

    el.addEventListener("playing", handlePlaying);
    el.addEventListener("pause", handlePause);
    el.addEventListener("error", handleError);

    // only attempt to play when orchestrated, visible, and loaded
    if (isPlaying && isVisible && loaded) {
      const p = el.play();
      if (p?.catch)
        p.catch((err) => {
          const videoName = video.name?.slice(0, 15) || "unknown";
          console.log(`❌ ${videoName}: Play failed:`, err.message);
          handleError(err);
        });
    } else {
      // pause early if we're not supposed to be playing
      try {
        el.pause();
      } catch {}
    }

    return () => {
      el.removeEventListener("playing", handlePlaying);
      el.removeEventListener("pause", handlePause);
      el.removeEventListener("error", handleError);
    };
  }, [isPlaying, isVisible, loaded, videoId, onVideoPlay, onVideoPause, onPlayError]);

  // create & load a <video> element (metadata first)
  const loadVideo = useCallback(() => {
    if (loading || loaded || loadRequestedRef.current || videoRef.current)
      return;
    if (!(canLoadMoreVideos?.() ?? true)) return;

    loadRequestedRef.current = true;
    onStartLoading?.(videoId);
    setLoading(true);

    const el = document.createElement("video");
    el.muted = true;
    el.loop = true;
    el.playsInline = true;
    el.preload = "metadata";
    el.className = "video-element";
    el.dataset.videoId = videoId;
    el.style.width = "100%";
    el.style.height = "100%";
    el.style.objectFit = "cover";
    el.style.display = "block";

    const cleanupListeners = () => {
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("canplay", onCanPlay);
      el.removeEventListener("error", onErr);
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

    const onCanPlay = () => {
      clearTimeout(loadTimeoutRef.current);
      cleanupListeners();
      finishStopLoading();
      setLoaded(true);
      videoRef.current = el;

      // attach to DOM container
      const container = containerRef.current?.querySelector(".video-container");
      if (container && !container.contains(el)) {
        container.appendChild(el);
      }
    };

    const onErr = (e) => {
      clearTimeout(loadTimeoutRef.current);
      cleanupListeners();
      finishStopLoading();
      loadRequestedRef.current = false; // Allow retry on error

      // Tell orchestrator about load-time failure (so it can free a slot if needed)
      onPlayError?.(videoId, e?.target?.error || e);
    };

    loadTimeoutRef.current = setTimeout(() => {
      onErr({ target: { error: new Error("Loading timeout") } });
    }, 10000);

    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("canplay", onCanPlay);
    el.addEventListener("error", onErr);

    try {
      if (video.isElectronFile && video.fullPath) {
        el.src = `file://${video.fullPath}`;
      } else if (video.file) {
        el.src = URL.createObjectURL(video.file);
      } else if (video.fullPath || video.relativePath) {
        el.src = video.fullPath || video.relativePath;
      } else {
        throw new Error("No valid video source");
      }
    } catch (err) {
      onErr({ target: { error: err } });
    }
  }, [
    video,
    videoId,
    canLoadMoreVideos,
    loading,
    loaded,
    onStartLoading,
    onStopLoading,
    onVideoLoad,
    onPlayError,
  ]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current);
      if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);

      const el = videoRef.current;
      if (el) {
        try {
          if (el.src?.startsWith("blob:")) URL.revokeObjectURL(el.src);
          el.pause();
          el.removeAttribute("src");
          el.load();
          el.remove();
        } catch {}
      }
      videoRef.current = null;
      loadRequestedRef.current = false;
      metaNotifiedRef.current = false;
    };
  }, []);

  // single / double click selection
  const handleClick = useCallback(
    (e) => {
      e.stopPropagation();
      if (clickTimeoutRef.current) {
        clearTimeout(clickTimeoutRef.current);
        clickTimeoutRef.current = null;
        onSelect?.(videoId, e.ctrlKey || e.metaKey, true);
        return;
      }
      clickTimeoutRef.current = setTimeout(() => {
        onSelect?.(videoId, e.ctrlKey || e.metaKey, false);
        clickTimeoutRef.current = null;
      }, 300);
    },
    [onSelect, videoId]
  );

  const handleContextMenu = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu?.(e, video);
    },
    [onContextMenu, video]
  );

  const handleMouseEnter = useCallback(() => {
    onHover?.(videoId);
  }, [onHover, videoId]);

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
      {loading
        ? "📼 Loading…"
        : canLoadMoreVideos?.() ?? true
        ? "📼 Scroll to load"
        : "⏳ Waiting…"}
    </div>
  );

  return (
    <div
      ref={containerRef}
      className={`video-item ${selected ? "selected" : ""} ${
        loading ? "loading" : ""
      }`}
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
      {loaded && videoRef.current ? (
        <div
          className="video-container"
          style={{
            width: "100%",
            height: showFilenames ? "calc(100% - 40px)" : "100%",
          }}
          ref={(container) => {
            if (
              container &&
              videoRef.current &&
              !container.contains(videoRef.current)
            ) {
              container.appendChild(videoRef.current);
            }
          }}
        />
      ) : (
        <div
          className="video-container"
          style={{
            width: "100%",
            height: showFilenames ? "calc(100% - 40px)" : "100%",
          }}
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
