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

module.exports = {
  FINGERPRINT_VERSION,
  LEGACY_FINGERPRINT_VERSION,
  computeFingerprint,
  isCurrentFingerprint,
  isLegacyFingerprint,
};
