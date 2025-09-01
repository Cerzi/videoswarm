// src/hooks/video-collection/useVideoResourceManager.js
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const __DEV__ = process.env.NODE_ENV !== "production";

/**
 * Reads total app memory from Electron (working set across all processes).
 * Falls back to performance.memory (single renderer JS heap) if unavailable.
 */
async function readAppMemorySafe() {
  try {
    if (window.appMem?.get) {
      const { totals } = await window.appMem.get();
      return {
        source: "app",                               // from Electron app metrics
        currentMB: Math.max(0, totals.wsMB || 0),    // working set (MB)
        totalMB: Math.max(0, totals.totalMB || 0),   // system total (MB)
      };
    }
  } catch {
    // ignore and fall back
  }

  // Fallback: JS heap only (renderer) – not representative of media/GPU
  if (performance && performance.memory) {
    const usedMB  = Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
    const limitMB = Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024);
    return { source: "jsHeap", currentMB: usedMB, totalMB: limitMB };
  }
  return null;
}

// Tunables (conservative defaults; adjust for your dataset/hardware)
const CONFIG = {
  ESTIMATED_VIDEO_MEMORY_MB: 8,         // ~8MB per loaded <video> ≤1080p
  MONITOR_INTERVAL_MS: 2000,            // memory poll freq
  SAFE_FRACTION_OF_SYS: 0.25,           // target ≤25% of system RAM
  MAX_SAFE_MB_CAP: 2048,                // but never budget more than 2GB
  HEADROOM_MB_UP: 256,                  // hysteresis: allow growth before clamp
  HEADROOM_MB_DOWN: 128,                // shrink earlier than we grow
  SMOOTH_MAX_STEP: 12,                  // clamp change per tick to avoid thrash
  BASE_MAX_LOADED_BY_DM: {              // coarse base cap by deviceMemory (GB)
    4: 160, 6: 210, 8: 260, 12: 320, 16: 380,
  },
  BASE_MAX_LOADING: 24,                 // upper bound on concurrent loads
  MIN_MAX_LOADED: 24,                   // never drop below this when list is big
  LONG_TASK_DERATE: 0.6,                // when hadLongTaskRecently

  // Make the user cap meaningful:
  PLAY_PRELOAD_BUFFER: 16,              // keep this many extra loaded beyond play cap
  MAX_LOADED_SOFT_CAP: 9999,            // global ceiling (leave high)
};

