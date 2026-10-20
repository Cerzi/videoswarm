// Sending clips to a companion app's action (docs/architecture/companion-app.md):
// a dry run first, then the send, both in chunks so progress can show.

export const COMPANION_SEND_CHUNK = 100;
const MAX_REASONS = 6;

/** Rows with a catalog instance, and how many of `videos` have none. */
export function companionRowsOf(videos = []) {
  const ids = [];
  for (const video of videos) {
    const id = Number(video?.instanceId);
    if (Number.isSafeInteger(id) && id > 0) ids.push(id);
  }
  return { instanceIds: [...new Set(ids)], excludedCount: Math.max(0, videos.length - ids.length) };
}

function groupReasons(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const why = entry.why || "No reason given";
    counts.set(why, (counts.get(why) || 0) + 1);
  }
  return [...counts]
    .map(([why, count]) => ({ why, count }))
    .sort((a, b) => b.count - a.count || a.why.localeCompare(b.why))
    .slice(0, MAX_REASONS);
}

/**
 * Counts and grouped reasons for a Map of row -> `{ result, why, estimate }`.
 * `estimate` is the total of the sent clips' estimates, in seconds, or null
 * when none came with one.
 */
export function summarizeSendResults(results) {
  const by = { sent: [], skipped: [], refused: [], unknown: [] };
  let estimate = null;
  for (const entry of results?.values?.() || []) {
    const bucket = by[entry?.result] || by.unknown;
    bucket.push(entry || {});
    if (entry?.result === "sent" && Number.isFinite(entry.estimate)) {
      estimate = (estimate || 0) + entry.estimate;
    }
  }
  return {
    sent: by.sent.length,
    skipped: by.skipped.length,
    refused: by.refused.length,
    unknown: by.unknown.length,
    estimate,
    skippedReasons: groupReasons(by.skipped),
    refusedReasons: groupReasons(by.refused),
  };
}

