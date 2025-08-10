import React, { useState, useEffect, useRef, useCallback, memo } from "react";

const VideoCard = memo(({
  video,
  selected,
  onSelect,
  canPlayMoreVideos,
  onVideoPlay,
  onVideoPause,
  onVideoLoad,
  showFilenames = true,
  onContextMenu,
  // Performance props
  canLoadMoreVideos,
  isLoading,
  isLoaded,
  isVisible,
  isPlaying,
  onStartLoading,
  onStopLoading,
  onVisibilityChange,
  ioRoot,
}) => {
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [visible, setVisible] = useState(false);

  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const loadTimeoutRef = useRef(null);
  const clickTimeoutRef = useRef(null);
  const hasLoadedRef = useRef(false);

  const videoId = video.id || video.fullPath || video.name;

  // --- Load video function ---
  const loadVideo = useCallback(async () => {
    if (
      loading ||
      loaded ||
      error ||
      hasLoadedRef.current ||
      !canLoadMoreVideos()
    ) return;

    hasLoadedRef.current = true;
    setLoading(true);
    setError(null);
    onStartLoading?.(videoId);

    try {
      const videoElement = document.createElement("video");
      videoElement.muted = true;
      videoElement.loop = true;
      videoElement.preload = "metadata";
      videoElement.playsInline = true;
      videoElement.className = "video-element";
      videoElement.dataset.videoId = videoId;
      videoElement.style.width = "100%";
      videoElement.style.height = "100%";
      videoElement.style.objectFit = "cover";
      videoElement.style.display = "block";

      const handleError = () => {
        clearTimeout(loadTimeoutRef.current);
        setLoading(false);
        hasLoadedRef.current = false;
        onStopLoading?.(videoId);
        setError({ message: "Load Error", type: "load" });
      };

      const handleLoad = () => {
        if (videoRef.current) return;
        clearTimeout(loadTimeoutRef.current);
        setLoading(false);
        setLoaded(true);
        videoRef.current = videoElement;
        onStopLoading?.(videoId);
        if (videoElement.videoWidth && videoElement.videoHeight) {
          onVideoLoad?.(videoId, videoElement.videoWidth / videoElement.videoHeight);
        }
      };

      loadTimeoutRef.current = setTimeout(() => {
        handleError();
      }, 10000);

      videoElement.addEventListener("loadedmetadata", handleLoad);
      videoElement.addEventListener("canplay", handleLoad);
      videoElement.addEventListener("error", handleError);

      if (video.isElectronFile && video.fullPath) {
        videoElement.src = `file://${video.fullPath}`;
      } else if (video.file) {
        videoElement.src = URL.createObjectURL(video.file);
      } else {
        throw new Error("No valid video source available");
      }
    } catch {
      setLoading(false);
      hasLoadedRef.current = false;
      onStopLoading?.(videoId);
      setError({ message: "Setup Error", type: "setup" });
    }
  }, [
    video, loading, loaded, error, videoId,
    onVideoLoad, onStartLoading, onStopLoading, canLoadMoreVideos
  ]);

  // Sync with parent state
  useEffect(() => {
    setLoaded(isLoaded);
    setLoading(isLoading);
    setVisible(isVisible);
  }, [isLoaded, isLoading, isVisible]);

  // Visibility detection
  useEffect(() => {
    if (!containerRef.current) return;
    const rootEl = ioRoot?.current || null;
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const nowVisible = entry.isIntersecting;
        setVisible(nowVisible);
        onVisibilityChange?.(videoId, nowVisible);
      });
    }, {
      root: rootEl,
      rootMargin: "200px 0px",
      threshold: [0, 0.15],
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [ioRoot, onVisibilityChange, videoId]);

  // Delay load until visibility is stable
  useEffect(() => {
    if (loaded || loading || error || !visible) return;
    let t;
    if (!hasLoadedRef.current && (canLoadMoreVideos?.() ?? true)) {
      t = setTimeout(() => {
        if (
          visible && !loaded && !loading &&
          !error && !hasLoadedRef.current &&
          (canLoadMoreVideos?.() ?? true)
        ) {
          loadVideo();
        }
      }, 150);
    }
    return () => t && clearTimeout(t);
  }, [visible, loaded, loading, error, canLoadMoreVideos, loadVideo]);

  // Play/pause handling
  useEffect(() => {
    if (!videoRef.current || !loaded) return;
    const videoElement = videoRef.current;
    if (isPlaying && videoElement.paused) {
      videoElement.play().then(() => onVideoPlay?.(videoId))
        .catch(() => onVideoPause?.(videoId));
    } else if (!isPlaying && !videoElement.paused) {
      videoElement.pause();
      onVideoPause?.(videoId);
    }
  }, [isPlaying, loaded, videoId, onVideoPlay, onVideoPause]);

  // Listen to actual play/pause events
  useEffect(() => {
    if (!videoRef.current) return;
    const videoElement = videoRef.current;
    const handlePlay = () => onVideoPlay?.(videoId);
    const handlePause = () => onVideoPause?.(videoId);
    const handleEnded = () => {
      if (videoElement && !videoElement.paused) {
        videoElement.currentTime = 0;
        videoElement.play().catch(() => {});
      }
    };
    videoElement.addEventListener("play", handlePlay);
    videoElement.addEventListener("pause", handlePause);
    videoElement.addEventListener("ended", handleEnded);
    return () => {
      videoElement.removeEventListener("play", handlePlay);
      videoElement.removeEventListener("pause", handlePause);
      videoElement.removeEventListener("ended", handleEnded);
    };
  }, [loaded, videoId, onVideoPlay, onVideoPause]);

  // Cleanup
  useEffect(() => {
    return () => {
      clearTimeout(loadTimeoutRef.current);
      clearTimeout(clickTimeoutRef.current);
      if (videoRef.current) {
        try {
          if (videoRef.current.src?.startsWith("blob:")) {
            URL.revokeObjectURL(videoRef.current.src);
          }
          videoRef.current.pause();
          videoRef.current.removeAttribute("src");
          videoRef.current.load();
        } catch {}
      }
      hasLoadedRef.current = false;
    };
  }, []);

  const handleClick = useCallback((e) => {
    e.stopPropagation();
    if (clickTimeoutRef.current) {
      clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = null;
      onSelect(videoId, e.ctrlKey || e.metaKey, true);
      return;
    }
    clickTimeoutRef.current = setTimeout(() => {
      onSelect(videoId, e.ctrlKey || e.metaKey, false);
      clickTimeoutRef.current = null;
    }, 300);
  }, [onSelect, videoId]);

  const handleContextMenu = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu?.(e, video);
  }, [onContextMenu, video]);

  const getPlaceholderContent = useCallback(() => {
    if (error) return <div className="video-placeholder">❌ {error.message}</div>;
    if (loading) return <div className="video-placeholder">📼 Loading...</div>;
    if (!canLoadMoreVideos()) return <div className="video-placeholder">⏳ Waiting...</div>;
    return <div className="video-placeholder">📼 Scroll to load</div>;
  }, [error, loading, canLoadMoreVideos]);

  return (
    <div
      ref={containerRef}
      className={`video-item ${selected ? "selected" : ""} ${
        error ? "error" : ""
      } ${loading ? "loading" : ""}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      data-filename={video.name}
      data-video-id={videoId}
      data-loaded={loaded.toString()}
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
          style={{
            width: "100%",
            height: showFilenames ? "calc(100% - 40px)" : "100%",
          }}
        >
          {getPlaceholderContent()}
        </div>
      )}
      {showFilenames && <div className="video-filename">{video.name}</div>}
    </div>
  );
});

VideoCard.displayName = "VideoCard";
export default VideoCard;
