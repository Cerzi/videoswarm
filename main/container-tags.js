const fs = require("fs");
const path = require("path");
const { iterateMp4MoovPayloads, readAtom } = require("./videoDimensions");
const { selectEmbeddedPayload } = require("./embedded-metadata-probe");

// In-process reader for the string tags ComfyUI and VHS embed in ISO-BMFF
// containers: `moov/udta/meta` with `keys` + `ilst` (ffmpeg's `mdta` style,
// used by SaveVideo) and `©cmt`-style items (the VHS comment envelope).
// Recognition of which tags matter is shared with the ffprobe path.

const ISO_BMFF_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".qt", ".3gp"]);

const CONTAINER_TAG_LIMITS = Object.freeze({
  maxMoovBytes: 8 * 1024 * 1024,
  maxBoxesPerLevel: 1024,
  maxKeys: 256,
  maxValueBytes: 2 * 1024 * 1024,
  maxTotalValueBytes: 4 * 1024 * 1024,
});

// Only these are decoded; everything else, including the large visual
// `workflow` graph, is skipped without being turned into a string unless a
// caller asks for it (`includeWorkflow`).
const WANTED_TAGS = new Set(["prompt", "comment", "description"]);
const WANTED_TAGS_WITH_WORKFLOW = new Set([...WANTED_TAGS, "workflow"]);
const FOURCC_TAGS = new Map([
  ["©cmt", "comment"],
  ["©des", "description"],
  ["desc", "description"],
]);
const UTF8_DATA_TYPE = 1;

function isIsoBmffPath(filePath) {
  return ISO_BMFF_EXTENSIONS.has(path.extname(String(filePath || "")).toLowerCase());
}

function* childAtoms(buffer, limits) {
  let offset = 0;
  let visited = 0;
  while (offset + 8 <= buffer.length) {
    visited += 1;
    if (visited > limits.maxBoxesPerLevel) return;
    const atom = readAtom(buffer, offset);
    if (!atom) return;
    // readAtom decodes the type as ASCII, which clears the high bit of the
    // `©` in QuickTime item names; keep the exact bytes alongside it.
    atom.rawType = buffer.toString("latin1", offset + 4, offset + 8);
    atom.typeValue = buffer.readUInt32BE(offset + 4);
    yield atom;
    offset = atom.end;
  }
}

function findChild(buffer, type, limits) {
  for (const atom of childAtoms(buffer, limits)) {
    if (atom.type === type) return atom;
  }
  return null;
}

// ISO `meta` is a full box (version + flags before its children); QuickTime's
// is not. A QuickTime `meta` starts directly with its `hdlr` child.
function metaChildren(meta) {
  const data = meta.data;
  if (data.length >= 8 && data.toString("latin1", 4, 8) === "hdlr") return data;
  return data.subarray(4);
}

function readKeys(keysAtom, limits) {
  const data = keysAtom?.data;
  if (!data || data.length < 8) return [];
  const count = data.readUInt32BE(4);
  if (count > limits.maxKeys) return [];
  const keys = [];
  let offset = 8;
  for (let index = 0; index < count; index += 1) {
    if (offset + 8 > data.length) break;
    const size = data.readUInt32BE(offset);
    if (size < 8 || offset + size > data.length) break;
    keys.push(data.toString("utf8", offset + 8, offset + size));
    offset += size;
  }
  return keys;
}

function readDataValue(itemAtom, limits) {
  const dataAtom = findChild(itemAtom.data, "data", limits);
  if (!dataAtom || dataAtom.data.length < 8) return null;
  const typeIndicator = dataAtom.data.readUInt32BE(0) & 0x00ffffff;
  if (typeIndicator !== UTF8_DATA_TYPE) return null;
  const valueLength = dataAtom.data.length - 8;
  if (valueLength > limits.maxValueBytes) return null;
  return dataAtom.data.toString("utf8", 8);
}

// An `ilst` item is named either by a 1-based index into `keys` or by a
// four-character code.
function tagNameForItem(itemAtom, keys) {
  const keyIndex = itemAtom.typeValue;
  if (keyIndex >= 1 && keyIndex <= keys.length) {
    return keys[keyIndex - 1].toLowerCase();
  }
  return FOURCC_TAGS.get(itemAtom.rawType) || null;
}

