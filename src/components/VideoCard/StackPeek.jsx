import React, { useEffect, useRef, useState } from "react";
import { normalizeOpaqueMediaSource } from "../../utils/mediaSource";

// Hovering a still in a stack card's strip plays that clip over the card's
// header (docs/architecture/prompt-stacks.md, Section 8). One such clip at a
// time in the whole grid: it takes the scheduler's auxiliary lane, the one
// bounded extra decoder, and while it plays the card holds its own clip
// paused (VideoCard), so the grid decodes no more than before. With the lane
// taken (a frame capture running, the window put away) the still shows.

export default function StackPeek({
  still,
  scheduler = null,
  proxyPlaybackEnabled = false,
  audible = false,
  onPlayingChange,
}) {
  const videoRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const audibleRef = useRef(audible);
  audibleRef.current = audible;
  const onPlayingChangeRef = useRef(onPlayingChange);
  onPlayingChangeRef.current = onPlayingChange;
  const sourceUrl = normalizeOpaqueMediaSource(still?.sourceUrl);
  const instanceId = still?.instanceId ?? null;
  const stillId = still?.id ?? null;

  useEffect(() => {
    setPlaying(false);
    const el = videoRef.current;
    if (!el || !sourceUrl || typeof scheduler?.reserveAuxiliaryDecoder !== "function") {
      return undefined;
    }
    const lease = scheduler.reserveAuxiliaryDecoder(`stack-peek:${stillId}`);
    if (!lease) return undefined;
    let cancelled = false;
    const start = async () => {
      let url = sourceUrl;
      if (proxyPlaybackEnabled && window.electronAPI?.playback?.resolveSource) {
        try {
          const resolved = await window.electronAPI.playback.resolveSource({
            instanceId,
            sourceUrl,
            enabled: true,
          });
          url = normalizeOpaqueMediaSource(resolved?.sourceUrl) || sourceUrl;
        } catch {
          // The original plays instead.
        }
      }
      if (cancelled) return;
      el.muted = !audibleRef.current;
      el.src = url;
      el.play()?.catch?.((error) => {
        // Sound may be refused; the clip still plays silently.
        if (cancelled || error?.name !== "NotAllowedError") return;
        el.muted = true;
        el.play()?.catch?.(() => {});
      });
    };
    void start();
    return () => {
      cancelled = true;
      try {
        el.pause();
      } catch {
        // Gone already.
      }
      el.removeAttribute("src");
      try {
        el.load();
      } catch {
        // Gone already.
      }
      scheduler.releaseDecoder?.(lease);
    };
  }, [instanceId, proxyPlaybackEnabled, scheduler, sourceUrl, stillId]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = !audible;
  }, [audible]);

  useEffect(() => {
    onPlayingChangeRef.current?.(playing);
  }, [playing]);
  useEffect(() => () => onPlayingChangeRef.current?.(false), []);

  return (
    <div className={`video-item-stack-peek${playing ? " is-playing" : ""}`} aria-hidden="true">
      {still?.src ? <img src={still.src} alt="" draggable={false} /> : null}
      <video
        ref={videoRef}
        loop
        playsInline
        preload="auto"
        disablePictureInPicture
        onPlaying={() => setPlaying(true)}
      />
    </div>
  );
}
