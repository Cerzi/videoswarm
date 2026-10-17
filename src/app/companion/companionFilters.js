// Filtering by what a companion app says (docs/architecture/companion-app.md).
// A filter names the companion's actions by id and asks for a phase; the
// companion's own words never appear here. A clip the companion has not
// answered for yet passes every companion filter, so nothing is hidden on a
// guess.

export const COMPANION_PHASE_FILTERS = Object.freeze([
  "not-sent",
  "sent",
  "under-way",
  "done",
  "stopped",
  "n/a",
]);

export const COMPANION_PHASE_LABELS = Object.freeze({
  "not-sent": "Not sent",
  sent: "Sent",
  "under-way": "Under way",
  done: "Done",
  stopped: "Stopped",
  "n/a": "Does not apply",
});

const SENT_PHASES = new Set(["under-way", "done", "stopped"]);
const ACTION_ID = /^[a-z][a-z0-9_-]{0,31}$/u;
const MAX_ACTION_FILTERS = 8;

/** `{ [actionId]: phaseFilter }`, keeping only well-formed entries. */
export function normalizeCompanionFilters(value) {
  const result = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [id, phase] of Object.entries(value)) {
    if (Object.keys(result).length >= MAX_ACTION_FILTERS) break;
    if (ACTION_ID.test(id) && COMPANION_PHASE_FILTERS.includes(phase)) result[id] = phase;
  }
  return result;
}

export const isCompanionSent = (stage) => SENT_PHASES.has(stage?.phase);

/**
 * Whether a clip's companion entry (`{ actions: { [id]: { phase } } }`, or
 * nothing yet) passes the per-action filters and, with `hideSent`, was never
 * sent for any action.
 */
export function matchesCompanionFilters(entry, companionFilters, hideSent = false) {
  if (!entry) return true;
  const stages = entry.actions || {};
  if (hideSent && Object.values(stages).some(isCompanionSent)) return false;
  for (const [id, wanted] of Object.entries(companionFilters || {})) {
    const stage = stages[id];
    if (!stage) continue;
    if (wanted === "sent" ? !isCompanionSent(stage) : stage.phase !== wanted) return false;
  }
  return true;
}

export const companionFilterCount = (filters) =>
  Object.keys(normalizeCompanionFilters(filters?.companionFilters)).length +
  (filters?.companionHideSent === true ? 1 : 0);
