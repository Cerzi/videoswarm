// src/components/FullScreenModal.jsx
import React, { useEffect, useMemo, useRef } from "react";
import { useFullScreenController } from "../hooks/fullscreen/useFullScreenController";
import { useAdoptedVideo } from "../hooks/fullscreen/useAdoptedVideo";

// Build a usable src for fallback video (file://, blob, or provided url)
function computeSrc(v) {
  if (!v) return "";
  if (v.blobUrl) return v.blobUrl;
  if (v.file instanceof File || v.file instanceof Blob) {
    try {
      return URL.createObjectURL(v.file);
    } catch {
      /* ignore */
    }
  }
  if (v.isElectronFile && v.fullPath) {
    const normalized = String(v.fullPath).replace(/\\/g, "/");
    const parts = normalized.split("/").map(encodeURIComponent);
    return "file://" + parts.join("/");
  }
  return v.src || v.url || "";
}

/**
 * FullScreenModal
 * Props:
 *  - videos: array of video objects
 *  - initialVideo: id or video object to open on
 *  - gridRef: ref to the grid root (for adoption)
 *  - onClose(): void
 *  - onNavigate(dir): void
 *  - showFilenames: boolean
 */
export default function FullScreenModal({
  videos = [],
  initialVideo = null,
  gridRef,
  onClose,
  onNavigate,
  showFilenames = true,
}) {
  const modalRef = useRef(null);
  const ctl = useFullScreenController(videos);

  // Open on mount / when initialVideo changes (call unconditionally; guard inside)
  useEffect(() => {
    if (initialVideo != null && ctl.open) {
      ctl.open(initialVideo?.id ?? initialVideo);
    }
  }, [initialVideo, ctl]);

  const video = ctl.currentVideo;
  const { adoptHostRef, fallbackRef, activeVideoRef, usingAdopted } =
    useAdoptedVideo(video, gridRef);

  // Global key handling while modal is open (hook always runs; handler guards isOpen)
  useEffect(() => {
    function onKey(e) {
      if (!ctl.isOpen) return;
      if (e.key === "Escape") {
        e.preventDefault();
        ctl.close();
        onClose?.();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        ctl.next();
        onNavigate?.("next");
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        ctl.prev();
        onNavigate?.("prev");
      } else if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        ctl.togglePlay();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ctl, onClose, onNavigate]);

  // Apply play/pause intent to the *active* element.
  // Only auto-play on open when using the adopted grid element (fallback starts paused).
  useEffect(() => {
    const el = activeVideoRef.current;
    if (!el) return;
    try {
      if (ctl.playIntent === "play" && usingAdopted) {
        if (el.paused) {
          const p = el.play?.();
          if (p && typeof p.catch === "function") p.catch(() => {});
        }
      } else {
        if (!el.paused) el.pause?.();
      }
    } catch {
      // ignore in tests / JSDOM
    }
  }, [ctl.playIntent, usingAdopted, activeVideoRef, video?.id]);

  // Body scroll lock while open (hook always runs; effect guarded)
  useEffect(() => {
    if (!ctl.isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [ctl.isOpen]);

  // IMPORTANT: Call hooks unconditionally every render.
  // Compute filename even when closed; we won't render it if closed.
  const filename = useMemo(() => {
    if (!showFilenames || !video) return "";
    const src =
      video.name ||
      video.filename ||
      video.fileName ||
      video.fullPath ||
      computeSrc(video);
    const cleaned = String(src).split(/[\\/]/).pop();
    return cleaned || "";
  }, [video, showFilenames]);

  // Render branch happens here; hooks above always run in the same order.
  if (!ctl.isOpen) return null;

  return (
    <div
      ref={modalRef}
      className="fullscreen-modal"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0,0,0,0.95)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10000,
      }}
    >
      {/* Close */}
      <button
        aria-label="Close"
        title="Close (Esc)"
        className="fs-close-btn"
        onClick={() => {
          ctl.close();
          onClose?.();
        }}
        style={{
          position: "absolute",
          top: 20,
          right: 20,
          background: "rgba(0,0,0,0.7)",
          borderRadius: "50%",
          width: 50,
          height: 50,
          color: "white",
          fontSize: 24,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 10001,
          transition: "background-color 0.2s",
        }}
      >
        ×
      </button>

      {/* Prev */}
      <button
        aria-label="Previous"
        title="Previous (←)"
        className="fs-prev-btn"
        onClick={() => {
          ctl.prev();
          onNavigate?.("prev");
        }}
        style={{
          position: "absolute",
          left: 20,
          top: "50%",
          transform: "translateY(-50%)",
          background: "rgba(0,0,0,0.7)",
          borderRadius: "50%",
          width: 60,
          height: 60,
          color: "white",
          fontSize: 24,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 10001,
          transition: "background-color 0.2s",
        }}
      >
        ←
      </button>

      {/* Next */}
      <button
        aria-label="Next"
        title="Next (→)"
        className="fs-next-btn"
        onClick={() => {
          ctl.next();
          onNavigate?.("next");
        }}
        style={{
          position: "absolute",
          right: 20,
          top: "50%",
          transform: "translateY(-50%)",
          background: "rgba(0,0,0,0.7)",
          borderRadius: "50%",
          width: 60,
          height: 60,
          color: "white",
          fontSize: 24,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 10001,
          transition: "background-color 0.2s",
        }}
      >
        →
      </button>

      <div
        style={{
          maxWidth: "90vw",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* filename / spinner row */}
        <div
          style={{
            color: "white",
            fontSize: 18,
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 20,
          }}
        >
          <div
            className="modal-spinner"
            style={{
              width: 20,
              height: 20,
              border: "2px solid rgba(255,255,255,0.2)",
              borderTop: "2px solid white",
              borderRadius: "50%",
            }}
          />
          {filename ? filename : "Loading video..."}
        </div>

        {/* Adopt host */}
        <div
          ref={adoptHostRef}
          style={{
            display: usingAdopted ? "block" : "none",
            maxWidth: "100%",
            maxHeight: "80vh",
          }}
        />

        {/* Fallback video (always rendered so refs are ready) */}
        <video
          ref={fallbackRef}
          style={{
            display: usingAdopted ? "none" : "block",
            maxWidth: "100%",
            maxHeight: "80vh",
            objectFit: "contain",
            borderRadius: 8,
            boxShadow: "0 20px 40px rgba(0,0,0,0.8)",
          }}
          controls
          playsInline
          loop
          // IMPORTANT: we do NOT autoPlay here. Keyboard Space toggles via controller.
          src={computeSrc(video)}
        />

        {/* helper legend */}
        <div
          style={{
            position: "absolute",
            bottom: 20,
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(0,0,0,0.7)",
            padding: "10px 20px",
            borderRadius: 20,
            color: "rgba(255,255,255,0.8)",
            fontSize: 14,
            textAlign: "center",
          }}
        >
          <span style={{ marginRight: 20 }}>← → Navigate</span>
          <span style={{ marginRight: 20 }}>Space Play/Pause</span>
          <span>Esc Close</span>
        </div>

        {/* Accessible control target for Space key */}
        <button
          aria-label="Toggle play/pause"
          className="sr-only"
          style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", opacity: 0 }}
          onClick={() => ctl.togglePlay()}
        >
          Toggle
        </button>
      </div>
    </div>
  );
}
