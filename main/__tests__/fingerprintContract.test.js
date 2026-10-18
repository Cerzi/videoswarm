import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { computeFingerprint } = require("../fingerprint");

// The v2 content fingerprint is a contract, not an implementation detail:
// companion apps compute it to recognise a clip after it is moved, renamed
// or copied (docs/architecture/companion-app.md). These values are pinned so
// a change to what goes into it cannot pass unnoticed. Changing them means a
// new fingerprint version, announced to companion authors.

// The algorithm, written out for another implementation: SHA-256 over the
// first 64 KiB, then the last 64 KiB (the first again when the file is no
// larger), then the size in decimal; the fingerprint is
// `v2-<size in hex>-<digest in hex>`.
function referenceFingerprint(bytes) {
  const sample = 64 * 1024;
  const head = bytes.subarray(0, Math.min(sample, bytes.length));
  const tail = bytes.length > sample ? bytes.subarray(bytes.length - sample) : head;
  const digest = crypto
    .createHash("sha256")
    .update(head)
    .update(tail)
    .update(String(bytes.length))
    .digest("hex");
  return `v2-${bytes.length.toString(16)}-${digest}`;
}

const SMALL = Buffer.from(Array.from({ length: 1000 }, (_, index) => index % 251));
const LARGE = Buffer.from(Array.from({ length: 200_000 }, (_, index) => (index * 7) % 256));
const PINNED = {
  small: "v2-3e8-58128b292c56b1c5429f3e80a63e5127a9f419280f1ef46c34d1d248bdb7ee95",
  large: "v2-30d40-4dede7e6592156f2d177f7d7a3bb3d00fe4a0b43e3b6dffd8c8031da6e4ef8d1",
};

describe("content fingerprint v2 contract", () => {
  let dir;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("matches the written-out algorithm and the pinned values", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-fingerprint-"));
    for (const [name, bytes] of [["small", SMALL], ["large", LARGE]]) {
      const file = path.join(dir, `${name}.mp4`);
      fs.writeFileSync(file, bytes);
      const { fingerprint } = await computeFingerprint(file);
      expect(fingerprint).toBe(PINNED[name]);
      expect(referenceFingerprint(bytes)).toBe(PINNED[name]);
    }
  });

  it("does not depend on the file's name, place or times", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-fingerprint-"));
    const first = path.join(dir, "a.mp4");
    const moved = path.join(dir, "elsewhere", "renamed.mov");
    fs.writeFileSync(first, LARGE);
    fs.mkdirSync(path.dirname(moved));
    fs.copyFileSync(first, moved);
    fs.utimesSync(moved, new Date(0), new Date(0));
    expect((await computeFingerprint(moved)).fingerprint).toBe(PINNED.large);
  });
});
