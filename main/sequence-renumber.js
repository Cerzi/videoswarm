"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/**
 * Renumber: write a sequence's order onto disk by renaming its files in place
 * (docs/architecture/clip-sequences.md, Section 5).
 *
 * - Gap numbering: positions become 010, 020, 030 … so a shot inserted later
 *   costs one rename instead of renumbering everything after it.
 * - Two-phase: every file first moves to a temporary name, then to its final
 *   one, so swaps and longer cycles resolve.
 * - No overwrite, ever: a target held by a file outside the batch aborts the
 *   whole batch before the first rename.
 * - All-or-nothing: a failure part-way through renames everything back.
 *
 * Nothing here touches the catalog. Metadata is keyed by content fingerprint,
 * so tags, ratings and review state follow the bytes to their new names.
 */

const SEQUENCE_NUMBER_STEP = 10;
const SEQUENCE_NUMBER_MIN_WIDTH = 3;
const RENUMBER_PLAN_TTL_MS = 5 * 60 * 1000;
const RENUMBER_MAX_PLANS_PER_OWNER = 1;
// A temporary name keeps the original name visible and ends in a
// non-video extension, so the watcher and scanners ignore it.
const TEMP_SUFFIX = ".vs-renumber";

const RENUMBER_CODES = Object.freeze({
  EMPTY: "SEQUENCE_RENUMBER_EMPTY",
  MISSING: "SEQUENCE_ENTRIES_MISSING",
  REPEATED: "SEQUENCE_RENUMBER_REPEATED_CLIP",
  COLLISION: "SEQUENCE_RENUMBER_COLLISION",
  SOURCE_INVALID: "SEQUENCE_RENUMBER_SOURCE_INVALID",
  SOURCE_CHANGED: "SEQUENCE_RENUMBER_SOURCE_CHANGED",
  PLAN_NOT_FOUND: "SEQUENCE_RENUMBER_PLAN_NOT_FOUND",
  PLAN_EXPIRED: "SEQUENCE_RENUMBER_PLAN_EXPIRED",
  BUSY: "SEQUENCE_RENUMBER_BUSY",
  FAILED: "SEQUENCE_RENUMBER_FAILED",
  ROLLBACK_FAILED: "SEQUENCE_RENUMBER_ROLLBACK_FAILED",
});

class SequenceRenumberError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "SequenceRenumberError";
    this.code = code;
    // Written for people: the transfer coordinator shows it as it is.
    this.expose = true;
    Object.assign(this, details);
  }
}

/** Positions are reported to people, so they count from one. */
function describePositions(positions) {
  const list = positions.map((position) => position + 1);
  if (list.length === 1) return `position ${list[0]}`;
  const shown = list.slice(0, 12).join(", ");
  const more = list.length > 12 ? ` and ${list.length - 12} more` : "";
  return `positions ${shown}${more}`;
}

function sequenceNumberWidth(count) {
  const largest = Math.max(1, Number(count) || 0) * SEQUENCE_NUMBER_STEP;
  return Math.max(SEQUENCE_NUMBER_MIN_WIDTH, String(largest).length);
}

function sequenceNumberPrefix(index, count) {
  return String((index + 1) * SEQUENCE_NUMBER_STEP).padStart(
    sequenceNumberWidth(count),
    "0"
  );
}

/**
 * The name without a number this feature wrote earlier, so renumbering a
 * renumbered folder gives `020_shot.mp4`, not `020_010_shot.mp4`.
 *
 * Only a gap number is recognised: three to five digits, a multiple of ten,
 * then an underscore. `2024_take.mp4` and `001_take.mp4` keep their digits.
 * The confirmation lists every final name, so a stripped prefix is seen
 * before anything is renamed.
 */
function stripSequenceNumber(name) {
  const match = /^(\d{3,5})_(.+)$/u.exec(String(name || ""));
  if (!match) return String(name || "");
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value === 0 || value % SEQUENCE_NUMBER_STEP !== 0) {
    return String(name);
  }
  return match[2];
}

function numberedName(name, index, count) {
  return `${sequenceNumberPrefix(index, count)}_${stripSequenceNumber(name)}`;
}

/**
 * Refuse a sequence that cannot be written onto disk as one number per file.
 * Returns the entries' resolved paths in order.
 *
 * entries: [{ absolutePath | null }] in sequence order.
 */