/** "≈ 40 s", "≈ 12 min", "≈ 6 h 20 min". */
export function formatEstimate(seconds) {
  if (seconds === null || seconds === undefined || seconds === "") return "";
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 60) return `≈ ${Math.max(1, Math.round(value))} s`;
  const minutes = Math.round(value / 60);
  if (minutes < 60) return `≈ ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `≈ ${hours} h ${rest} min` : `≈ ${hours} h`;
}

/** Row ids whose dry run said they would be sent. */
export function rowsToSend(results) {
  const rows = [];
  for (const [id, entry] of results?.entries?.() || []) {
    if (entry?.result === "sent") rows.push(id);
  }
  return rows;
}

/**
 * Sends `instanceIds` to a companion's action in one click
 * (docs/architecture/companion-app.md): the dry run first, then, when every
 * clip would be sent, the send itself. Resolves to
 * `{ status: "sent", rows }` after sending, `{ status: "review", dry }` when
 * some clip would be skipped or refused (the caller shows why), or
 * `{ status: "error", error }`.
 */
export async function sendWithoutReview({ companionId, actionId, instanceIds, send }) {
  const call = send || window.electronAPI?.companion?.send;
  if (typeof call !== "function") return { status: "error", error: "Companion apps are unavailable" };
  try {
    const { results: dry } = await runSendChunks(call, { companionId, actionId, rows: instanceIds, dryRun: true });
    const rows = rowsToSend(dry);
    if (rows.length !== instanceIds.length || rows.length === 0) return { status: "review", dry };
    const { results: final } = await runSendChunks(call, { companionId, actionId, rows, dryRun: false });
    return { status: "sent", rows: rowsToSend(final), final };
  } catch (error) {
    return { status: "error", error: error?.message || String(error) };
  }
}

/**
 * Sends rows in chunks of COMPANION_SEND_CHUNK, merging the answers by row.
 * For an action with targets, `target` is `{ handle }` or `{ new: name }`:
 * a real send of a new target makes it with the first chunk, and the later
 * chunks go to the handle it answered with. Resolves to `{ results, target }`
 * (`{ handle, label }` or null); throws when the app does not answer.
 */
async function runSendChunks(call, { companionId, actionId, rows, dryRun, target = null }) {
  const results = new Map();
  let named = target;
  let answered = null;
  for (let start = 0; start < rows.length; start += COMPANION_SEND_CHUNK) {
    const chunk = rows.slice(start, start + COMPANION_SEND_CHUNK);
    let answer;
    try {
      answer = await call({
        companionId,
        action: actionId,
        instanceIds: chunk,
        dryRun,
        again: false,
        ...(named ? { target: named } : {}),
      });
    } catch (error) {
      answer = { success: false, error: error?.message };
    }
    if (!answer?.success) throw new Error(answer?.error || "The companion app did not answer");
    for (const [id, entry] of Object.entries(answer.results || {})) results.set(Number(id), entry);
    if (answer.target?.handle) {
      answered = { handle: answer.target.handle, label: answer.target.label || "" };
      if (!dryRun) named = { handle: answered.handle };
    }
  }
  return { results, target: answered };
}

/**
 * Checks what adding `instanceIds` to a target would do, without doing it:
 * `{ status: "checked", dry }` or `{ status: "error", error }`.
 */
export async function checkTargetSend({ companionId, actionId, instanceIds, target, send }) {
  const call = send || window.electronAPI?.companion?.send;
  if (typeof call !== "function") return { status: "error", error: "Companion apps are unavailable" };
  try {
    const { results } = await runSendChunks(call, {
      companionId,
      actionId,
      rows: instanceIds,
      dryRun: true,
      target,
    });
    return { status: "checked", dry: results };
  } catch (error) {
    return { status: "error", error: error?.message || String(error) };
  }
}

/**
 * Sends `instanceIds` into a target (`{ handle }` or `{ new: name }`): a dry
 * run, then what it said would be sent; what is already there or refused is
 * left as it is, which adding to a project can always do. Resolves to
 * `{ status: "sent", rows, dry, final, target }` (the rows actually sent, for
 * Undo), `{ status: "none", dry }` when nothing would be, or
 * `{ status: "error", error }`.
 */
export async function sendToTarget({ companionId, actionId, instanceIds, target, send }) {
  const call = send || window.electronAPI?.companion?.send;
  if (typeof call !== "function") return { status: "error", error: "Companion apps are unavailable" };
  try {
    const { results: dry } = await runSendChunks(call, {
      companionId,
      actionId,
      rows: instanceIds,
      dryRun: true,
      target,
    });
    const rows = rowsToSend(dry);
    if (!rows.length) return { status: "none", dry };
    const sent = await runSendChunks(call, { companionId, actionId, rows, dryRun: false, target });
    return {
      status: "sent",
      rows: rowsToSend(sent.results),
      dry,
      final: sent.results,
      target: sent.target,
    };
  } catch (error) {
    return { status: "error", error: error?.message || String(error) };
  }
}

/**
 * Takes back rows this app sent (Undo), in chunks: `{ status: "done",
 * results }` (row -> `{ result: "withdrawn" | "skipped" | "refused", why }`)
 * or `{ status: "error", error }`.
 */
export async function withdrawRows({ companionId, actionId, instanceIds, target = null, withdraw }) {
  const call = withdraw || window.electronAPI?.companion?.withdraw;
  if (typeof call !== "function") return { status: "error", error: "Companion apps are unavailable" };
  const results = new Map();
  try {
    for (let start = 0; start < instanceIds.length; start += COMPANION_SEND_CHUNK) {
      const chunk = instanceIds.slice(start, start + COMPANION_SEND_CHUNK);
      let answer;
      try {
        answer = await call({ companionId, action: actionId, instanceIds: chunk, ...(target ? { target } : {}) });
      } catch (error) {
        answer = { success: false, error: error?.message };
      }
      if (!answer?.success) throw new Error(answer?.error || "The companion app did not answer");
      for (const [id, entry] of Object.entries(answer.results || {})) results.set(Number(id), entry);
    }
    return { status: "done", results };
  } catch (error) {
    return { status: "error", error: error?.message || String(error) };
  }
}
