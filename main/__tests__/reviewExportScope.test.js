import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  ACCEPTED_COPY_MAX_MEDIA,
  ACCEPTED_COPY_MAX_PATH_BYTES,
  assertReviewExportCoverage,
  normalizeReviewExportDirectory,
  normalizeReviewExportRelativePath,
  normalizeReviewExportScope,
} = require("../review-export-scope");

const completeRoot = Object.freeze({
  recursive: true,
  refreshState: "idle",
  lastScanStartedAt: 100,
  lastScanCompletedAt: 101,
});

describe("review export scope", () => {
  it("exports stable Copy Accepted bounds for database integration", () => {
    expect(ACCEPTED_COPY_MAX_MEDIA).toBe(20_000);
    expect(ACCEPTED_COPY_MAX_PATH_BYTES).toBe(16 * 1024 * 1024);
  });

  it("normalizes portable directory paths and rejects traversal", () => {
    expect(normalizeReviewExportDirectory("batch\\one/./clips")).toBe(
      "batch/one/clips"
    );
    expect(normalizeReviewExportDirectory("")).toBe("");
    expect(() => normalizeReviewExportDirectory("../outside")).toThrow(
      expect.objectContaining({ code: "INVALID_REVIEW_EXPORT_DIRECTORY" })
    );
    expect(() => normalizeReviewExportDirectory("/absolute")).toThrow(
      expect.objectContaining({ code: "INVALID_REVIEW_EXPORT_DIRECTORY" })
    );
    expect(() => normalizeReviewExportDirectory("C:/absolute")).toThrow(
      expect.objectContaining({ code: "INVALID_REVIEW_EXPORT_DIRECTORY" })
    );
    expect(() => normalizeReviewExportRelativePath("./")).toThrow(
      expect.objectContaining({ code: "INVALID_REVIEW_EXPORT_RECORD" })
    );
  });

  it("accepts only the three catalog scope modes", () => {
    for (const scope of [
      "all-descendants",
      "current-folder",
      "current-subtree",
    ]) {
      expect(normalizeReviewExportScope(scope)).toBe(scope);
    }
    expect(() => normalizeReviewExportScope("everything")).toThrow(
      expect.objectContaining({ code: "INVALID_REVIEW_EXPORT_SCOPE" })
    );
  });

  it("requires a completed authoritative index for the requested coverage", () => {
    expect(
      assertReviewExportCoverage(completeRoot, "batch", "current-subtree")
    ).toBe(true);
    expect(() => assertReviewExportCoverage(
      { ...completeRoot, refreshState: "scanning" },
      "",
      "all-descendants"
    )).toThrow(expect.objectContaining({ code: "REVIEW_EXPORT_INDEX_NOT_READY" }));
    expect(() => assertReviewExportCoverage(
      { ...completeRoot, lastScanCompletedAt: null },
      "",
      "all-descendants"
    )).toThrow(expect.objectContaining({ code: "REVIEW_EXPORT_INCOMPLETE_INDEX" }));
    expect(() => assertReviewExportCoverage(
      { ...completeRoot, lastScanStartedAt: 102 },
      "",
      "all-descendants"
    )).toThrow(expect.objectContaining({ code: "REVIEW_EXPORT_INCOMPLETE_INDEX" }));
  });

  it("allows only the indexed root folder for a non-recursive catalog", () => {
    const root = { ...completeRoot, recursive: false };
    expect(assertReviewExportCoverage(root, "", "current-folder")).toBe(true);
    expect(() => assertReviewExportCoverage(
      root,
      "batch",
      "current-folder"
    )).toThrow(expect.objectContaining({ code: "REVIEW_EXPORT_INCOMPLETE_INDEX" }));
    expect(() => assertReviewExportCoverage(
      root,
      "",
      "all-descendants"
    )).toThrow(expect.objectContaining({ code: "REVIEW_EXPORT_INCOMPLETE_INDEX" }));
  });
});
