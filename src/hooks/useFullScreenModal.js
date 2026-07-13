import { useCallback, useEffect, useMemo, useState } from "react";

export const useFullScreenModal = (videos = []) => {
  const [fullScreenId, setFullScreenId] = useState(null);

  const fullScreenIndex = useMemo(
    () => videos.findIndex((video) => video.id === fullScreenId),
    [fullScreenId, videos]
  );
  const fullScreenVideo =
    fullScreenIndex >= 0 ? videos[fullScreenIndex] : null;

  useEffect(() => {
    if (fullScreenId != null && fullScreenIndex < 0) {
      setFullScreenId(null);
    }
  }, [fullScreenId, fullScreenIndex]);

  const openFullScreen = useCallback((video) => {
    if (!video?.id) return;
    setFullScreenId(video.id);
  }, []);

  const closeFullScreen = useCallback(() => {
    setFullScreenId(null);
  }, []);

  const navigateFullScreen = useCallback(
    (direction) => {
      setFullScreenId((currentId) => {
        if (!videos.length) return null;
        const currentIndex = videos.findIndex((video) => video.id === currentId);
        if (currentIndex < 0) return null;
        const nextIndex =
          direction === "next"
            ? (currentIndex + 1) % videos.length
            : currentIndex === 0
            ? videos.length - 1
            : currentIndex - 1;
        return videos[nextIndex]?.id ?? currentId;
      });
    },
    [videos]
  );

  return {
    fullScreenVideo,
    openFullScreen,
    closeFullScreen,
    navigateFullScreen,
  };
};
