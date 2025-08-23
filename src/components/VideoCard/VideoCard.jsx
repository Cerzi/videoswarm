// src/components/VideoCard/VideoCard.jsx
import React, { useState, useEffect, useRef, useCallback, memo } from "react";
import { classifyMediaError } from "./mediaError";
import { toFileURL, hardDetach } from "./videoDom";

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
  onVideoPlay, // (id)
  onVideoPause, // (id)
  onPlayError, // (id, error)
  onVisibilityChange, // (id, visible)
  onHover, // (id)

  // functions from the shared IO registry
  observeIntersection, // (el, (visible:boolean, entry)=>void)
  unobserveIntersection, // (el)=>void

  scheduleInit = null,
}) {
  const cardRef = useRef(null); // wrapper .video-item
  const videoContainerRef = useRef(null); // inner .video-container
  const videoRef = useRef(null);

  const clickTimeoutRef = useRef(null);
  const loadTimeoutRef = useRef(null);

  // local mirrors to reduce chatter (parent is source of truth)
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);

  // one-shot guards
  const loadRequestedRef = useRef(false);
  const metaNotifiedRef = useRef(false);
  const permanentErrorRef = useRef(false);
  const [errorText, setErrorText] = useState(null);

  const videoId = video.id || video.fullPath || video.name;

  // 🔹 helper: is this card’s <video> currently adopted by the modal?
  const isAdoptedByModal = useCallback(() => {
    const el = videoRef.current;
    return !!(el && el.dataset && el.dataset.adopted === "modal");
  }, []);

  // keep mirrors in sync
  useEffect(() => setLoaded(isLoaded), [isLoaded]);
  useEffect(() => setLoading(isLoading), [isLoading]);

  // Teardown when parent says not loaded/not loading (unless adopted)
  useEffect(() => {
    if (isAdoptedByModal()) return;
    if (!isLoaded && !isLoading && videoRef.current) {
      const el = videoRef.current;
      try {
        if (el.src?.startsWith("blob:")) URL.revokeObjectURL(el.src);
        el.pause();
        el.removeAttribute("src");
        // NOTE: avoid calling el.load() here; it can force sync churn in Chromium.
        el.remove();
      } catch {
        /* noop */
      }
      videoRef.current = null;
      loadRequestedRef.current = false;
      metaNotifiedRef.current = false;
      setLoaded(false);
      setLoading(false);
    }
  }, [isLoaded, isLoading, isAdoptedByModal]);

  // NEW: shared IO registration for visibility + opportunistic load
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

    observeIntersection(el, handleVisible);
    return () => {
      unobserveIntersection(el);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [observeIntersection, unobserveIntersection, videoId, loaded, loading, canLoadMoreVideos, onVisibilityChange]);

  // Backup trigger: if parent says we're visible but our local handler
  // didn't run yet, attempt a load once the microtask queue clears.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, loaded, loading, canLoadMoreVideos]);

  // React to orchestration: play/pause only if orchestrator says so
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    const handlePlaying = () => onVideoPlay?.(videoId);
    const handlePause = () => onVideoPause?.(videoId);
    const handleError = (e) => {
      const err = e?.target?.error || e;
      onPlayError?.(videoId, err);
      const { terminal, label } = classifyMediaError(err);
      if (terminal) permanentErrorRef.current = true;
      setErrorText(`⚠️ ${label}`);
      hardDetach(el);
    };

    el.addEventListener("playing", handlePlaying);
    el.addEventListener("pause", handlePause);
    el.addEventListener("error", handleError);

    if (isPlaying && isVisible && loaded && !permanentErrorRef.current) {
      const p = el.play();
      if (p?.catch) p.catch((err) => handleError({ target: { error: err } }));
    } else {
      try {
        el.pause();
      } catch {
        /* noop */
      }
    }

    return () => {
      el.removeEventListener("playing", handlePlaying);
      el.removeEventListener("pause", handlePause);
      el.removeEventListener("error", handleError);
    };
  }, [isPlaying, isVisible, loaded, videoId, onVideoPlay, onVideoPause, onPlayError]);

  // create & load a <video> element
  const loadVideo = useCallback(() => {
    if (loading || loaded || loadRequestedRef.current || videoRef.current)
      return;
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
      el.preload = isVisible ? "auto" : "metadata"; // earlier first frame for visible
      el.className = "video-element";
      el.dataset.videoId = videoId;
      el.style.width = "100%";
      el.style.height = "100%";
      el.style.objectFit = "cover";
      el.style.display = "block";

      const cleanupListeners = () => {
        el.removeEventListener("loadedmetadata", onMeta);
        el.removeEventListener("loadeddata", onLoadedData);
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

      const onLoadedData = () => {
        clearTimeout(loadTimeoutRef.current);
        cleanupListeners();
        finishStopLoading();
        setLoaded(true);
        videoRef.current = el;

        const container = videoContainerRef.current;
        if (
          container &&
          !container.contains(el) &&
          !(el.dataset?.adopted === "modal")
        ) {
          container.appendChild(el);
        }
      };

      const onErr = (e) => {
        clearTimeout(loadTimeoutRef.current);
        cleanupListeners();
        finishStopLoading();
        loadRequestedRef.current = false;
        const err = e?.target?.error || e;
        const { terminal, label } = classifyMediaError(err);
        if (terminal) permanentErrorRef.current = true;
        setErrorText(`⚠️ ${label}`);
        onPlayError?.(videoId, err);
        hardDetach(el);
      };

      loadTimeoutRef.current = setTimeout(() => {
        onErr({ target: { error: new Error("Loading timeout") } });
      }, 10000);

      el.addEventListener("loadedmetadata", onMeta);
      el.addEventListener("loadeddata", onLoadedData);
      el.addEventListener("error", onErr);

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

        // Optional warm-start: nudge buffering for visible tiles
        if (isVisible) {
          const p = el.play();
          if (p?.then)
            p.then(() => {
              try {
                el.pause();
              } catch {}
            }).catch(() => {});
        }
      } catch (err) {
        onErr({ target: { error: err } });
      }
    };

    // If you’ve added an init scheduler, use it; otherwise run immediately
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
    scheduleInit, // optional, safe if undefined
  ]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current);
      if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
      const el = videoRef.current;
      if (el && !(el.dataset?.adopted === "modal")) {
        try {
          if (el.src?.startsWith("blob:")) URL.revokeObjectURL(el.src);
          el.pause();
          el.removeAttribute("src");
          el.remove();
        } catch {
          /* noop */
        }
      }
      videoRef.current = null;
      loadRequestedRef.current = false;
      metaNotifiedRef.current = false;
    };
  }, []);

  // selection
  const handleClick = useCallback(
    (e) => {
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

  const handleMouseEnter = useCallback(
    () => onHover?.(videoId),
    [onHover, videoId]
  );

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
      {loaded && videoRef.current && !isAdoptedByModal() ? (
        <div
          className="video-container"
          style={{
            width: "100%",
            height: showFilenames ? "calc(100% - 40px)" : "100%",
          }}
          ref={videoContainerRef}
        />
      ) : (
        <div
          className="video-container"
          style={{
            width: "100%",
            height: showFilenames ? "calc(100% - 40px)" : "100%",
          }}
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
