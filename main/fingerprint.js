const fs = require('fs');
const crypto = require('crypto');

const DEFAULT_SAMPLE_SIZE = 64 * 1024; // 64KB front/back sampling

// Fingerprint v1 mixed the file's creation time into content identity, so an
// ordinary byte-identical copy became a different content row and could not
// inherit review state, ratings, or tags. v2 removes creation time so copies
// and moves resolve to the same content.
//
// Both values are produced from one read. v1 is not dead weight: it is the
// only exact proof that a stored v1 row belongs to the bytes now on disk, so
// the catalog can re-key that row instead of guessing or orphaning metadata.
//
// v2 is also a contract: companion apps compute it to recognise a clip after
// it moves (docs/architecture/companion-app.md), and
// main/__tests__/fingerprintContract.test.js pins it. Changing what goes into
// it means a new version, announced to companion authors first.
const FINGERPRINT_VERSION = 'v2';
const LEGACY_FINGERPRINT_VERSION = 'v1';

function isLegacyFingerprint(value) {
  return typeof value === 'string' && value.startsWith(`${LEGACY_FINGERPRINT_VERSION}-`);
}

function isCurrentFingerprint(value) {
  return typeof value === 'string' && value.startsWith(`${FINGERPRINT_VERSION}-`);
}

async function readSample(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

async function computeFingerprint(filePath, stats) {
  const fileStats = stats || (await fs.promises.stat(filePath));
  const size = Number(fileStats.size || 0);
  const createdMs = Math.round(
    fileStats.birthtimeMs || fileStats.ctimeMs || fileStats.mtimeMs || 0
  );

  const legacyHash = crypto.createHash('sha256');
  const contentHash = crypto.createHash('sha256');
  const update = (chunk) => {
    legacyHash.update(chunk);
    contentHash.update(chunk);
  };
  let handle;
  try {
    if (size > 0) {
      handle = await fs.promises.open(filePath, 'r');
      const sampleSize = Math.min(DEFAULT_SAMPLE_SIZE, size);
      const head = await readSample(handle, 0, sampleSize);
      update(head);

      if (size > sampleSize) {
        const tail = await readSample(handle, Math.max(0, size - sampleSize), sampleSize);
        update(tail);
      } else {
        update(head);
      }
    }
  } catch (error) {
    // If the file can't be read (locked/deleted), still produce a fingerprint fallback
    update(String(error.message || 'error'));
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {}
    }
  }

  update(Buffer.from(String(size)));
  // Only v1 absorbs creation time, and only after the shared content bytes, so
  // the v2 digest stays a pure function of sampled content plus size.
  legacyHash.update(Buffer.from(String(createdMs)));

  const digest = contentHash.digest('hex');
  const legacyDigest = legacyHash.digest('hex');
  const fingerprint = `${FINGERPRINT_VERSION}-${size.toString(16)}-${digest}`;
  const legacyFingerprint =
    `${LEGACY_FINGERPRINT_VERSION}-${size.toString(16)}-${createdMs}-${legacyDigest}`;

  return { fingerprint, legacyFingerprint, size, createdMs };
}

// A v1 identity spells out everything its digest absorbed besides the sampled
// bytes. That lets a stored v1 row be proven against any file using the
// creation time recorded in the row rather than the file's current one, which
// a move across devices, a copy, or a restore from backup resets.
const LEGACY_FINGERPRINT_PATTERN = /^v1-([0-9a-f]+)-(-?\d+)-([0-9a-f]{64})$/;

function parseLegacyFingerprint(value) {
  const match =
    typeof value === 'string' ? LEGACY_FINGERPRINT_PATTERN.exec(value) : null;
  if (!match) return null;
  return {
    size: parseInt(match[1], 16),
    // Kept as written: the digest absorbed this exact decimal string.
    createdMs: match[2],
    digest: match[3],
  };
}

/**
 * Return the v1 fingerprints among `candidates` whose digest the file's
 * current bytes reproduce.
 *
 * Unlike computeFingerprint there is no error fallback: a file that cannot be
 * read proves nothing, so it matches nothing.
 */
async function matchLegacyFingerprints(filePath, stats, candidates) {
  const size = Number(stats?.size || 0);
  const parsedCandidates = (Array.isArray(candidates) ? candidates : [])
    .map((fingerprint) => ({ fingerprint, parsed: parseLegacyFingerprint(fingerprint) }))
    .filter(({ parsed }) => parsed && parsed.size === size);
  if (!parsedCandidates.length) return [];

  const samples = [];
  let handle;
  try {
    if (size > 0) {
      handle = await fs.promises.open(filePath, 'r');
      const sampleSize = Math.min(DEFAULT_SAMPLE_SIZE, size);
      const head = await readSample(handle, 0, sampleSize);
      samples.push(head);
      samples.push(
        size > sampleSize
          ? await readSample(handle, Math.max(0, size - sampleSize), sampleSize)
          : head
      );
    }
  } catch {
    return [];
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {}
    }
  }

  return parsedCandidates
    .filter(({ parsed }) => {
      const hash = crypto.createHash('sha256');
      samples.forEach((sample) => hash.update(sample));
      hash.update(Buffer.from(String(size)));
      hash.update(Buffer.from(parsed.createdMs));
      return hash.digest('hex') === parsed.digest;
    })
    .map(({ fingerprint }) => fingerprint);
}

module.exports = {
  FINGERPRINT_VERSION,
  LEGACY_FINGERPRINT_VERSION,
  computeFingerprint,
  isCurrentFingerprint,
  isLegacyFingerprint,
  matchLegacyFingerprints,
  parseLegacyFingerprint,
};
