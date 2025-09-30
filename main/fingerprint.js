const fs = require('fs');
const crypto = require('crypto');

const DEFAULT_SAMPLE_SIZE = 64 * 1024; // 64KB front/back sampling

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

  const hash = crypto.createHash('sha256');
  let handle;
  try {
    if (size > 0) {
      handle = await fs.promises.open(filePath, 'r');
      const sampleSize = Math.min(DEFAULT_SAMPLE_SIZE, size);
      const head = await readSample(handle, 0, sampleSize);
      hash.update(head);

      if (size > sampleSize) {
        const tail = await readSample(handle, Math.max(0, size - sampleSize), sampleSize);
        hash.update(tail);
      } else {
        hash.update(head);
      }
    }
  } catch (error) {
    // If the file can't be read (locked/deleted), still produce a fingerprint fallback
    hash.update(String(error.message || 'error'));
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {}
    }
  }

  hash.update(Buffer.from(String(size)));
  hash.update(Buffer.from(String(createdMs)));

  const digest = hash.digest('hex');
  const fingerprint = `v1-${size.toString(16)}-${createdMs}-${digest}`;

  return { fingerprint, size, createdMs };
}

module.exports = {
  computeFingerprint,
};
