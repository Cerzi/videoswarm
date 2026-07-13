import { useRef, useEffect, useCallback } from "react";

export default function useInitGate({ perFrame = 6 } = {}) {
  const queueRef = useRef([]);
  const rafRef = useRef(0);
  const mountedRef = useRef(true);
  const perFrameRef = useRef(perFrame);

  perFrameRef.current = Math.max(1, Number(perFrame) || 1);

  const pump = useCallback(() => {
    rafRef.current = 0;
    if (!mountedRef.current) return;

    let remaining = perFrameRef.current;
    while (remaining > 0 && queueRef.current.length) {
      const task = queueRef.current.shift();
      if (task.cancelled) continue;

      remaining -= 1;
      try { task.fn(); } catch {}
    }

    if (queueRef.current.length) {
      rafRef.current = requestAnimationFrame(pump);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      queueRef.current.length = 0;
    };
  }, []);

  const scheduleInit = useCallback((fn) => {
    if (!mountedRef.current || typeof fn !== "function") {
      return () => {};
    }

    const task = { fn, cancelled: false };
    queueRef.current.push(task);

    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(pump);
    }

    return () => {
      if (task.cancelled) return;
      task.cancelled = true;

      const index = queueRef.current.indexOf(task);
      if (index >= 0) queueRef.current.splice(index, 1);

      if (queueRef.current.length === 0 && rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
  }, [pump]);

  return { scheduleInit };
}
