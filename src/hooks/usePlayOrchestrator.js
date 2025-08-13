// hooks/usePlayOrchestrator.js
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Orchestrates which videos are *actively* allowed to play.
 * Input:
 *  - visibleIds: Set<string>
 *  - loadedIds: Set<string>
 *  - userCap: number (slider)
 *  - hoverId: string|null (boosted priority)
 *  - selectedIds: Set<string> (optional, boosted priority)
 *
 * Output:
 *  - activeSet: Set<string> of ids that should be playing now
 *  - dynamicCap: number (internal ceiling below userCap; gently adapts)
 *  - setHoverId(id|null): helper if you want to control from here (optional)
 */
export default function usePlayOrchestrator({
  visibleIds,
  loadedIds,
  userCap,
  hoverId = null,
  selectedIds = new Set(),
}) {
  // Adaptive cap (start conservative to avoid decoder stampede)
  const [dynamicCap, setDynamicCap] = useState(() => Math.min(userCap, 48));
  const lastChange = useRef(Date.now());

  // Promote steady behavior via simple LRU “stickiness”
  const lruOrderRef = useRef([]);         // most-recently-active first
  const lastActiveRef = useRef(new Set()); // last tick's active set

  // Keep dynamicCap within [16, userCap], adjust slowly
  useEffect(() => {
    setDynamicCap((c) => Math.min(Math.max(c, 16), userCap));
  }, [userCap]);

  // Periodically try to relax the cap a bit if we’re not churning
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      // If we haven't changed the set recently, we can try a gentle bump.
      if (now - lastChange.current > 4000) {
        setDynamicCap((c) => Math.min(userCap, c + 8));
      }
    }, 3000);
    return () => clearInterval(t);
  }, [userCap]);

  const activeSet = useMemo(() => {
    // Candidates: must be loaded & visible
    const candidates = [];
    for (const id of visibleIds) {
      if (loadedIds.has(id)) candidates.push(id);
    }

    if (candidates.length === 0) return new Set();

    // Build a simple score: hover >> selected >> sticky LRU >> default
    const lru = lruOrderRef.current;
    const lruIndex = new Map(lru.map((id, i) => [id, i])); // lower i = more recent

    const score = (id) => {
      let s = 0;
      if (hoverId && id === hoverId) s += 10000;           // force-on-hover
      if (selectedIds.has(id)) s += 500;                   // bias selected
      const li = lruIndex.has(id) ? lruIndex.get(id) : 1e6;
      s += Math.max(0, 2000 - li);                         // stickiness
      // You can add more (distance-to-center, etc.) later
      return s;
    };

    candidates.sort((a, b) => score(b) - score(a));

    const cap = Math.min(dynamicCap, userCap);
    const winners = new Set(candidates.slice(0, cap));

    // Update LRU: put winners to front (most recent)
    if (winners.size) {
      const next = [...lru.filter((id) => !winners.has(id))];
      for (const id of winners) next.unshift(id);
      // Trim to a bounded size (avoid unbounded growth)
      lruOrderRef.current = next.slice(0, 4000);
    }

    // Detect churn; if the active set keeps flipping too much, gently reduce cap
    const prev = lastActiveRef.current;
    let delta = 0;
    if (prev.size !== winners.size) {
      delta = Math.abs(prev.size - winners.size);
    } else {
      // count symmetric diff cheaply
      for (const id of winners) if (!prev.has(id)) { delta++; break; }
    }
    if (delta > 0) {
      lastChange.current = Date.now();
      // If we’re churning a lot while near the cap, step down a bit
      if (winners.size >= cap && cap > 24) {
        setDynamicCap((c) => Math.max(24, c - 8));
      }
    }

    lastActiveRef.current = winners;
    return winners;
  }, [visibleIds, loadedIds, userCap, dynamicCap, hoverId, selectedIds]);

  return { activeSet, dynamicCap };
}
