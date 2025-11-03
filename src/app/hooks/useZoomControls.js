import { useCallback, useEffect, useRef } from "react";
import { clampZoomIndex, calculateSafeZoom } from "../../zoom/utils";

const ZOOM_LABELS = ["Compact", "Cozy", "Comfy", "Roomy", "Immersive"];

export function getZoomLabelByIndex(index) {
  const clamped = clampZoomIndex(index);
  return ZOOM_LABELS[clamped] ?? `Level ${clamped}`;
}

function defaultRunWithAnchor(_, updater) {
  return typeof updater === "function" ? updater() : undefined;
}

function defaultWithLayoutHold(fn) {
  return typeof fn === "function" ? fn() : undefined;
}

export function useZoomControls({
  zoomLevel,
  setZoomLevel,
  orderedVideoCount = 0,
  recursiveMode,
  renderLimitStep,
  showFilenames,
  setZoomClass,
  scheduleLayout,
  runWithStableAnchor = defaultRunWithAnchor,
  withLayoutHold = defaultWithLayoutHold,
  zoomAnchorOptions,
}) {
  const zoomRef = useRef(zoomLevel);

  useEffect(() => {
    zoomRef.current = zoomLevel;
  }, [zoomLevel]);

  const persistZoomSettings = useCallback(
    (level) => {
      window.electronAPI?.saveSettingsPartial?.({
        zoomLevel: level,
        recursiveMode,
        renderLimitStep,
        showFilenames,
      });
    },
    [recursiveMode, renderLimitStep, showFilenames]
  );

  const applyZoom = useCallback(
    (level, { persist = true, hold = true } = {}) => {
      const clamped = clampZoomIndex(level);
      if (clamped === zoomRef.current) return;

      const update = () => {
        setZoomLevel(clamped);
        setZoomClass?.(clamped);
        scheduleLayout?.();
        if (persist) {
          persistZoomSettings(clamped);
        }
      };

      if (hold) {
        return withLayoutHold(() =>
          runWithStableAnchor(
            "zoomChange",
            () => {
              const result = update();
              return result;
            },
            zoomAnchorOptions
          )
        );
      }

      update();
      return undefined;
    },
    [persistZoomSettings, runWithStableAnchor, scheduleLayout, setZoomClass, withLayoutHold, zoomAnchorOptions]
  );

  const getMinimumZoomLevel = useCallback(() => {
    const windowWidth = window.innerWidth;
    if (orderedVideoCount > 200 && windowWidth > 2560) return 2;
    if (orderedVideoCount > 150 && windowWidth > 1920) return 1;
    return 0;
  }, [orderedVideoCount]);

  const handleZoomChangeSafe = useCallback(
    (desiredZoom) => {
      const minZoom = getMinimumZoomLevel();
      const safeZoom = Math.max(desiredZoom, minZoom);
      if (safeZoom !== desiredZoom) {
        console.warn(
          `🛡️ Zoom limited to ${getZoomLabelByIndex(safeZoom)} for memory safety (requested ${getZoomLabelByIndex(desiredZoom)})`
        );
      }
      applyZoom(safeZoom);
    },
    [applyZoom, getMinimumZoomLevel]
  );

  const applyZoomFromSettings = useCallback(
    (value) => {
      const clamped = clampZoomIndex(value);
      setZoomLevel(clamped);
      setZoomClass?.(clamped);
      scheduleLayout?.();
    },
    [scheduleLayout, setZoomClass, setZoomLevel]
  );

  useEffect(() => {
    setZoomClass?.(zoomLevel);
  }, [setZoomClass, zoomLevel]);

  useEffect(() => {
    if (!window.electronAPI?.isElectron) return;

    const handleResize = () => {
      const videoCount = orderedVideoCount;
      if (videoCount <= 50) return;
      const safeZoom = calculateSafeZoom(
        window.innerWidth,
        window.innerHeight,
        videoCount
      );
      if (safeZoom > zoomRef.current) {
        console.log(
          `📐 Window resized: ${window.innerWidth}x${window.innerHeight} with ${videoCount} videos - adjusting zoom to ${getZoomLabelByIndex(
            safeZoom
          )} for safety`
        );
        applyZoom(safeZoom, { hold: true });
      }
    };

    let resizeTimeout;
    const debouncedResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(handleResize, 500);
    };

    window.addEventListener("resize", debouncedResize);
    return () => {
      window.removeEventListener("resize", debouncedResize);
      clearTimeout(resizeTimeout);
    };
  }, [applyZoom, orderedVideoCount]);

  useEffect(() => {
    if (orderedVideoCount <= 100) return;
    const safeZoom = calculateSafeZoom(
      window.innerWidth,
      window.innerHeight,
      orderedVideoCount
    );
    if (safeZoom > zoomRef.current) {
      console.log(
        `📹 Large collection detected (${orderedVideoCount} videos) - adjusting zoom for memory safety`
      );
      applyZoom(safeZoom, { hold: true });
    }
  }, [applyZoom, orderedVideoCount]);

  return {
    handleZoomChangeSafe,
    getMinimumZoomLevel,
    applyZoomFromSettings,
    setZoomLevel: applyZoom,
  };
}