export default function useVideoResourceManager({
  progressiveVideos,
  visibleVideos,
  loadedVideos,
  loadingVideos,
  playingVideos,
  hadLongTaskRecently = false,
  isNear = () => false,
  playingCap, 
}) {
  // --- normalize inputs: accept Set/Array/iterable; store as Set
  const asSet = (v) =>
    v && typeof v.has === "function"
      ? v
      : new Set(Array.isArray(v) ? v : v ? Array.from(v) : []);
  const _visibleVideos = asSet(visibleVideos);
  const _loadedVideos = asSet(loadedVideos);
  const _loadingVideos = asSet(loadingVideos);
  const _playingVideos = asSet(playingVideos);

  // --- memory sampling ---
  const [mem, setMem] = useState(() => ({
    source: "unknown",
    currentMemoryMB: 0,
    totalMemoryMB: 0,
    memoryPressure: 0, // 0..1
  }));

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const res = await readAppMemorySafe();
      if (!alive || !res) return;
      const total = res.totalMB || 8192; // default 8GB if unknown
      const curr = res.currentMB || 0;
      const pressure = total > 0 ? curr / total : 0;
      setMem({
        source: res.source,
        currentMemoryMB: curr,
        totalMemoryMB: total,
        memoryPressure: Math.max(0, Math.min(1, pressure)),
      });
    };
    tick(); // initial
    const id = setInterval(tick, CONFIG.MONITOR_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // EWMA smoothing for memoryPressure (avoid twitchy decisions)
  const smoothPressureRef = useRef(0);
  useEffect(() => {
    const α = 0.3; // EWMA alpha
    smoothPressureRef.current =
      α * mem.memoryPressure + (1 - α) * smoothPressureRef.current;
  }, [mem.memoryPressure]);

  // --- derive dynamic limits ---
  const prevLimitsRef = useRef({
    maxLoaded: CONFIG.MIN_MAX_LOADED,
    maxConcurrentLoading: 8,
  });

  const limits = useMemo(() => {
    const dm =
      (typeof navigator !== "undefined" && navigator.deviceMemory) || 8;

    // Base cap from device memory (coarse)
    const baseByDM =
      dm >= 16 ? CONFIG.BASE_MAX_LOADED_BY_DM[16]
      : dm >= 12 ? CONFIG.BASE_MAX_LOADED_BY_DM[12]
      : dm >= 8  ? CONFIG.BASE_MAX_LOADED_BY_DM[8]
      : dm >= 6  ? CONFIG.BASE_MAX_LOADED_BY_DM[6]
                 : CONFIG.BASE_MAX_LOADED_BY_DM[4];

    // Budget based on system RAM (working set target)
    const sysMB = mem.totalMemoryMB || 8192;
    const targetBudgetMB = Math.min(
      Math.floor(sysMB * CONFIG.SAFE_FRACTION_OF_SYS),
      CONFIG.MAX_SAFE_MB_CAP
    );
    const headroom = Math.max(0, targetBudgetMB - mem.currentMemoryMB);

    // Hysteresis: allow growth (UP) before clamping, shrink earlier (DOWN)
    const hysteresisHeadroom =
      headroom + (headroom > 0 ? CONFIG.HEADROOM_MB_UP : -CONFIG.HEADROOM_MB_DOWN);

    const maxByMem = Math.max(
      CONFIG.MIN_MAX_LOADED,
      Math.floor(hysteresisHeadroom / CONFIG.ESTIMATED_VIDEO_MEMORY_MB)
    );

    // Scale down when under pressure or a recent long task
    const pressure = smoothPressureRef.current;
    const pressureScale = Math.max(0.4, 1 - 0.6 * pressure);
    const longTaskScale = hadLongTaskRecently ? CONFIG.LONG_TASK_DERATE : 1;

    const want = Math.floor(
      Math.min(baseByDM, maxByMem) * pressureScale * longTaskScale
    );

    // Bound by collection size (plus small buffer)
    const listBound = Math.max(
      CONFIG.MIN_MAX_LOADED,
      Math.min(want, (progressiveVideos?.length || 0) + 20)
    );

    // Smooth step from previous to avoid oscillation
    const prev = prevLimitsRef.current.maxLoaded || CONFIG.MIN_MAX_LOADED;
    const delta = Math.max(
      -CONFIG.SMOOTH_MAX_STEP,
      Math.min(CONFIG.SMOOTH_MAX_STEP, listBound - prev)
    );
    let maxLoaded = Math.max(CONFIG.MIN_MAX_LOADED, prev + delta);

    // ---- NEW: ensure loaded cap can satisfy the user's playing cap (+ buffer) ----
    if (typeof playingCap === "number" && playingCap > 0) {
      const floor = playingCap + CONFIG.PLAY_PRELOAD_BUFFER;
      const safeFloor = Math.min(floor, listBound, CONFIG.MAX_LOADED_SOFT_CAP);
      if (maxLoaded < safeFloor) maxLoaded = safeFloor;
    }

    // Concurrent loaders: small fraction of maxLoaded, clamped
    const baseLoaders = Math.max(4, Math.floor(maxLoaded / 8));
    const maxConcurrentLoading = Math.min(
      CONFIG.BASE_MAX_LOADING,
      hadLongTaskRecently ? Math.max(4, Math.floor(baseLoaders * 0.6)) : baseLoaders
    );

    const computed = {
      maxLoaded,
      maxConcurrentLoading,
      memo: {
        baseByDM,
        sysMB,
        targetBudgetMB,
        headroomMB: headroom,
        pressure: Number(pressure.toFixed(3)),
        memSource: mem.source,
      },
    };
    prevLimitsRef.current = computed;
    return computed;
  }, [
    progressiveVideos?.length,
    mem.source,
    mem.currentMemoryMB,
    mem.totalMemoryMB,
    hadLongTaskRecently,
    playingCap, // re-evaluate if user cap changes
  ]);

  // --- admission control (relaxed + visible priority) ---
  const canLoadVideo = useCallback(
    (id) => {
      if (!id) return false;

      // Hard cap on *loaded* to avoid runaway memory; let visible bypass to reload if needed
      if (_loadedVideos.size >= limits.maxLoaded) {
        const isVisCapBypass = _visibleVideos.has(id);
        if (!isVisCapBypass) return false;
      }

      const isVis = _visibleVideos.has(id);
      const near = isNear ? !!isNear(id) : false;

      // Always allow visible; permit small overflow over loader cap
      if (isVis) {
        const overflow = Math.max(2, Math.floor(limits.maxConcurrentLoading * 0.25));
        if (_loadingVideos.size <= limits.maxConcurrentLoading + overflow) return true;
        return false;
      }

      // Non-visible obey the loader cap strictly
      if (_loadingVideos.size >= limits.maxConcurrentLoading) return false;

      // Allow near items
      if (near) return true;

      // Allow far non-visible when we have headroom (keep 50% slots free)
      const loaderHeadroom =
        _loadingVideos.size < Math.floor(limits.maxConcurrentLoading * 0.5);
      return loaderHeadroom;
    },
    [
      _visibleVideos,
      _loadedVideos.size,
      _loadingVideos.size,
      limits.maxLoaded,
      limits.maxConcurrentLoading,
      isNear,
    ]
  );

  // Evict to meet limits (prefer to free non-visible, non-playing first; never evict visible/playing)
  const lastCleanupAtRef = useRef(0);
  const performCleanup = useCallback(() => {
    // basic throttle (avoid floods from callers/effects)
    const now = Date.now();
    if (now - lastCleanupAtRef.current < 500) return;
    lastCleanupAtRef.current = now;

    const overBy = _loadedVideos.size - limits.maxLoaded;
    if (overBy <= 0) return;

    const loaded = Array.from(_loadedVideos);

    // Score: lower = better candidate for eviction
    const score = (id) => {
      const vis = _visibleVideos.has(id) ? 2 : 0;
      const play = _playingVideos.has(id) ? 4 : 0;
      const near = isNear ? (isNear(id) ? 1 : 0) : 0;
      return play + vis + near; // 0 best (not playing, not visible, not near)
    };

    loaded.sort((a, b) => score(a) - score(b));

    let toRemove = overBy;
    const victims = [];
    for (const id of loaded) {
      if (toRemove <= 0) break;
      if (_playingVideos.has(id)) continue;  // never evict active playback
      if (_visibleVideos.has(id)) continue;  // keep visible loaded
      victims.push(id);
      toRemove--;
    }

    if (victims.length > 0 && __DEV__) {
      // eslint-disable-next-line no-console
      console.warn(`♻️ Evicting ${victims.length} tiles to meet limits (${limits.maxLoaded}).`);
    }
    return victims.length > 0 ? victims : undefined;
  }, [_loadedVideos, limits.maxLoaded, _visibleVideos, _playingVideos, isNear]);

  // Dev logging (throttled, skip until IPC answers)
  const logThrottle = useRef(0);
  useEffect(() => {
    if (!__DEV__ || mem.source === "unknown") return;
    const now = Date.now();
    if (now - logThrottle.current > 3000) {
      // eslint-disable-next-line no-console
      console.log(
        `🧠 ${mem.source} mem: ${mem.currentMemoryMB}/${mem.totalMemoryMB}MB (p=${(mem.memoryPressure * 100) | 0}%) | maxLoaded=${limits.maxLoaded} loaders=${limits.maxConcurrentLoading}`
      );
      logThrottle.current = now;
    }
  }, [
    mem.currentMemoryMB,
    mem.totalMemoryMB,
    mem.source,
    mem.memoryPressure,
    limits.maxLoaded,
    limits.maxConcurrentLoading,
  ]);

  const memoryStatus = useMemo(
    () => ({
      currentMemoryMB: mem.currentMemoryMB,
      totalMemoryMB: mem.totalMemoryMB,
      memoryPressure: Math.round(mem.memoryPressure * 100),
      isNearLimit: mem.memoryPressure > 0.85,
      source: mem.source,
    }),
    [mem]
  );

  return {
    canLoadVideo,
    performCleanup,
    limits,
    memoryStatus,
  };
}
