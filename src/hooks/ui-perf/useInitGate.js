import { useRef, useEffect, useCallback } from "react";

export default function useInitGate({
  perFrame = 6,
  suspended = false,
  maxPending = 256,
} = {}) {
  const queueRef = useRef([]);
  const rafRef = useRef(0);
  const mountedRef = useRef(true);
  const perFrameRef = useRef(perFrame);
  const suspendedRef = useRef(Boolean(suspended));
  const maxPendingRef = useRef(maxPending);

  perFrameRef.current = Math.max(1, Number(perFrame) || 1);
  suspendedRef.current = Boolean(suspended);
  maxPendingRef.current = Math.max(1, Math.floor(Number(maxPending) || 1));

  const pump = useCallback(() => {
    rafRef.current = 0;
    if (!mountedRef.current || suspendedRef.current) return;

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

  useEffect(() => {
    if (!suspended) return;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    queueRef.current.length = 0;
  }, [suspended]);

  const scheduleInit = useCallback((fn) => {
    if (
      !mountedRef.current ||
      suspendedRef.current ||
      typeof fn !== "function" ||
      queueRef.current.length >= maxPendingRef.current
    ) {
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
