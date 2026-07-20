import { useCallback, useEffect, useRef, useState } from "react";

// Resource management currently bounds resident media below 1,000. Keeping a
// little headroom means a paused resident that later becomes active is still
// represented without allowing the registry to grow with the library.
export const MAX_REGISTERED_MEDIA = 1024;

const DEFAULT_SAMPLE_INTERVAL_MS = 1000;
const MAX_FRAME_SAMPLES = 300;
const HITCH_THRESHOLD_MS = 80;
const LONG_TASK_DECAY_MS = 800;

const initialTelemetry = () => ({
  suspended: false,
  detailed: true,
  sampleCount: 0,
  sampledAt: 0,
  frameDelayMs: null,
  longTaskRate: null,
  droppedFrameRatio: null,
  averagePixelArea: 0,
  activeMedia: 0,
  registeredMedia: 0,
  qualitySupportedMedia: 0,
  workingSetMB: 0,
  workingSetDeltaMB: null,
  systemMemoryMB: 0,
  availableMemoryMB: null,
});

const now = () => {
  if (typeof performance !== "undefined" && performance?.now) {
    return performance.now();
  }
  return Date.now();
};

const finite = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const percentile = (values, quantile) => {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(ordered.length * quantile) - 1)
  );
  return ordered[index];
};

const readQualityCounters = (element) => {
  if (!element) return null;

  let quality = null;
  try {
    quality = element.getVideoPlaybackQuality?.() || null;
  } catch {
    quality = null;
  }

  let total = finite(quality?.totalVideoFrames);
  let dropped = finite(quality?.droppedVideoFrames);
  if (total === null || dropped === null) {
    total = finite(element.webkitDecodedFrameCount);
    dropped = finite(element.webkitDroppedFrameCount);
  }

  if (total === null || dropped === null || total < 0 || dropped < 0) {
    return null;
  }
  return { total, dropped };
};

const readMemory = async () => {
  try {
    const response = await window?.appMem?.get?.();
    const totals = response?.totals || {};
    const workingSetMB = finite(totals.wsMB);
    const systemMemoryMB = finite(totals.totalMB);
    const explicitAvailable = finite(
      totals.availableMB ?? totals.freeMB ?? totals.availableMemoryMB
    );
    if (workingSetMB !== null || systemMemoryMB !== null) {
      const availableMemoryMB = explicitAvailable !== null
        ? explicitAvailable
        : systemMemoryMB !== null && workingSetMB !== null
          ? Math.max(0, systemMemoryMB - workingSetMB)
          : null;
      return {
        workingSetMB,
        systemMemoryMB,
        availableMemoryMB,
      };
    }
  } catch {
    // Fall through to the renderer-heap approximation when available.
  }

  const memory = typeof performance !== "undefined"
    ? performance?.memory
    : null;
  if (!memory) return null;
  const used = finite(memory.usedJSHeapSize);
  const limit = finite(memory.jsHeapSizeLimit);
  if (used === null || limit === null) return null;
  const workingSetMB = used / 1024 / 1024;
  const systemMemoryMB = limit / 1024 / 1024;
  return {
    workingSetMB,
    systemMemoryMB,
    availableMemoryMB: Math.max(0, systemMemoryMB - workingSetMB),
  };
};

const resetQualityBaselines = (registry) => {
  for (const entry of registry.values()) {
    entry.quality = null;
  }
};

const sampleRegisteredMedia = (registry) => {
  let activeMedia = 0;
  let pixelAreaTotal = 0;
  let pixelAreaSamples = 0;
  let qualitySupportedMedia = 0;
  let totalFrames = 0;
  let droppedFrames = 0;

  for (const entry of registry.values()) {
    const element = entry.element;
    if (!element || element.paused === true || element.ended === true) {
      entry.quality = null;
      continue;
    }

    activeMedia += 1;
    const width = finite(element.videoWidth);
    const height = finite(element.videoHeight);
    if (width !== null && height !== null && width > 0 && height > 0) {
      pixelAreaTotal += width * height;
      pixelAreaSamples += 1;
    }

    const current = readQualityCounters(element);
    if (!current) {
      entry.quality = null;
      continue;
    }
    qualitySupportedMedia += 1;

    const previous = entry.quality;
    entry.quality = current;
    if (!previous) continue;

    // Chromium counters can reset after a source/recovery transition. Treat
    // that sample as a fresh baseline rather than emitting a negative delta.
    if (
      current.total < previous.total ||
      current.dropped < previous.dropped
    ) {
      continue;
    }

    const totalDelta = current.total - previous.total;
    const droppedDelta = current.dropped - previous.dropped;
    if (totalDelta <= 0) continue;
    totalFrames += totalDelta;
    droppedFrames += Math.max(0, droppedDelta);
  }

  return {
    activeMedia,
    averagePixelArea: pixelAreaSamples
      ? pixelAreaTotal / pixelAreaSamples
      : 0,
    qualitySupportedMedia,
    droppedFrameRatio: totalFrames > 0
      ? Math.max(0, Math.min(1, droppedFrames / totalFrames))
      : null,
  };
};

