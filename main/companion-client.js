const http = require("http");
const https = require("https");
const { loopbackLookup, parseCompanionUrl } = require("./companion-connection");

// A small client for a companion app on this machine
// (docs/architecture/companion-app.md). Video Swarm sends clip paths and
// shows what comes back; every answer is untrusted input, size-bounded and
// reduced to the few fields the protocol names. Labels are the companion's
// own words: Video Swarm renders them and never interprets them.

const PROTOCOL_VERSION = 1;
// Names Video Swarm to the companion on every send, so a companion can tell
// what this app sent (and later let it take back only that).
const CLIENT_NAME = "videoswarm";
const DEFAULT_TIMEOUT_MS = 60_000;
const SEND_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_LOOKUP_PATHS = 500;
const MAX_SEND_PATHS = 500;
const MAX_ACTIONS = 8;

const PHASES = new Set(["not-sent", "under-way", "done", "stopped", "n/a"]);
const TONES = new Set(["progress", "warning", "done", "info", "muted"]);
const SEND_RESULTS = new Set(["sent", "skipped", "refused"]);
const WITHDRAW_RESULTS = new Set(["withdrawn", "skipped", "refused"]);
// Targets (2026-10-20): an action can send into one of the companion's own
// places, say a project. Their ids are opaque (often folder paths): kept in
// the main process, never shown or logged.
const MAX_TARGETS = 200;
const MAX_TARGET_ID_CHARS = 4096;
const MAX_NEW_TARGET_CHARS = 80;
// Tags (2026-10-22): words a companion keeps about a clip, such as the
// characters a render was cast with. The owner's own library words: kept in
// memory for the session, never stored or logged.
const MAX_CLIP_TAGS = 64;
const MAX_TAG_CHARS = 64;
const ACTION_ID = /^[a-z][a-z0-9_-]{0,31}$/u;
const KIND = /^[a-z][a-z0-9_/-]{0,31}$/u;

class CompanionClientError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "CompanionClientError";
    this.code = code;
    Object.assign(this, extra);
  }
}

