// hooks/video-collection/useProgressiveList.js
import { useEffect, useRef, useState } from "react";

export function useProgressiveList(
  items = [],
  initial = 100,
  batchSize = 50,
  intervalMs = 100
) {
  const safe = Array.isArray(items) ? items : [];
  const [visible, setVisible] = useState(() => Math.min(initial, safe.length));
  const prevLenRef = useRef(safe.length);
  const didInitRef = useRef(false);

  // Initialize once; clamp if list shrinks; don't reset on growth
  useEffect(() => {
    const prevLen = prevLenRef.current;
    const len = safe.length;

    if (!didInitRef.current) {
      didInitRef.current = true;
      setVisible(Math.min(initial, len));
    } else if (len < prevLen) {
      // shrink: clamp down to avoid showing stale slots
      setVisible((v) => Math.min(v, len));
    }
    // growth: do nothing; interval will keep advancing

    prevLenRef.current = len;
  }, [safe.length, initial]);

  // Single steady interval; no dependency on `visible`
  useEffect(() => {
    if (visible >= safe.length) return;

    const timer = setInterval(() => {
      setVisible((v) => (v < safe.length ? Math.min(v + batchSize, safe.length) : v));
    }, intervalMs);

    return () => clearInterval(timer);
  }, [safe.length, batchSize, intervalMs, visible]);

  return safe.slice(0, visible);
}
