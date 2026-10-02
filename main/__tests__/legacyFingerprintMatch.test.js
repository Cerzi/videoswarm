import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  computeFingerprint,
  matchLegacyFingerprints,
  parseLegacyFingerprint,
} = require('../fingerprint');

describe('legacy fingerprint proof', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videoswarm-legacy-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeFile(name, contents) {
    const filePath = path.join(tempDir, name);
    fs.writeFileSync(filePath, contents);
    return { filePath, stats: fs.statSync(filePath) };
  }

  // The v1 identity a file had when it was first indexed at another time.
  async function legacyFingerprintAt(filePath, createdMs) {
    const stats = fs.statSync(filePath);
    const { legacyFingerprint } = await computeFingerprint(filePath, {
      size: stats.size,
      birthtimeMs: createdMs,
    });
    return legacyFingerprint;
  }

  it('parses the size, creation time and digest a v1 identity records', async () => {
    const { filePath } = writeFile('clip.mp4', 'parse-me');
    const legacy = await legacyFingerprintAt(filePath, 1_754_483_267_561);

    expect(parseLegacyFingerprint(legacy)).toMatchObject({
      size: 8,
      createdMs: '1754483267561',
    });
    expect(parseLegacyFingerprint('v2-8-abc')).toBeNull();
    expect(parseLegacyFingerprint(null)).toBeNull();
  });

  it('proves a row using its recorded creation time, not the file\'s', async () => {
    const { filePath, stats } = writeFile('moved.mp4', 'moved-across-devices');
    // A cross-device move or restore gives the file a new creation time, so
    // its own v1 digest no longer matches the stored one.
    const stored = await legacyFingerprintAt(filePath, 1_600_000_000_000);
    const { legacyFingerprint: current } = await computeFingerprint(filePath);
    expect(current).not.toBe(stored);

    await expect(
      matchLegacyFingerprints(filePath, stats, [stored])
    ).resolves.toEqual([stored]);
  });

  it('samples head and tail exactly as v1 did for files beyond one sample', async () => {
    const contents = Buffer.alloc(200 * 1024);
    for (let index = 0; index < contents.length; index += 1) {
      contents[index] = index % 251;
    }
    const { filePath, stats } = writeFile('large.mp4', contents);
    const stored = await legacyFingerprintAt(filePath, 42);

    await expect(
      matchLegacyFingerprints(filePath, stats, [stored])
    ).resolves.toEqual([stored]);
  });

  it('rejects a different file that merely shares the byte size', async () => {
    const original = writeFile('original.mp4', 'aaaaaaaaaaaa');
    const stored = await legacyFingerprintAt(original.filePath, 1_000);
    const other = writeFile('other.mp4', 'bbbbbbbbbbbb');

    await expect(
      matchLegacyFingerprints(other.filePath, other.stats, [stored])
    ).resolves.toEqual([]);
  });

  it('skips candidates of another size without reading the file', async () => {
    const { filePath } = writeFile('short.mp4', 'short');
    const stored = await legacyFingerprintAt(filePath, 1_000);
    const missingPath = path.join(tempDir, 'never-written.mp4');

    await expect(
      matchLegacyFingerprints(missingPath, { size: 999 }, [stored, 'not-a-v1'])
    ).resolves.toEqual([]);
  });

  it('proves nothing when the file cannot be read', async () => {
    const { filePath, stats } = writeFile('gone.mp4', 'about-to-vanish');
    const stored = await legacyFingerprintAt(filePath, 1_000);
    fs.rmSync(filePath);

    await expect(
      matchLegacyFingerprints(filePath, stats, [stored])
    ).resolves.toEqual([]);
  });
});
