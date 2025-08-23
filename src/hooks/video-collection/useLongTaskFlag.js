import { useEffect, useRef, useState } from "react";

/**
 * Returns { hadLongTaskRecently } that turns true on Long Tasks or big frame hitches,
 * then decays to false after `decayMs`.
 */
export default function useLongTaskFlag({ hitchMs = 80, decayMs = 800 } = {}) {
  const [hadLongTaskRecently, setHadLongTaskRecently] = useState(false);
  const decayTimerRef = useRef(null);

  // Helper: set flag then decay after N ms
  const trip = () => {
    setHadLongTaskRecently(true);
    if (decayTimerRef.current) clearTimeout(decayTimerRef.current);
    decayTimerRef.current = setTimeout(() => setHadLongTaskRecently(false), decayMs);
  };

  // Long Tasks API (where supported)
  useEffect(() => {
    if (typeof PerformanceObserver !== "function") return;
    let obs;
    try {
      obs = new PerformanceObserver((list) => {
        if (list.getEntries && list.getEntries().length) trip();
      });
      obs.observe({ entryTypes: ["longtask"] });
    } catch {}
    return () => { try { obs?.disconnect(); } catch {} };
  }, []);

  // rAF hitch detector (covers browsers without Long Tasks API)
  useEffect(() => {
    let rafId = 0;
    let last = performance.now();
    const loop = (t) => {
      const dt = t - last;
      last = t;
      if (dt > hitchMs) trip();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [hitchMs]);

  useEffect(() => () => { if (decayTimerRef.current) clearTimeout(decayTimerRef.current); }, []);

  return { hadLongTaskRecently };
}
