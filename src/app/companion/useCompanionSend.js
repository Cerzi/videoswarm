import { useCallback, useEffect, useRef, useState } from "react";
import { COMPANION_SEND_CHUNK, rowsToSend } from "./companionSend";

const IDLE = Object.freeze({
  phase: "idle", // idle | checking | ready | sending | done | error
  done: 0,
  total: 0,
  again: false,
  dry: null, // Map row -> { result, why, estimate }
  final: null,
  error: "",
});

/**
 * Sends `instanceIds` to the companion's `action`: `check()` is the dry run,
 * `send()` sends the clips the dry run said it would, `cancel()` stops after
 * the chunk in flight. `onSent(rows)` follows a send, so lookups can refresh.
 */
export function useCompanionSend({ action, instanceIds, onSent }) {
  const [state, setState] = useState(IDLE);
  const runRef = useRef(0);
  const cancelRef = useRef(false);
  const onSentRef = useRef(onSent);
  onSentRef.current = onSent;
  const idsKey = instanceIds.join(",");

  useEffect(() => {
    runRef.current += 1;
    setState(IDLE);
  }, [action, idsKey]);

  const runChunks = useCallback(
    async (rows, { dryRun, again }, phase) => {
      const run = ++runRef.current;
      cancelRef.current = false;
      const results = new Map();
      setState((previous) => ({ ...previous, phase, done: 0, total: rows.length, again, error: "" }));
      for (let start = 0; start < rows.length; start += COMPANION_SEND_CHUNK) {
        const chunk = rows.slice(start, start + COMPANION_SEND_CHUNK);
        let answer;
        try {
          answer = await window.electronAPI?.companion?.send({
            action,
            instanceIds: chunk,
            dryRun,
            again,
          });
        } catch (error) {
          answer = { success: false, error: error?.message };
        }
        if (run !== runRef.current) return null;
        if (!answer?.success) {
          setState((previous) => ({
            ...previous,
            phase: "error",
            error: answer?.error || "The companion app did not answer",
          }));
          return null;
        }
        for (const [id, entry] of Object.entries(answer.results || {})) {
          results.set(Number(id), entry);
        }
        setState((previous) => ({ ...previous, done: Math.min(rows.length, start + chunk.length) }));
        if (cancelRef.current) break;
      }
      return results;
    },
    [action]
  );

  const check = useCallback(
    async (again = false) => {
      const results = await runChunks(instanceIds, { dryRun: true, again }, "checking");
      if (results) setState((previous) => ({ ...previous, phase: "ready", dry: results, final: null }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [idsKey, runChunks]
  );

  const send = useCallback(async () => {
    const rows = rowsToSend(state.dry);
    if (!rows.length) return;
    const results = await runChunks(rows, { dryRun: false, again: state.again }, "sending");
    if (!results) return;
    setState((previous) => ({ ...previous, phase: "done", final: results }));
    onSentRef.current?.(rows);
  }, [runChunks, state.again, state.dry]);

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  return { ...state, busy: state.phase === "checking" || state.phase === "sending", check, send, cancel };
}