function assertEntriesResolvable(entries, { action = "renumber" } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new SequenceRenumberError(
      "This sequence has no clips",
      RENUMBER_CODES.EMPTY
    );
  }
  const missing = [];
  entries.forEach((entry, index) => {
    if (typeof entry?.absolutePath !== "string" || !entry.absolutePath) {
      missing.push(index);
    }
  });
  if (missing.length) {
    const verb = action === "export" ? "export" : "renumber";
    throw new SequenceRenumberError(
      `Cannot ${verb} while clips are missing: ${describePositions(missing)}. ` +
        "Restore them or remove them from the sequence first.",
      RENUMBER_CODES.MISSING,
      { positions: missing.map((position) => position + 1) }
    );
  }
  return entries.map((entry) => entry.absolutePath);
}

function pathKey(value, caseInsensitive) {
  const normalized = String(value).normalize("NFC");
  return caseInsensitive ? normalized.toLocaleLowerCase("en-US") : normalized;
}

/**
 * Pure planning: which file becomes which name. No filesystem access.
 *
 * Every entry must resolve (a missing clip would leave a hole in the numbers)
 * and no file may appear twice (a file carries one number). Entries already
 * carrying their target name are left alone.
 */
function planSequenceRenumber(entries, options = {}) {
  const pathImpl = options.pathImpl || path;
  const caseInsensitive =
    options.caseInsensitive ?? (process.platform === "win32" || process.platform === "darwin");
  const paths = assertEntriesResolvable(entries);

  const firstPosition = new Map();
  const repeats = [];
  paths.forEach((absolutePath, index) => {
    const key = pathKey(pathImpl.resolve(absolutePath), caseInsensitive);
    if (firstPosition.has(key)) {
      repeats.push([firstPosition.get(key), index]);
    } else {
      firstPosition.set(key, index);
    }
  });
  if (repeats.length) {
    const [first, second] = repeats[0];
    throw new SequenceRenumberError(
      `Positions ${first + 1} and ${second + 1} are the same file, and a file ` +
        "can carry only one number. Remove one of them, or export a numbered " +
        "copy instead, which copies the clip twice.",
      RENUMBER_CODES.REPEATED,
      { positions: repeats.flat().map((position) => position + 1) }
    );
  }

  const renames = [];
  let unchangedCount = 0;
  paths.forEach((absolutePath, index) => {
    const from = pathImpl.resolve(absolutePath);
    const directory = pathImpl.dirname(from);
    const fromName = pathImpl.basename(from);
    const toName = numberedName(fromName, index, paths.length);
    if (toName === fromName) {
      unchangedCount += 1;
      return;
    }
    renames.push({
      position: index + 1,
      directory,
      from,
      fromName,
      to: pathImpl.join(directory, toName),
      toName,
      // The caller's own record, returned with the result so it can update
      // whatever it keeps about the file (the catalog, for main.js).
      entry: entries[index],
    });
  });
  return { renames, unchangedCount, total: paths.length };
}