const unavailable = (message) => new CompanionClientError("COMPANION_UNAVAILABLE", message);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// A display string from the companion: one line, no control characters,
// bounded.
function cleanText(value, maxChars) {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

// What a companion's lookup tags are: a label to show ("Characters") and a
// one-line hint. Video Swarm shows them and never interprets them.
function normalizeTagsDeclaration(raw) {
  if (!isObject(raw)) return null;
  const label = cleanText(raw.label, 32);
  return label ? { label, hint: cleanText(raw.hint, 200) } : null;
}

// A clip's tags from a lookup: one-line strings, each once, at most 64.
function normalizeClipTags(raw) {
  if (!Array.isArray(raw)) return null;
  const tags = [];
  const seen = new Set();
  for (const value of raw) {
    if (tags.length >= MAX_CLIP_TAGS) break;
    const tag = cleanText(value, MAX_TAG_CHARS);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags.length ? tags : null;
}

// What an action that sends into a target says about them: what one is
// called and the wording for making a new one ("" when it cannot).
function normalizeTargetsDeclaration(raw) {
  if (!isObject(raw)) return null;
  return { label: cleanText(raw.label, 32) || "Target", new: cleanText(raw.new, 48) };
}

/**
 * `{ protocol, name, actions: [{ id, label, send, hint, quick, withdraw,
 * targets, pick }] }` or throws.
 */
function normalizeDescription(raw) {
  if (!isObject(raw)) {
    throw new CompanionClientError("COMPANION_BAD_RESPONSE", "The companion's description is not an object");
  }
  if (raw.protocol !== PROTOCOL_VERSION) {
    throw new CompanionClientError(
      "COMPANION_PROTOCOL",
      `The companion speaks protocol ${cleanText(String(raw.protocol), 16) || "unknown"}; Video Swarm speaks ${PROTOCOL_VERSION}`
    );
  }
  const actions = [];
  const seen = new Set();
  for (const entry of Array.isArray(raw.actions) ? raw.actions : []) {
    if (actions.length >= MAX_ACTIONS) break;
    if (!isObject(entry) || typeof entry.id !== "string" || !ACTION_ID.test(entry.id)) continue;
    if (seen.has(entry.id)) continue;
    const label = cleanText(entry.label, 32);
    if (!label) continue;
    seen.add(entry.id);
    const send = cleanText(entry.send, 48) || `Send to ${label}`;
    const targets = normalizeTargetsDeclaration(entry.targets);
    actions.push({
      id: entry.id,
      label,
      send,
      hint: cleanText(entry.hint, 200),
      // Offered as a one-click button on a card the action has not been
      // sent for. Optional; anything but true is false.
      quick: entry.quick === true,
      // Sends can be taken back through /api/withdraw.
      withdraw: entry.withdraw === true,
      // Sends go into a target the user picks (`{ label, new }`), and `pick`
      // is the picker's menu item.
      ...(targets ? { targets, pick: cleanText(entry.pick, 48) || `${send}…` } : {}),
    });
  }
  const tags = normalizeTagsDeclaration(raw.tags);
  return {
    protocol: PROTOCOL_VERSION,
    name: cleanText(raw.name, 48) || "Companion app",
    actions,
    ...(tags ? { tags } : {}),
  };
}

function normalizeStage(raw) {
  if (!isObject(raw) || !PHASES.has(raw.phase)) return null;
  const stage = { phase: raw.phase, why: cleanText(raw.why, 300) };
  if (Number.isSafeInteger(raw.position) && raw.position >= 0) stage.position = raw.position;
  return stage;
}

function normalizeChip(raw) {
  if (!isObject(raw)) return null;
  const label = cleanText(raw.label, 48);
  if (!label) return null;
  return { label, tone: TONES.has(raw.tone) ? raw.tone : "info" };
}

/**
 * What the companion says about each asked-for path, as a Map of path ->
 * `{ kind, chip, actions: { [id]: { phase, why, position? } } }`. Paths that
 * were not asked for are ignored; stages for unknown actions are dropped.
 */
function normalizeLookup(raw, paths, actionIds) {
  const clips = isObject(raw) && isObject(raw.clips) ? raw.clips : {};
  const result = new Map();
  for (const filePath of paths) {
    if (!Object.prototype.hasOwnProperty.call(clips, filePath)) continue;
    const entry = clips[filePath];
    if (!isObject(entry)) continue;
    const stages = isObject(entry.actions) ? entry.actions : {};
    const actions = {};
    for (const id of actionIds) {
      if (!Object.prototype.hasOwnProperty.call(stages, id)) continue;
      const stage = normalizeStage(stages[id]);
      if (stage) actions[id] = stage;
    }
    const tags = normalizeClipTags(entry.tags);
    result.set(filePath, {
      kind: typeof entry.kind === "string" && KIND.test(entry.kind) ? entry.kind : null,
      chip: normalizeChip(entry.chip),
      actions,
      ...(tags ? { tags } : {}),
    });
  }
  return result;
}

/**
 * The outcome for each asked-for path, as a Map of path ->
 * `{ result: "sent" | "skipped" | "refused" | "unknown", why, estimate }`.
 * A path the companion did not answer for is "unknown".
 */
function normalizeSendResults(raw, paths) {
  const results = isObject(raw) && isObject(raw.results) ? raw.results : {};
  const outcome = new Map();
  for (const filePath of paths) {
    const entry = Object.prototype.hasOwnProperty.call(results, filePath)
      ? results[filePath]
      : null;
    const result = isObject(entry) && SEND_RESULTS.has(entry.result) ? entry.result : "unknown";
    const estimate = Number(entry?.estimate);
    outcome.set(filePath, {
      result,
      why: cleanText(entry?.why, 300),
      estimate: Number.isFinite(estimate) && estimate >= 0 ? estimate : null,
    });
  }
  return outcome;
}

/**
 * A target list, in the companion's order, as `[{ id, label, detail,
 * current }]`: at most 200, each id once, the first `current` the only one.
 */
function normalizeTargets(raw) {
  const list = isObject(raw) && Array.isArray(raw.targets) ? raw.targets : [];
  const targets = [];
  const seen = new Set();
  let hasCurrent = false;
  for (const entry of list) {
    if (targets.length >= MAX_TARGETS) break;
    if (!isObject(entry) || typeof entry.id !== "string" || !entry.id) continue;
    if (entry.id.length > MAX_TARGET_ID_CHARS || seen.has(entry.id)) continue;
    const label = cleanText(entry.label, 48);
    if (!label) continue;
    seen.add(entry.id);
    const current = entry.current === true && !hasCurrent;
    if (current) hasCurrent = true;
    targets.push({ id: entry.id, label, detail: cleanText(entry.detail, 120), current });
  }
  return targets;
}

// The target a send or withdraw answered with, `{ id, label }`, or null.
function normalizeAnsweredTarget(raw) {
  const target = isObject(raw) ? raw.target : null;
  if (!isObject(target) || typeof target.id !== "string" || !target.id) return null;
  if (target.id.length > MAX_TARGET_ID_CHARS) return null;
  return { id: target.id, label: cleanText(target.label, 48) || "" };
}

// What a request names as its target: an id the companion gave, or a new
// one's name. Nothing for an action without targets.
function requestTarget(target) {
  if (target === undefined || target === null) return {};
  if (typeof target === "string" && target && target.length <= MAX_TARGET_ID_CHARS) {
    return { target };
  }
  if (isObject(target) && typeof target.new === "string") {
    const name = cleanText(target.new, MAX_NEW_TARGET_CHARS + 1);
    if (name && name.length <= MAX_NEW_TARGET_CHARS) return { target: { new: name } };
  }
  throw new CompanionClientError("COMPANION_REQUEST_INVALID", "That target cannot be sent");
}

/**
 * The outcome of a withdraw for each asked-for path, as a Map of path ->
 * `{ result: "withdrawn" | "skipped" | "refused" | "unknown", why }`.
 */
function normalizeWithdrawResults(raw, paths) {
  const results = isObject(raw) && isObject(raw.results) ? raw.results : {};
  const outcome = new Map();
  for (const filePath of paths) {
    const entry = Object.prototype.hasOwnProperty.call(results, filePath) ? results[filePath] : null;
    outcome.set(filePath, {
      result: isObject(entry) && WITHDRAW_RESULTS.has(entry.result) ? entry.result : "unknown",
      why: cleanText(entry?.why, 300),
    });
  }
  return outcome;
}

function assertPaths(paths, max) {
  if (!Array.isArray(paths) || paths.length > max) {
    throw new CompanionClientError("COMPANION_REQUEST_INVALID", `At most ${max} paths can be sent at once`);
  }
  return [...new Set(paths.filter((entry) => typeof entry === "string" && entry))];
}

function createCompanionClient({
  url,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sendTimeoutMs = SEND_TIMEOUT_MS,
  maxResponseBytes = MAX_RESPONSE_BYTES,
} = {}) {
  const origin = new URL(parseCompanionUrl(url));
  const transport = origin.protocol === "https:" ? https : http;

  function request(pathname, body, { timeout = timeoutMs } = {}) {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      const req = transport.request(
        {
          protocol: origin.protocol,
          hostname: origin.hostname.replace(/^\[|\]$/gu, ""),
          port: origin.port || (origin.protocol === "https:" ? 443 : 80),
          path: pathname,
          method: "POST",
          lookup: loopbackLookup,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "Content-Length": payload.length,
          },
          timeout,
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on("data", (chunk) => {
            size += chunk.length;
            if (size > maxResponseBytes) {
              finish(
                reject,
                new CompanionClientError("COMPANION_BAD_RESPONSE", "The companion's answer is too large")
              );
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed = null;
            try {
              parsed = text.trim() ? JSON.parse(text) : {};
            } catch {
              parsed = null;
            }
            if (res.statusCode < 200 || res.statusCode >= 300) {
              finish(
                reject,
                new CompanionClientError(
                  "COMPANION_REFUSED",
                  cleanText(parsed?.error, 300) ||
                    `The companion answered ${res.statusCode} to ${pathname}`,
                  { status: res.statusCode }
                )
              );
              return;
            }
            if (!isObject(parsed)) {
              finish(
                reject,
                new CompanionClientError("COMPANION_BAD_RESPONSE", `The companion's answer to ${pathname} is not JSON`)
              );
              return;
            }
            finish(resolve, parsed);
          });
          res.on("error", (error) => finish(reject, unavailable(error.message)));
        }
      );
      req.on("timeout", () =>
        req.destroy(unavailable(`The companion did not answer ${pathname} in time`))
      );
      req.on("error", (error) => {
        finish(
          reject,
          error instanceof CompanionClientError
            ? error
            : unavailable(`The companion is not reachable (${error.code || error.message})`)
        );
      });
      req.write(payload);
      req.end();
    });
  }

  async function describe() {
    return normalizeDescription(await request("/api/describe", {}));
  }

  async function lookup(paths, actionIds) {
    const wanted = assertPaths(paths, MAX_LOOKUP_PATHS);
    if (wanted.length === 0) return new Map();
    return normalizeLookup(await request("/api/lookup", { paths: wanted }), wanted, actionIds);
  }

  const assertAction = (action) => {
    if (typeof action !== "string" || !ACTION_ID.test(action)) {
      throw new CompanionClientError("COMPANION_REQUEST_INVALID", "Unknown companion action");
    }
  };

  async function targets(action) {
    assertAction(action);
    return normalizeTargets(await request("/api/targets", { action }));
  }

  // `ratings` maps a sent path to its stars, 0 to 5; unrated clips are left
  // out, and so is the field when none is rated. `target` is an id from
  // targets(), or `{ new: name }`. Answers `{ results, target }`, the target
  // being what the companion says it sent into (a new one's id included).
  async function send({ action, paths, ratings = null, dryRun = false, again = false, target = null }) {
    assertAction(action);
    const wanted = assertPaths(paths, MAX_SEND_PATHS);
    const named = requestTarget(target);
    if (wanted.length === 0) return { results: new Map(), target: null };
    const stars = {};
    for (const filePath of wanted) {
      const rating = ratings?.[filePath];
      if (Number.isInteger(rating) && rating >= 0 && rating <= 5) stars[filePath] = rating;
    }
    const raw = await request(
      "/api/send",
      {
        action,
        paths: wanted,
        ...(Object.keys(stars).length ? { ratings: stars } : {}),
        dry_run: dryRun === true,
        again: again === true,
        ...named,
        client: CLIENT_NAME,
      },
      { timeout: sendTimeoutMs }
    );
    return { results: normalizeSendResults(raw, wanted), target: normalizeAnsweredTarget(raw) };
  }

  // Takes back what this app sent (only that: the companion matches it by
  // `client`). Answers `{ results, target }` as send() does.
  async function withdraw({ action, paths, target = null }) {
    assertAction(action);
    const wanted = assertPaths(paths, MAX_SEND_PATHS);
    const named = requestTarget(target);
    if (wanted.length === 0) return { results: new Map(), target: null };
    const raw = await request(
      "/api/withdraw",
      { action, paths: wanted, ...named, client: CLIENT_NAME },
      { timeout: sendTimeoutMs }
    );
    return { results: normalizeWithdrawResults(raw, wanted), target: normalizeAnsweredTarget(raw) };
  }

  return { url: origin.origin, describe, lookup, targets, send, withdraw };
}

module.exports = {
  COMPANION_LIMITS: Object.freeze({
    maxLookupPaths: MAX_LOOKUP_PATHS,
    maxSendPaths: MAX_SEND_PATHS,
    maxActions: MAX_ACTIONS,
    maxNewTargetChars: MAX_NEW_TARGET_CHARS,
  }),
  CompanionClientError,
  PHASES,
  PROTOCOL_VERSION,
  TONES,
  createCompanionClient,
  normalizeDescription,
  normalizeLookup,
  normalizeSendResults,
};
