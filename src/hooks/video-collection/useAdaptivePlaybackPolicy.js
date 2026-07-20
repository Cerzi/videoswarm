import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_PLAYBACK_MODE,
  nextPlaybackDecision,
  normalizePlaybackMode,
} from "../../playback/playbackPolicy";

export default function useAdaptivePlaybackPolicy({
  mode = DEFAULT_PLAYBACK_MODE,
  visibleCount = 0,
  telemetry = {},
  capabilities = {},
  averagePixelArea = 0,
  suspended = false,
} = {}) {
  const normalizedMode = normalizePlaybackMode(mode);
  const input = useMemo(
    () => ({
      mode: normalizedMode,
      visibleCount,
      suspended,
      platform: capabilities?.platform || window.electronAPI?.platform || "unknown",
      hardwareConcurrency:
        capabilities?.logicalCores || navigator.hardwareConcurrency || 1,
      systemMemoryMB:
        telemetry?.systemMemoryMB || capabilities?.totalMemoryMB || 8192,
      availableMemoryMB: telemetry?.availableMemoryMB,
      workingSetDeltaMB: telemetry?.workingSetDeltaMB,
      frameDelayMs: telemetry?.frameDelayMs,
      longTaskRate: telemetry?.longTaskRate,
      droppedFrameRatio: telemetry?.droppedFrameRatio,
      averagePixelArea:
        telemetry?.averagePixelArea > 0
          ? telemetry.averagePixelArea
          : averagePixelArea,
    }),
    [
      averagePixelArea,
      capabilities?.logicalCores,
      capabilities?.platform,
      capabilities?.totalMemoryMB,
      normalizedMode,
      suspended,
      telemetry?.availableMemoryMB,
      telemetry?.averagePixelArea,
      telemetry?.droppedFrameRatio,
      telemetry?.frameDelayMs,
      telemetry?.longTaskRate,
      telemetry?.systemMemoryMB,
      telemetry?.workingSetDeltaMB,
      visibleCount,
    ]
  );
  const [decision, setDecision] = useState(() =>
    nextPlaybackDecision(null, input)
  );
  const sampleCount = Number.isFinite(Number(telemetry?.sampleCount))
    ? Number(telemetry.sampleCount)
    : null;
  const lastProcessedSampleRef = useRef(sampleCount);

  useEffect(() => {
    const advanceHealth = lastProcessedSampleRef.current !== sampleCount;
    lastProcessedSampleRef.current = sampleCount;
    setDecision((previous) =>
      nextPlaybackDecision(previous, { ...input, advanceHealth })
    );
  }, [input, sampleCount]);

  return decision;
}