function isMissingError(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function identityOf(stats) {
  return `${stats.dev}:${stats.ino}`;
}

function fingerprintOf(stats) {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
}

async function lstatOrNull(fsPromises, filePath) {
  try {
    return await fsPromises.lstat(filePath, { bigint: true });
  } catch (error) {
    if (isMissingError(error)) return null;
    throw error;
  }
}

/**
 * Check a plan against the disk: every source is a regular file, and every
 * target is either free or held by a file that is itself being renamed.
 * Identity (device and inode) rather than the path decides "itself", which
 * also settles case-insensitive volumes and hard links correctly.
 */
async function preflightSequenceRenumber(plan, options = {}) {
  const fsPromises = options.fsPromises || fs.promises;
  const sources = new Map();
  for (const rename of plan.renames) {
    const stats = await lstatOrNull(fsPromises, rename.from);
    if (!stats || !stats.isFile() || stats.isSymbolicLink()) {
      throw new SequenceRenumberError(
        `${rename.fromName} (position ${rename.position}) is not a regular file on disk`,
        RENUMBER_CODES.SOURCE_INVALID,
        { positions: [rename.position] }
      );
    }
    rename.fingerprint = fingerprintOf(stats);
    sources.set(identityOf(stats), rename);
  }

  const collisions = [];
  for (const rename of plan.renames) {
    const existing = await lstatOrNull(fsPromises, rename.to);
    if (existing && !sources.has(identityOf(existing))) {
      collisions.push(rename);
    }
  }
  if (collisions.length) {
    const names = collisions.slice(0, 8).map((rename) => rename.toName);
    const more = collisions.length > 8 ? ` and ${collisions.length - 8} more` : "";
    throw new SequenceRenumberError(
      `Nothing was renamed: ${names.join(", ")}${more} already ` +
        `exist${collisions.length === 1 ? "s" : ""} and ` +
        `${collisions.length === 1 ? "is" : "are"} not part of this sequence.`,
      RENUMBER_CODES.COLLISION,
      { names: collisions.map((rename) => rename.toName) }
    );
  }
  return plan;
}

/**
 * Carry out a preflighted plan. Sources are re-checked first, so a file that
 * changed or moved after the confirmation stops the batch before anything is
 * renamed. Any failure afterwards renames every completed step back.
 */
async function executeSequenceRenumber(plan, options = {}) {
  const fsPromises = options.fsPromises || fs.promises;
  const tag = options.tag || crypto.randomBytes(4).toString("hex");

  for (const rename of plan.renames) {
    const stats = await lstatOrNull(fsPromises, rename.from);
    if (!stats || !stats.isFile() || fingerprintOf(stats) !== rename.fingerprint) {
      throw new SequenceRenumberError(
        `${rename.fromName} changed after the rename was confirmed; nothing was renamed`,
        RENUMBER_CODES.SOURCE_CHANGED,
        { positions: [rename.position] }
      );
    }
  }
  // Targets are checked again too: the confirmation may have sat open while
  // something else wrote into the folder.
  await preflightSequenceRenumber(
    { renames: plan.renames.map((rename) => ({ ...rename })) },
    { fsPromises }
  );

  const staged = [];
  const placed = [];
  const rollback = async () => {
    const failures = [];
    for (const rename of placed.reverse()) {
      try {
        await fsPromises.rename(rename.to, rename.temp);
      } catch (error) {
        failures.push({ path: rename.to, code: error?.code || "ERROR" });
      }
    }
    for (const rename of staged.reverse()) {
      try {
        if (await lstatOrNull(fsPromises, rename.from)) {
          failures.push({ path: rename.temp, code: "EEXIST" });
          continue;
        }
        await fsPromises.rename(rename.temp, rename.from);
      } catch (error) {
        failures.push({ path: rename.temp, code: error?.code || "ERROR" });
      }
    }
    return failures;
  };

  try {
    // Phase one: every source to a temporary name beside it.
    for (const [index, rename] of plan.renames.entries()) {
      const temp = `${rename.from}${TEMP_SUFFIX}-${tag}-${index}`;
      if (await lstatOrNull(fsPromises, temp)) {
        throw Object.assign(new Error("A temporary name is already taken"), {
          code: "EEXIST",
        });
      }
      await fsPromises.rename(rename.from, temp);
      staged.push({ ...rename, temp });
    }
    // Phase two: temporary names to finals. rename() replaces an existing
    // file on every platform Node supports, so each target is checked again
    // immediately before its own step.
    for (const rename of staged) {
      if (await lstatOrNull(fsPromises, rename.to)) {
        throw Object.assign(new Error(`${rename.toName} appeared during the rename`), {
          code: "EEXIST",
        });
      }
      await fsPromises.rename(rename.temp, rename.to);
      placed.push(rename);
    }
  } catch (error) {
    const failures = await rollback();
    if (failures.length) {
      throw new SequenceRenumberError(
        "Renumbering failed and some files could not be renamed back. " +
          `Look for names ending in ${TEMP_SUFFIX}-${tag} in: ` +
          [...new Set(plan.renames.map((rename) => rename.directory))].join(", "),
        RENUMBER_CODES.ROLLBACK_FAILED,
        { cause: error, failures }
      );
    }
    throw new SequenceRenumberError(
      `Renumbering failed (${error?.code || error?.message || "error"}); every file was renamed back`,
      RENUMBER_CODES.FAILED,
      { cause: error }
    );
  }

  return {
    renamed: plan.renames.map((rename) => ({
      position: rename.position,
      from: rename.from,
      to: rename.to,
      toName: rename.toName,
      entry: rename.entry,
    })),
    unchangedCount: plan.unchangedCount || 0,
  };
}

/**
 * Move each renamed instance to its new name in the catalog.
 *
 * The content rows are untouched -- tags, ratings and review state are keyed
 * by fingerprint -- so indexing the new path finds the same content and the
 * old path is retired. The watcher, where one runs, repeats the same
 * idempotent update. A failure for one file is logged rather than thrown:
 * the files are already renamed, and the next scan repairs the index.
 */
async function recordRenumberInCatalog(store, renamed, options = {}) {
  const pathImpl = options.pathImpl || path;
  const isCancelled = options.isCancelled || (() => false);
  const logger = options.logger || console;
  const roots = new Set();
  for (const item of renamed) {
    const catalogPath = item.entry?.catalogPath || item.from;
    const newCatalogPath = pathImpl.join(pathImpl.dirname(catalogPath), item.toName);
    try {
      await store.indexFile({
        filePath: newCatalogPath,
        rootPath: item.entry?.rootPath || undefined,
        assertActive: options.assertActive,
        refreshDirectoryCounts: false,
      });
      if (item.entry?.rootPath) roots.add(item.entry.rootPath);
    } catch (error) {
      if (isCancelled(error)) throw error;
      logger.warn?.("[sequences] Could not index a renumbered clip", {
        code: error?.code || null,
      });
    }
  }
  try {
    store.markFilesMissing(
      renamed.map((item) => item.entry?.catalogPath || item.from),
      { assertActive: options.assertActive }
    );
    for (const rootPath of roots) store.refreshDirectoryCounts(rootPath);
  } catch (error) {
    if (isCancelled(error)) throw error;
    logger.warn?.("[sequences] Could not retire renumbered paths", {
      code: error?.code || null,
    });
  }
}

/**
 * Plans awaiting confirmation. A plan is bound to the renderer that asked for
 * it, expires, and is replaced by that renderer's next request, so a stale
 * confirmation dialog cannot apply an old plan.
 */
function createSequenceRenumberCoordinator(options = {}) {
  const fsPromises = options.fsPromises || fs.promises;
  const pathImpl = options.pathImpl || path;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const ttlMs = Math.max(1, Number(options.ttlMs) || RENUMBER_PLAN_TTL_MS);
  const createPlanId =
    typeof options.createPlanId === "function"
      ? options.createPlanId
      : () => crypto.randomBytes(12).toString("hex");
  const plans = new Map();
  let running = false;

  const dropOwnerPlans = (ownerId) => {
    for (const [planId, plan] of plans) {
      if (plan.ownerId === ownerId) plans.delete(planId);
    }
  };

  async function prepare({ ownerId, entries, caseInsensitive, context = null }) {
    const plan = planSequenceRenumber(entries, { pathImpl, caseInsensitive });
    await preflightSequenceRenumber(plan, { fsPromises });
    dropOwnerPlans(ownerId);
    const planId = createPlanId();
    plans.set(planId, {
      ...plan,
      id: planId,
      ownerId,
      context,
      expiresAt: now() + ttlMs,
    });
    while ([...plans.values()].filter((entry) => entry.ownerId === ownerId).length >
      RENUMBER_MAX_PLANS_PER_OWNER) {
      plans.delete(plans.keys().next().value);
    }
    return {
      planId,
      total: plan.total,
      unchangedCount: plan.unchangedCount,
      renames: plan.renames.map((rename) => ({
        position: rename.position,
        directory: rename.directory,
        fromName: rename.fromName,
        toName: rename.toName,
      })),
    };
  }

  function take({ ownerId, planId }) {
    const plan = plans.get(planId);
    if (!plan || plan.ownerId !== ownerId) {
      throw new SequenceRenumberError(
        "This rename is no longer available; open it again",
        RENUMBER_CODES.PLAN_NOT_FOUND
      );
    }
    plans.delete(planId);
    if (plan.expiresAt <= now()) {
      throw new SequenceRenumberError(
        "This rename expired; open it again to check the folder afresh",
        RENUMBER_CODES.PLAN_EXPIRED
      );
    }
    return plan;
  }

  async function apply({ ownerId, planId, assertActive }) {
    if (running) {
      throw new SequenceRenumberError(
        "Another renumber is running",
        RENUMBER_CODES.BUSY
      );
    }
    const plan = take({ ownerId, planId });
    running = true;
    try {
      assertActive?.(plan.context);
      const result = await executeSequenceRenumber(plan, {
        fsPromises,
        tag: options.tag,
      });
      return { ...result, context: plan.context };
    } finally {
      running = false;
    }
  }

  function discardOwner(ownerId) {
    dropOwnerPlans(ownerId);
  }

  return { prepare, apply, discardOwner, get size() { return plans.size; } };
}

module.exports = {
  RENUMBER_CODES,
  SEQUENCE_NUMBER_STEP,
  SequenceRenumberError,
  assertEntriesResolvable,
  createSequenceRenumberCoordinator,
  describePositions,
  executeSequenceRenumber,
  numberedName,
  planSequenceRenumber,
  preflightSequenceRenumber,
  recordRenumberInCatalog,
  sequenceNumberPrefix,
  sequenceNumberWidth,
  stripSequenceNumber,
};