/**
 * One process-wide-style sampler for the mounted collection. Cards register
 * exact elements; the hook owns one rAF loop, one PerformanceObserver and one
 * sampling interval regardless of card count.
 */
export function usePlaybackTelemetry({
  suspended = false,
  sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
  detailed = true,
} = {}) {
  const safeIntervalMs = Math.max(
    100,
    Math.floor(Number(sampleIntervalMs) || DEFAULT_SAMPLE_INTERVAL_MS)
  );
  const registryRef = useRef(new Map());
  const registrationSequenceRef = useRef(0);
  const generationRef = useRef(0);
  const previousWorkingSetRef = useRef(null);
  const [telemetry, setTelemetry] = useState(initialTelemetry);
  const [hadLongTaskRecently, setHadLongTaskRecently] = useState(false);

  const registerMediaElement = useCallback((id, element) => {
    if (id == null || !element || typeof element !== "object") {
      return () => {};
    }

    const registry = registryRef.current;
    const token = ++registrationSequenceRef.current;
    registry.delete(id);
    registry.set(id, { id, element, token, quality: null });

    while (registry.size > MAX_REGISTERED_MEDIA) {
      const oldestId = registry.keys().next().value;
      if (oldestId === undefined) break;
      registry.delete(oldestId);
    }

    return () => {
      const current = registry.get(id);
      if (current?.token === token && current.element === element) {
        registry.delete(id);
      }
    };
  }, []);

  useEffect(() => {
    const generation = ++generationRef.current;
    previousWorkingSetRef.current = null;
    resetQualityBaselines(registryRef.current);
    setHadLongTaskRecently(false);

    if (suspended) {
      setTelemetry((previous) => ({
        ...previous,
        suspended: true,
        detailed: Boolean(detailed),
        frameDelayMs: null,
        longTaskRate: null,
        droppedFrameRatio: null,
        workingSetDeltaMB: null,
        activeMedia: 0,
        qualitySupportedMedia: 0,
        registeredMedia: registryRef.current.size,
      }));
      return () => {
        generationRef.current += 1;
      };
    }

    let alive = true;
    let rafId = null;
    let intervalId = null;
    let longTaskDecayId = null;
    let observer = null;
    let sampling = false;
    let lastFrameAt = null;
    let lastSampleAt = now();
    const frameDelays = [];
    let hadHitch = false;
    let longTaskDurationMs = 0;
    let longTaskCount = 0;
    let observerAvailable = false;

    setTelemetry((previous) => ({
      ...previous,
      suspended: false,
      detailed: Boolean(detailed),
      ...(detailed
        ? {}
        : {
            frameDelayMs: null,
            longTaskRate: null,
            droppedFrameRatio: null,
            averagePixelArea: 0,
            activeMedia: 0,
            qualitySupportedMedia: 0,
            workingSetDeltaMB: null,
          }),
    }));

    const noteLongTask = () => {
      setHadLongTaskRecently(true);
      if (detailed) return;
      if (longTaskDecayId !== null) clearTimeout(longTaskDecayId);
      longTaskDecayId = setTimeout(() => {
        longTaskDecayId = null;
        if (alive && generationRef.current === generation) {
          setHadLongTaskRecently(false);
        }
      }, LONG_TASK_DECAY_MS);
    };

    const onFrame = (timestamp) => {
      if (!alive || generationRef.current !== generation) return;
      const frameAt = finite(timestamp) ?? now();
      if (lastFrameAt !== null) {
        const delay = frameAt - lastFrameAt;
        if (delay >= 0 && Number.isFinite(delay)) {
          if (detailed) {
            frameDelays.push(delay);
            if (frameDelays.length > MAX_FRAME_SAMPLES) frameDelays.shift();
          }
          if (delay >= HITCH_THRESHOLD_MS) {
            hadHitch = true;
            noteLongTask();
          }
        }
      }
      lastFrameAt = frameAt;
      rafId = requestAnimationFrame(onFrame);
    };

    if (typeof requestAnimationFrame === "function") {
      rafId = requestAnimationFrame(onFrame);
    }

    if (typeof PerformanceObserver === "function") {
      try {
        observer = new PerformanceObserver((list) => {
          if (!alive || generationRef.current !== generation) return;
          const entries = list?.getEntries?.() || [];
          if (!entries.length) return;
          if (detailed) {
            for (const entry of entries) {
              longTaskDurationMs += Math.max(0, finite(entry?.duration) ?? 0);
              longTaskCount += 1;
            }
          }
          noteLongTask();
        });
        observer.observe({ entryTypes: ["longtask"] });
        observerAvailable = true;
      } catch {
        observer = null;
        observerAvailable = false;
      }
    }

    const collect = async () => {
      if (!alive || sampling || generationRef.current !== generation) return;
      sampling = true;

      const collectedAt = now();
      const elapsedMs = Math.max(
        safeIntervalMs,
        collectedAt - lastSampleAt
      );
      lastSampleAt = collectedAt;
      const delaySnapshot = frameDelays.splice(0, frameDelays.length);
      const longDurationSnapshot = longTaskDurationMs;
      const longCountSnapshot = longTaskCount;
      const hitchSnapshot = hadHitch;
      longTaskDurationMs = 0;
      longTaskCount = 0;
      hadHitch = false;

      const media = sampleRegisteredMedia(registryRef.current);
      const memory = await readMemory();

      if (!alive || generationRef.current !== generation) {
        sampling = false;
        return;
      }

      const workingSetMB = memory?.workingSetMB ?? 0;
      const previousWorkingSet = previousWorkingSetRef.current;
      const workingSetDeltaMB = memory?.workingSetMB == null
        ? null
        : previousWorkingSet === null
          ? 0
          : workingSetMB - previousWorkingSet;
      previousWorkingSetRef.current = memory?.workingSetMB ?? null;

      const frameDelayMs = percentile(delaySnapshot, 0.95);
      const longTaskRate = observerAvailable
        ? Math.max(0, Math.min(1, longDurationSnapshot / elapsedMs))
        : null;
      const unhealthyWindow =
        hitchSnapshot || longCountSnapshot > 0 ||
        (frameDelayMs !== null && frameDelayMs >= HITCH_THRESHOLD_MS);

      setHadLongTaskRecently(unhealthyWindow);
      setTelemetry((previous) => ({
        suspended: false,
        detailed: true,
        sampleCount: previous.sampleCount + 1,
        sampledAt: Date.now(),
        frameDelayMs,
        longTaskRate,
        droppedFrameRatio: media.droppedFrameRatio,
        averagePixelArea: media.averagePixelArea,
        activeMedia: media.activeMedia,
        registeredMedia: registryRef.current.size,
        qualitySupportedMedia: media.qualitySupportedMedia,
        workingSetMB,
        workingSetDeltaMB,
        systemMemoryMB: memory?.systemMemoryMB ?? 0,
        availableMemoryMB: memory?.availableMemoryMB ?? null,
      }));
      sampling = false;
    };

    if (detailed) {
      void collect();
      intervalId = setInterval(() => {
        void collect();
      }, safeIntervalMs);
    }

    return () => {
      alive = false;
      generationRef.current += 1;
      if (rafId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafId);
      }
      if (intervalId !== null) clearInterval(intervalId);
      if (longTaskDecayId !== null) clearTimeout(longTaskDecayId);
      try {
        observer?.disconnect?.();
      } catch {}
      resetQualityBaselines(registryRef.current);
      previousWorkingSetRef.current = null;
    };
  }, [
    detailed,
    safeIntervalMs,
    suspended,
  ]);

  return {
    telemetry,
    hadLongTaskRecently,
    registerMediaElement,
  };
}

export default usePlaybackTelemetry;
