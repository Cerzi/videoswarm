import { useRef, useEffect } from "react";

export default function useInitGate({ perFrame = 6 } = {}) {
  const queueRef = useRef([]);
  const budgetRef = useRef(perFrame);
  const rafRef = useRef(0);

  const pump = () => {
    budgetRef.current = perFrame;
    while (budgetRef.current > 0 && queueRef.current.length) {
      budgetRef.current--;
      const fn = queueRef.current.shift();
      try { fn(); } catch {}
    }
    rafRef.current = requestAnimationFrame(pump);
  };

  useEffect(() => {
    rafRef.current = requestAnimationFrame(pump);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const scheduleInit = (fn) => {
    queueRef.current.push(fn);
  };

  return { scheduleInit };
}
