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