function readMetaTags(meta, tags, budget, limits) {
  const wanted = limits.includeWorkflow ? WANTED_TAGS_WITH_WORKFLOW : WANTED_TAGS;
  const children = metaChildren(meta);
  const keys = readKeys(findChild(children, "keys", limits), limits);
  const ilst = findChild(children, "ilst", limits);
  if (!ilst) return;
  for (const item of childAtoms(ilst.data, limits)) {
    const name = tagNameForItem(item, keys);
    if (!name || !wanted.has(name) || tags[name] !== undefined) continue;
    const value = readDataValue(item, limits);
    if (value === null) continue;
    budget.used += Buffer.byteLength(value, "utf8");
    if (budget.used > limits.maxTotalValueBytes) return;
    tags[name] = value;
  }
}

// QuickTime user-data text atoms: 16-bit length, 16-bit language, text.
function readQuickTimeText(atom, limits) {
  const data = atom.data;
  if (data.length < 4) return null;
  const length = data.readUInt16BE(0);
  if (length > limits.maxValueBytes || 4 + length > data.length) return null;
  return data.toString("utf8", 4, 4 + length);
}

function parseMoovTags(moov, limits) {
  const tags = {};
  const budget = { used: 0 };
  const metas = [];
  const moovMeta = findChild(moov, "meta", limits);
  if (moovMeta) metas.push(moovMeta);
  const udta = findChild(moov, "udta", limits);
  if (udta) {
    for (const child of childAtoms(udta.data, limits)) {
      if (child.type === "meta") {
        metas.push(child);
        continue;
      }
      const name = FOURCC_TAGS.get(child.rawType);
      if (!name || tags[name] !== undefined) continue;
      const value = readQuickTimeText(child, limits);
      if (value !== null) tags[name] = value;
    }
  }
  for (const meta of metas) readMetaTags(meta, tags, budget, limits);
  return tags;
}

const OPEN_FLAGS =
  fs.constants.O_RDONLY | (Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0);

/**
 * Reads the embedded generation payload from an ISO-BMFF file without
 * spawning a process.
 *
 * `expected` is the catalogued `{ size, mtimeMs }`; a file that no longer
 * matches returns `changed` so its tags are never attributed to content that
 * has since been rewritten. Symbolic links are refused where the platform can
 * refuse them at open time.
 *
 * Statuses: `found`, `not-found`, `changed`, `unreadable` (I/O failure, which
 * the caller should treat as transient). Never throws.
 */
async function readIsoBmffEmbeddedPayload(filePath, expected = {}, options = {}) {
  const limits = { ...CONTAINER_TAG_LIMITS, ...options };
  let handle;
  try {
    handle = await fs.promises.open(filePath, OPEN_FLAGS);
  } catch (error) {
    return { status: "unreadable", code: error?.code || "OPEN_FAILED" };
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { status: "unreadable", code: "NOT_A_FILE" };
    if (
      (expected.size !== undefined && Number(expected.size) !== Number(stats.size)) ||
      (expected.mtimeMs !== undefined &&
        Math.abs(Number(expected.mtimeMs) - Number(stats.mtimeMs)) >= 1)
    ) {
      return { status: "changed" };
    }
    let tags = null;
    for await (const moov of iterateMp4MoovPayloads(handle, Number(stats.size), {
      maxMoovBytes: limits.maxMoovBytes,
    })) {
      if (!moov) break;
      tags = parseMoovTags(moov, limits);
      break;
    }
    if (!tags || Object.keys(tags).length === 0) return { status: "not-found" };
    const selected = selectEmbeddedPayload([
      { tags, scope: "format", streamIndex: null },
    ]);
    return selected.found
      ? { status: "found", payload: selected.payload }
      : { status: "not-found" };
  } catch (error) {
    return { status: "unreadable", code: error?.code || "READ_FAILED" };
  } finally {
    await handle.close().catch(() => {});
  }
}

module.exports = {
  CONTAINER_TAG_LIMITS,
  ISO_BMFF_EXTENSIONS,
  isIsoBmffPath,
  parseMoovTags,
  readIsoBmffEmbeddedPayload,
};
