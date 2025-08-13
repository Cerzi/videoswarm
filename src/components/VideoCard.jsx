import React, { useState, useEffect, useRef, useCallback, memo } from "react";

const VideoCard = memo(
  ({
    video,
    selected,
    onSelect,
    canPlayMoreVideos,
    onVideoPlay,
    onVideoPause,
    onVideoLoad,
    onPlayError,         // NEW: report play failures up
    onHover,             // NEW: raise priority when hovered
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
    ioRoot, // optional: IntersectionObserver root (e.g., gridRef)
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

    // Sync with parent state
    useEffect(() => {
      setLoaded(isLoaded);
      setLoading(isLoading);
      setVisible(isVisible);
    }, [isLoaded, isLoading, isVisible]);

    // Visibility detection (IO)
    useEffect(() => {
      if (!containerRef.current) return;
      const rootEl = ioRoot?.current || null;
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            const nowVisible = entry.isIntersecting;
            setVisible(nowVisible);
            onVisibilityChange?.(videoId, nowVisible);
            if (
              nowVisible &&
              !loaded &&
              !loading &&
              !error &&
              !hasLoadedRef.current &&
              (canLoadMoreVideos?.() ?? true)
            ) {
              loadVideo();
            }
          });
        },
        {
          root: rootEl,
          rootMargin: "200px 0px",
          threshold: [0, 0.15],
        }
      );
      observer.observe(containerRef.current);
      return () => observer.disconnect();
    }, [
      loaded,
      loading,
      error,
      canLoadMoreVideos,
      onVisibilityChange,
      videoId,
      ioRoot,
    ]);

    // Respond to parent's isPlaying prop AND report actual state
    useEffect(() => {
      if (!videoRef.current || !loaded) return;
      const el = videoRef.current;
      if (isPlaying && el.paused) {
        el.play()
          .then(() => {
            onVideoPlay?.(videoId);
          })
          .catch((err) => {
            onPlayError?.(videoId, err);
            onVideoPause?.(videoId);
          });
      } else if (!isPlaying && !el.paused) {
        el.pause();
        onVideoPause?.(videoId);
      }
    }, [isPlaying, loaded, videoId, onVideoPlay, onVideoPause, onPlayError]);

    // DOM event listeners for actual state
    useEffect(() => {
      const el = videoRef.current;
      if (!el) return;

      const handlePlay = () => onVideoPlay?.(videoId);
      const handlePause = () => onVideoPause?.(videoId);
      const handleEnded = () => {
        try {
          el.currentTime = 0;
          el.play().catch(() => {});
        } catch {}
      };

      el.addEventListener("play", handlePlay);
      el.addEventListener("pause", handlePause);
      el.addEventListener("ended", handleEnded);
      return () => {
        el.removeEventListener("play", handlePlay);
        el.removeEventListener("pause", handlePause);
        el.removeEventListener("ended", handleEnded);
      };
    }, [videoId, onVideoPlay, onVideoPause]);

    // Load video
    const loadVideo = useCallback(async () => {
      if (
        loading ||
        loaded ||
        error ||
        hasLoadedRef.current ||
        !(canLoadMoreVideos?.() ?? true)
      )
        return;

      hasLoadedRef.current = true;
      setError(null);
      onStartLoading?.(videoId);
      setLoading(true);

      try {
        const el = document.createElement("video");
        el.className = "video-element";
        el.muted = true;
        el.loop = true;
        el.preload = "metadata";
        el.playsInline = true;
        el.dataset.videoId = videoId;
        el.style.width = "100%";
        el.style.height = "100%";
        el.style.objectFit = "cover";
        el.style.display = "block";

        const cleanup = () => {
          el.removeEventListener("loadedmetadata", onMeta);
          el.removeEventListener("canplay", onCanPlay);
          el.removeEventListener("error", onErr);
        };

        const onMeta = () => {
          if (el.videoWidth && el.videoHeight) {
            const ar = el.videoWidth / el.videoHeight;
            onVideoLoad?.(videoId, ar);
          }
        };

        const onCanPlay = () => {
          clearTimeout(loadTimeoutRef.current);
          cleanup();
          setLoading(false);
          setLoaded(true);
          onStopLoading?.(videoId);
          requestAnimationFrame(() => {
            videoRef.current = el;
            const container =
              containerRef.current?.querySelector(".video-container");
            if (container && !container.contains(el)) {
              container.appendChild(el);
            }
          });
        };

        const onErr = (e) => {
          clearTimeout(loadTimeoutRef.current);
          cleanup();
          setLoading(false);
          hasLoadedRef.current = false;
          onStopLoading?.(videoId);

          let type = "load";
          let message = "Load Error";
          const msg = e?.target?.error?.message || "";
          if (/DEMUXER_ERROR_NO_SUPPORTED_STREAMS|no supported streams/i.test(msg)) {
            type = "codec";
            message = "Unsupported Codec";
          } else if (/DEMUXER_ERROR/i.test(msg)) {
            type = "format";
            message = "Format Error";
          }
          setError({ type, message });
        };

        loadTimeoutRef.current = setTimeout(() => {
          onErr({ target: { error: { message: "Loading timeout" } } });
        }, 10000);

        el.addEventListener("loadedmetadata", onMeta);
        el.addEventListener("canplay", onCanPlay);
        el.addEventListener("error", onErr);

        if (video.isElectronFile && video.fullPath) {
          el.src = `file://${video.fullPath}`;
        } else if (video.file) {
          el.src = URL.createObjectURL(video.file);
        } else if (video.fullPath || video.relativePath) {
          el.src = video.fullPath || video.relativePath;
        } else {
          throw new Error("No valid video source available");
        }
      } catch (err) {
        setLoading(false);
        hasLoadedRef.current = false;
        onStopLoading?.(videoId);
        setError({ message: "Setup Error", type: "setup" });
      }
    }, [
      video,
      loading,
      loaded,
      error,
      canLoadMoreVideos,
      onStartLoading,
      onStopLoading,
      onVideoLoad,
      videoId,
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
        hasLoadedRef.current = false;
      };
    }, []);

    // Click / double-click
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

    const getPlaceholderContent = useCallback(() => {
      if (error) {
        const icon =
          error.type === "codec"
            ? "🎞️"
            : error.type === "format"
            ? "📄"
            : error.type === "network"
            ? "🌐"
            : "❌";
        return (
          <div className={`error-indicator error-${error.type}`}>
            <div style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>
              {icon}
            </div>
            <div style={{ fontWeight: "bold", marginBottom: "0.25rem" }}>
              {error.message}
            </div>
            <div style={{ opacity: 0.8, lineHeight: 1.2 }}>
              {error.type === "codec"
                ? "Unsupported video codec (likely H.265/HEVC)"
                : error.message}
            </div>
          </div>
        );
      } else if (loading) {
        return <div className="video-placeholder">📼 Loading...</div>;
      } else if (!(canLoadMoreVideos?.() ?? true)) {
        return <div className="video-placeholder">⏳ Waiting...</div>;
      } else {
        return <div className="video-placeholder">📼 Scroll to load</div>;
      }
    }, [error, loading, canLoadMoreVideos]);

    return (
      <div
        ref={containerRef}
        className={`video-item ${selected ? "selected" : ""} ${
          error ? "error" : ""
        } ${loading ? "loading" : ""}`}
        onMouseEnter={() => onHover?.(videoId)}
        onClick={handleClick}
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
            style={{
              width: "100%",
              height: showFilenames ? "calc(100% - 40px)" : "100%",
            }}
          >
            {getPlaceholderContent()}
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
  }
);

VideoCard.displayName = "VideoCard";

export default VideoCard;
