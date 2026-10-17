import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// What companion apps say about the open collection
// (docs/architecture/companion-app.md). A profile can connect up to four;
// each runs its own session here. Every clip is looked up once, in chunks,
// so filters can judge the whole collection; after that only clips still
// under way are asked again, every few seconds while the window is visible,
// and everything on focus at most twice a minute. Answers live in this hook
// only, for the session.

export const COMPANION_LOOKUP_CHUNK = 500;
export const COMPANION_POLL_MS = 4000;
export const COMPANION_RETRY_MS = 30_000;
export const COMPANION_FOCUS_REFRESH_MS = 30_000;
const COLLECTION_SETTLE_MS = 400;
const MAX_STALE_ENTRIES = 5000;
const EMPTY_ENTRIES = new Map();
const NO_ACTIONS = Object.freeze([]);

function rowsOf(videos) {
  const rows = [];
  for (const video of videos || []) {
    const id = Number(video?.instanceId);
    if (Number.isSafeInteger(id) && id > 0 && video.present !== false) rows.push(id);
  }
  return rows;
}

const isUnderWay = (entry) =>
  Object.values(entry?.actions || {}).some((stage) => stage?.phase === "under-way");

export const MAX_COMPANIONS = 4;

/**
 * One companion's session, for `connection` (`{ id, enabled, url }`, or
 * nothing). Returns `{ id, status, name, actions, entries, refresh,
 * refreshAll }`, where `status` is "off", "connecting", "online" or
 * "offline", and `entries` maps catalog row -> `{ kind, chip, actions }`.
 */
