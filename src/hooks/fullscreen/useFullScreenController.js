import { useCallback, useMemo, useState } from "react";

/**
 * Pure state/controller for the fullscreen experience.
 * - No DOM access.
 * - Single source of truth for play/pause via `playIntent`.
 */
export function useFullScreenController(videos = []) {
  const [isOpen, setOpen] = useState(false);
  const [index, setIndex] = useState(-1);
  const [playIntent, setPlayIntent] = useState("pause"); // "play" | "pause"

  const currentVideo = useMemo(
    () => (index >= 0 && index < videos.length ? videos[index] : null),
    [index, videos]
  );

  const open = useCallback(
    (videoOrId) => {
      const id = typeof videoOrId === "string" ? videoOrId : videoOrId?.id;
      const i = id ? videos.findIndex((v) => v.id === id) : 0;
      setIndex(i >= 0 ? i : 0);
      setOpen(true);
      setPlayIntent("play"); // auto-play when opening
    },
    [videos]
  );

  const close = useCallback(() => {
    setOpen(false);
    setIndex(-1);
    setPlayIntent("pause");
  }, []);

  const next = useCallback(() => {
    if (!videos.length) return;
    setIndex((i) => ((i + 1) % videos.length + videos.length) % videos.length);
    setPlayIntent("play");
  }, [videos.length]);

  const prev = useCallback(() => {
    if (!videos.length) return;
    setIndex((i) => ((i - 1) % videos.length + videos.length) % videos.length);
    setPlayIntent("play");
  }, [videos.length]);

  const togglePlay = useCallback(() => {
    setPlayIntent((x) => (x === "play" ? "pause" : "play"));
  }, []);

  return {
    isOpen,
    currentVideo,
    index,
    open,
    close,
    next,
    prev,
    playIntent,
    setPlayIntent,
    togglePlay,
  };
}

export default useFullScreenController;
