"use strict";

const path = require("path");
const {
  assertEntriesResolvable,
  numberedName,
} = require("./sequence-renumber");

/**
 * Rows for a numbered sequence copy (clip-sequences.md, Section 6, tier 1),
 * one per position in sequence order. A clip that recurs is copied once for
 * each position it holds, under each position's number.
 *
 * Export refuses while any entry is missing (Section 7): a shortened copy
 * looks like a finished one, so the refusal names the missing positions.
 */
function buildSequenceCopyRecords(snapshot, { pathImpl = path } = {}) {
  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
  assertEntriesResolvable(
    entries.map((entry) => ({
      absolutePath: entry?.instance?.absolutePath || null,
    })),
    { action: "export" }
  );
  return entries.map((entry, index) => {
    const instance = entry.instance;
    return {
      instanceId: instance.instanceId,
      rootPath: instance.rootPath,
      relativePath: instance.relativePath,
      absolutePath: instance.absolutePath,
      size: instance.size,
      mtimeMs: instance.mtimeMs,
      fingerprint: instance.fingerprint || entry.fingerprint || null,
      targetName: numberedName(
        pathImpl.basename(instance.absolutePath),
        index,
        entries.length
      ),
    };
  });
}

module.exports = { buildSequenceCopyRecords };
