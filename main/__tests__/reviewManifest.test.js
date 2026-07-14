import { describe, expect, it, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  REVIEW_MANIFEST_FORMAT,
  REVIEW_MANIFEST_MAX_FILENAME_BYTES,
  REVIEW_MANIFEST_MAX_RECORDS,
  createReviewManifest,
  normalizeManifestDirectory,
  reviewManifestDefaultName,
  serializeReviewManifest,
  writeReviewManifest,
} = require("../review-manifest");

const root = {
  rootPath: "/private/source/batch",
  label: "Batch 7",
  recursive: true,
  refreshState: "idle",
  lastScanCompletedAt: 1234,
};
const profile = { id: "profile-1", name: "Editorial" };

function record(relativePath, reviewState, extra = {}) {
  return {
    relativePath,
    absolutePath: `/private/source/batch/${relativePath}`,
    fingerprint: `fp-${relativePath}`,
    reviewState,
    rating: null,
    tags: [],
    size: 12345,
    mtimeMs: 4_000,
    createdMs: 3_000,
    dimensions: { width: 1280, height: 720, aspectRatio: 16 / 9 },
    generationMetadata: { prompt: "must not leak" },
    ...extra,
  };
}

describe("review manifest", () => {
  it("exports every state deterministically without absolute paths or sidecars", () => {
    const records = [
      record("z/reject.mp4", "reject", { tags: ["zeta", "alpha"] }),
      record("a/accept.mp4", "pick", { rating: 5 }),
      record("a/neutral.mp4", "reviewed"),
      record("a/new.mp4", "unreviewed", { rating: 0 }),
    ];
    const input = {
      profile,
      root,
      directory: "a",
      scope: "current-subtree",
      records,
      exportedAt: 1_700_000_000_000,
    };

    const first = createReviewManifest(input);
    const second = createReviewManifest({ ...input, records: [...records].reverse() });

    expect(first.format).toBe(REVIEW_MANIFEST_FORMAT);
    expect(first.version).toBe(1);
    expect(first.exportedAt).toBe("2023-11-14T22:13:20.000Z");
    expect(first.summary).toEqual({
      instanceCount: 3,
      uniqueCount: 3,
      reviewedTotal: 3,
      accept: 1,
      reviewed: 1,
      reject: 0,
      unreviewed: 1,
    });
    expect(first.clips.map((clip) => clip.relativePath)).toEqual([
      "a/accept.mp4",
      "a/neutral.mp4",
      "a/new.mp4",
    ]);
    expect(first.clips[0]).toMatchObject({
      rating: 5,
      sizeBytes: 12345,
      modifiedAtMs: 4_000,
      createdAtMs: 3_000,
      dimensions: { width: 1280, height: 720 },
    });
    expect(first.clips.at(-1).rating).toBe(0);
    expect(serializeReviewManifest(first)).toBe(serializeReviewManifest(second));
    const text = serializeReviewManifest(first);
    expect(text).not.toContain("/private/source");
    expect(text).not.toContain("must not leak");
  });

  it("supports direct-folder and entire-root scopes", () => {
    const records = [
      record("root.mp4", "unreviewed"),
      record("one/direct.mp4", "reject"),
      record("one/two/deep.mp4", "pick"),
    ];

    const direct = createReviewManifest({
      profile,
      root,
      directory: "one",
      scope: "current-folder",
      records,
      exportedAt: 1,
    });
    const all = createReviewManifest({
      profile,
      root,
      directory: "one",
      scope: "all-descendants",
      records,
      exportedAt: 1,
    });

    expect(direct.clips.map((clip) => clip.relativePath)).toEqual(["one/direct.mp4"]);
    expect(all.clips).toHaveLength(3);
    expect(all.scope.directory).toBe("");
  });

  it("requires recursively persisted coverage for descendant scopes", () => {
    expect(() =>
      createReviewManifest({
        profile,
        root: { ...root, recursive: false },
        directory: "one",
        scope: "current-subtree",
        records: [],
        exportedAt: 1,
      })
    ).toThrowError(expect.objectContaining({ code: "REVIEW_MANIFEST_INCOMPLETE_INDEX" }));

    expect(() =>
      createReviewManifest({
        profile,
        root: { ...root, recursive: false },
        directory: "",
        scope: "current-folder",
        records: [record("root.mp4", "unreviewed")],
        exportedAt: 1,
      })
    ).not.toThrow();
  });

  it("does not export a scanning or interrupted snapshot", () => {
    expect(() =>
      createReviewManifest({
        profile,
        root: { ...root, refreshState: "scanning" },
        directory: "",
        scope: "all-descendants",
        records: [],
        exportedAt: 1,
      })
    ).toThrowError(expect.objectContaining({ code: "REVIEW_MANIFEST_INDEX_NOT_READY" }));
  });

  it("rejects traversal and record counts over the hard bound", () => {
    expect(() => normalizeManifestDirectory("../outside")).toThrowError(
      expect.objectContaining({ code: "INVALID_REVIEW_MANIFEST_DIRECTORY" })
    );
    const records = Array.from({ length: REVIEW_MANIFEST_MAX_RECORDS + 1 }, (_, index) =>
      record(`clip-${String(index).padStart(5, "0")}.mp4`, "unreviewed")
    );
    expect(() =>
      createReviewManifest({ profile, root, directory: "", scope: "all-descendants", records })
    ).toThrowError(expect.objectContaining({ code: "REVIEW_MANIFEST_TOO_MANY_RECORDS" }));
  });

  it("enforces the serialized byte bound before atomic replacement", async () => {
    const manifest = createReviewManifest({
      profile,
      root,
      directory: "",
      scope: "all-descendants",
      records: [record("clip.mp4", "reviewed", { tags: ["long-tag"] })],
      exportedAt: 1,
    });
    const atomicWrite = vi.fn().mockResolvedValue(undefined);

    await expect(
      writeReviewManifest("/tmp/review.json", manifest, {
        maxBytes: 10,
        writeFileAtomically: atomicWrite,
      })
    ).rejects.toMatchObject({ code: "REVIEW_MANIFEST_TOO_LARGE" });
    expect(atomicWrite).not.toHaveBeenCalled();

    const result = await writeReviewManifest("/tmp/review.json", manifest, {
      writeFileAtomically: atomicWrite,
    });
    expect(result.bytes).toBeGreaterThan(0);
    expect(atomicWrite).toHaveBeenCalledWith(
      "/tmp/review.json",
      expect.stringContaining('"version": 1'),
      undefined
    );
  });

  it("forwards a publication ownership assertion to the atomic writer", async () => {
    const manifest = createReviewManifest({
      profile,
      root,
      directory: "",
      scope: "all-descendants",
      records: [],
      exportedAt: 1,
    });
    const assertActive = vi.fn();
    const atomicWrite = vi.fn().mockResolvedValue(undefined);

    await writeReviewManifest("/tmp/review.json", manifest, {
      assertActive,
      writeFileAtomically: atomicWrite,
    });

    expect(atomicWrite).toHaveBeenCalledWith(
      "/tmp/review.json",
      expect.any(String),
      { assertActive }
    );
  });

  it("creates a portable native-dialog filename", () => {
    expect(reviewManifestDefaultName({ label: "Batch / 07" })).toBe(
      "Batch-07-review-manifest.json"
    );
    expect(reviewManifestDefaultName({ label: "../..." })).toBe(
      "library-review-manifest.json"
    );
    const bounded = reviewManifestDefaultName({ label: "a".repeat(10_000) });
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(
      REVIEW_MANIFEST_MAX_FILENAME_BYTES
    );
    expect(bounded).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/);
  });
});
