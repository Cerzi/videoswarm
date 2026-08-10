import path from "path";
import { createRequire } from "module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { buildTaggedSnapshotResponse } = require("../library-tag-view");

const rootA = path.resolve("/roots/a");
const rootB = path.resolve("/roots/b");

// Exactly what getTaggedLibrarySnapshot returns: the catalog projection, which
// is not the shape the renderer can use.
function catalogSnapshot() {
  return {
    tags: ["keeper"],
    matchMode: "all",
    truncated: false,
    recordLimit: 20_000,
    rootPaths: [rootA, rootB],
    records: [
      {
        instanceId: 11,
        rootPath: rootA,
        relativePath: path.join("2026-08-09", "clip.mp4"),
        absolutePath: path.join(rootA, "2026-08-09", "clip.mp4"),
        size: 2048,
        mtimeMs: 2_000,
        createdMs: 1_000,
        fingerprint: "fp-11",
        tags: ["keeper"],
        rating: 3,
        reviewState: "pick",
        hasAudio: true,
        dimensions: { width: 640, height: 360 },
      },
      {
        instanceId: 12,
        rootPath: rootB,
        relativePath: path.join("2026-08-09", "clip.mp4"),
        absolutePath: path.join(rootB, "2026-08-09", "clip.mp4"),
        size: 4096,
        mtimeMs: 3_000,
        createdMs: 3_000,
        fingerprint: "fp-12",
        tags: ["keeper"],
      },
    ],
  };
}

function storeReturning(snapshot) {
  return { getTaggedLibrarySnapshot: vi.fn(() => snapshot) };
}

describe("library tag view response", () => {
  it("hands the renderer records it can key, play and label", () => {
    const store = storeReturning(catalogSnapshot());

    const response = buildTaggedSnapshotResponse(store, {
      tagNames: ["keeper"],
      matchMode: "all",
      generation: 7,
    });

    // The regression this exists for: returning the catalog projection meant
    // every one of these was undefined, and a library full of clips rendered
    // as an empty grid.
    for (const record of response.records) {
      expect(typeof record.id).toBe("string");
      expect(record.id.length).toBeGreaterThan(0);
      expect(record.name).toMatch(/\.mp4$/);
      expect(record.sourceUrl).toMatch(/^videoswarm-media:\/\/instance\/\d+\?/);
      expect(record.dateModified).toBeInstanceOf(Date);
      expect(record.isElectronFile).toBe(true);
    }
    expect(response.records).toHaveLength(2);
  });

  it("stamps the media url with the profile generation it was read under", () => {
    const store = storeReturning(catalogSnapshot());

    const response = buildTaggedSnapshotResponse(store, {
      tagNames: ["keeper"],
      matchMode: "all",
      generation: 7,
    });

    expect(response.records[0].sourceUrl).toBe(
      "videoswarm-media://instance/11?v=2048-2000&g=7"
    );
  });

  it("keeps each record on its own root so cross-root paths stay distinct", () => {
    const store = storeReturning(catalogSnapshot());

    const response = buildTaggedSnapshotResponse(store, {
      tagNames: ["keeper"],
      matchMode: "all",
      generation: 7,
    });

    const [first, second] = response.records;
    expect(first.rootPath).toBe(rootA);
    expect(second.rootPath).toBe(rootB);
    expect(first.relativePath).toBe(second.relativePath);
    expect(first.id).not.toBe(second.id);
  });

  it("passes the search through and reports its bounds", () => {
    const snapshot = catalogSnapshot();
    snapshot.truncated = true;
    const store = storeReturning(snapshot);
    const assertActive = () => {};

    const response = buildTaggedSnapshotResponse(store, {
      tagNames: ["keeper", "sleep"],
      matchMode: "any",
      generation: 2,
      assertActive,
    });

    expect(store.getTaggedLibrarySnapshot).toHaveBeenCalledWith({
      tagNames: ["keeper", "sleep"],
      matchMode: "any",
      assertActive,
    });
    // A clipped library has to say so; silently short results read as a wrong
    // answer rather than a bounded one.
    expect(response.truncated).toBe(true);
    expect(response.recordLimit).toBe(20_000);
    expect(response.rootPaths).toEqual([rootA, rootB]);
  });

  it("returns an empty collection rather than throwing when nothing matches", () => {
    const store = storeReturning({
      tags: ["nobody-uses-this"],
      matchMode: "all",
      truncated: false,
      recordLimit: 20_000,
      rootPaths: [],
      records: [],
    });

    const response = buildTaggedSnapshotResponse(store, {
      tagNames: ["nobody-uses-this"],
      matchMode: "all",
      generation: 1,
    });

    expect(response.records).toEqual([]);
    expect(response.truncated).toBe(false);
  });
});