export function useCompanion({ videos, suspended = false, connection = null }) {
  const api = typeof window !== "undefined" ? window.electronAPI?.companion : null;
  const [description, setDescription] = useState(null);
  const [status, setStatus] = useState("off");
  const [entries, setEntries] = useState(EMPTY_ENTRIES);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const rows = useMemo(() => rowsOf(videos), [videos]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // Everything below belongs to one connection; a new one starts afresh.
  const sessionRef = useRef({ epoch: 0, queue: new Set(), asked: new Set(), running: false });
  const lastFullRef = useRef(0);

  const id = connection?.id || null;
  const enabled = connection?.enabled === true && Boolean(id);
  const url = connection?.url || null;

  const merge = useCallback((results, chunk) => {
    setEntries((previous) => {
      let next = null;
      for (const id of chunk) {
        const entry = results?.[id];
        if (!entry) continue;
        const old = previous.get(id);
        if (old && JSON.stringify(old) === JSON.stringify(entry)) continue;
        if (!next) next = new Map(previous);
        next.set(id, entry);
      }
      return next || previous;
    });
  }, []);

  const runQueue = useCallback(async () => {
    const session = sessionRef.current;
    if (session.running || !api?.lookup) return;
    session.running = true;
    try {
      while (session.queue.size && session === sessionRef.current) {
        const chunk = [...session.queue].slice(0, COMPANION_LOOKUP_CHUNK);
        chunk.forEach((id) => session.queue.delete(id));
        let result;
        try {
          result = await api.lookup(id, chunk);
        } catch {
          result = null;
        }
        if (session !== sessionRef.current) return;
        if (!result?.success) {
          chunk.forEach((id) => session.queue.add(id));
          setStatus("offline");
          return;
        }
        merge(result.results, chunk);
      }
    } finally {
      session.running = false;
    }
  }, [api, id, merge]);

  const enqueue = useCallback(
    (ids) => {
      const session = sessionRef.current;
      for (const id of ids) {
        session.queue.add(id);
        session.asked.add(id);
      }
      void runQueue();
    },
    [runQueue]
  );

  const refreshAll = useCallback(() => {
    lastFullRef.current = Date.now();
    enqueue(rowsRef.current);
  }, [enqueue]);

  // Connect, and reconnect while not answering.
  useEffect(() => {
    sessionRef.current = { epoch: sessionRef.current.epoch + 1, queue: new Set(), asked: new Set(), running: false };
    setEntries(EMPTY_ENTRIES);
    setDescription(null);
    if (!api?.describe || !enabled) {
      setStatus("off");
      return undefined;
    }
    setStatus("connecting");
    return undefined;
  }, [api, enabled, id, url]);

  useEffect(() => {
    if (!api?.describe || !enabled || (status !== "connecting" && status !== "offline")) {
      return undefined;
    }
    const session = sessionRef.current;
    let alive = true;
    const connect = async () => {
      let result;
      try {
        result = await api.describe(id);
      } catch {
        result = null;
      }
      if (!alive || session !== sessionRef.current) return;
      if (result?.success) {
        setDescription({ name: result.name, actions: result.actions || NO_ACTIONS });
        // Ask again about everything once back, not only what was waiting.
        session.asked.clear();
        setStatus("online");
      } else {
        setStatus("offline");
      }
    };
    const timer = setTimeout(connect, status === "offline" ? COMPANION_RETRY_MS : 0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api, enabled, id, status, url]);

  // New clips in the collection are looked up once they settle. Answers for
  // clips long gone from it are let go.
  useEffect(() => {
    if (status !== "online") return undefined;
    const timer = setTimeout(() => {
      const session = sessionRef.current;
      if (entriesRef.current.size > rows.length + MAX_STALE_ENTRIES) {
        const current = new Set(rows);
        session.asked = new Set(rows.filter((id) => session.asked.has(id)));
        setEntries((previous) => new Map([...previous].filter(([id]) => current.has(id))));
      }
      const fresh = rows.filter((id) => !session.asked.has(id));
      if (fresh.length) {
        if (fresh.length === rows.length) lastFullRef.current = Date.now();
        enqueue(fresh);
      }
    }, COLLECTION_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [enqueue, rows, status]);

  // Clips under way are asked again until they settle.
  useEffect(() => {
    if (status !== "online" || suspended) return undefined;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const current = new Set(rowsRef.current);
      const waiting = [];
      for (const [id, entry] of entriesRef.current) {
        if (current.has(id) && isUnderWay(entry)) waiting.push(id);
      }
      if (waiting.length) enqueue(waiting);
    }, COMPANION_POLL_MS);
    return () => clearInterval(timer);
  }, [enqueue, status, suspended]);

  // Work done elsewhere shows up when the user comes back.
  useEffect(() => {
    if (status !== "online") return undefined;
    const onFocus = () => {
      if (Date.now() - lastFullRef.current >= COMPANION_FOCUS_REFRESH_MS) refreshAll();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshAll, status]);

  const name = description?.name || null;
  const actions = description?.actions || NO_ACTIONS;
  return useMemo(
    () => ({ id, status, name, actions, entries, refresh: enqueue, refreshAll }),
    [actions, enqueue, entries, id, name, refreshAll, status]
  );
}

const NO_CONNECTIONS = Object.freeze([]);
const NO_COMPANIONS = Object.freeze([]);

/**
 * Every companion the profile connects, each with its own session (see
 * `useCompanion`); those switched off are left out. Asks main for the list
 * again whenever `refreshKey` changes (a profile switch) and when it changes.
 */
export function useCompanions({ videos, suspended = false, refreshKey = 0 }) {
  const api = typeof window !== "undefined" ? window.electronAPI?.companion : null;
  const [connections, setConnections] = useState(NO_CONNECTIONS);

  useEffect(() => {
    if (!api?.getConnections) return undefined;
    let alive = true;
    api
      .getConnections()
      .then((value) => {
        if (alive) setConnections(Array.isArray(value) ? value : NO_CONNECTIONS);
      })
      .catch(() => {});
    const unsubscribe = api.onConnectionsChanged?.((value) =>
      setConnections(Array.isArray(value) ? value : NO_CONNECTIONS)
    );
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [api, refreshKey]);

  // Hooks run in a fixed order, so the sessions are fixed slots.
  const first = useCompanion({ videos, suspended, connection: connections[0] || null });
  const second = useCompanion({ videos, suspended, connection: connections[1] || null });
  const third = useCompanion({ videos, suspended, connection: connections[2] || null });
  const fourth = useCompanion({ videos, suspended, connection: connections[3] || null });
  return useMemo(() => {
    const active = [first, second, third, fourth].filter((companion) => companion.status !== "off");
    return active.length ? active : NO_COMPANIONS;
  }, [first, second, third, fourth]);
}
