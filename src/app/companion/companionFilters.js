// Filtering by what companion apps say (docs/architecture/companion-app.md).
// A filter names a companion by its id and one of its actions by id
// (`c1/polish`) and asks for a phase; a companion's own words never appear
// here. A phase filter shows only clips the companion has answered for: one
// it has not answered yet (or never will, being missing) cannot be shown to
// be "Done", so it is hidden and counted in the status line instead. "Hide
// clips already sent" keeps an unanswered clip, since hiding it would be the
// guess.

export const COMPANION_PHASE_FILTERS = Object.freeze([
  "not-sent",
  "sent",
  "under-way",
  "done",
  "stopped",
  "n/a",
  // Anything short of done that the action applies to: never sent, under
  // way or stopped. The worklist of what is left to finish.
  "not-done",
]);

export const COMPANION_PHASE_LABELS = Object.freeze({
  "not-sent": "Not sent",
  sent: "Sent",
  "under-way": "Under way",
  done: "Done",
  stopped: "Stopped",
  "n/a": "Does not apply",
  "not-done": "Not done",
});

const SENT_PHASES = new Set(["under-way", "done", "stopped"]);
const ACTION_ID = /^[a-z][a-z0-9_-]{0,31}$/u;
const FILTER_KEY = /^(c[1-9])\/([a-z][a-z0-9_-]{0,31})$/u;
const MAX_ACTION_FILTERS = 8;

/** A filter's key: the companion's id and the action's. */
export const companionFilterKey = (companionId, actionId) => `${companionId}/${actionId}`;

/** `{ companionId, actionId }` from a filter key, or null. */
export function parseCompanionFilterKey(key) {
  const match = FILTER_KEY.exec(key);
  return match ? { companionId: match[1], actionId: match[2] } : null;
}

/**
 * `{ "c1/polish": phaseFilter }`, keeping only well-formed entries. A plain
 * action id, saved when a profile had one companion, belongs to the first.
 */
export function normalizeCompanionFilters(value) {
  const result = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [rawKey, phase] of Object.entries(value)) {
    if (Object.keys(result).length >= MAX_ACTION_FILTERS) break;
    const key = ACTION_ID.test(rawKey) ? companionFilterKey("c1", rawKey) : rawKey;
    if (FILTER_KEY.test(key) && COMPANION_PHASE_FILTERS.includes(phase)) result[key] = phase;
  }
  return result;
}

export const isCompanionSent = (stage) => SENT_PHASES.has(stage?.phase);

const PASS = Object.freeze({ pass: true, unansweredBy: null });
const FAIL = Object.freeze({ pass: false, unansweredBy: null });

/**
 * Whether a clip passes the per-action filters and, with `hideSent`, was
 * never sent for any action of any companion: `{ pass, unansweredBy }`.
 * `entryFor(companionId)` is what that companion said about the clip
 * (`{ actions: { [id]: { phase } } }`), or nothing yet; `companionIds` are
 * the companions to judge it by. A clip that fails only for want of an
 * answer names the first companion it waits on in `unansweredBy`.
 */
export function companionFilterVerdict(entryFor, companionIds, companionFilters, hideSent = false) {
  if (hideSent) {
    for (const id of companionIds) {
      const stages = entryFor(id)?.actions;
      if (stages && Object.values(stages).some(isCompanionSent)) return FAIL;
    }
  }
  let unansweredBy = null;
  for (const [key, wanted] of Object.entries(companionFilters || {})) {
    const parsed = parseCompanionFilterKey(key);
    if (!parsed) continue;
    const stage = entryFor(parsed.companionId)?.actions?.[parsed.actionId];
    if (!stage) {
      unansweredBy ??= parsed.companionId;
      continue;
    }
    if (wanted === "sent") {
      if (!isCompanionSent(stage)) return FAIL;
    } else if (wanted === "not-done") {
      if (stage.phase === "done" || stage.phase === "n/a") return FAIL;
    } else if (stage.phase !== wanted) {
      return FAIL;
    }
  }
  return unansweredBy ? { pass: false, unansweredBy } : PASS;
}

export const matchesCompanionFilters = (...args) => companionFilterVerdict(...args).pass;

export const companionFilterCount = (filters) =>
  Object.keys(normalizeCompanionFilters(filters?.companionFilters)).length +
  (filters?.companionHideSent === true ? 1 : 0);
