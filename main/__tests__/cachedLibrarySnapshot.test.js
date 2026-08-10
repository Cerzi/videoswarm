import path from "path";
import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  createCachedLibraryResponse,
  createTaggedLibraryFiles,
} = require("../cached-library-snapshot");

describe("cached library snapshot", () => {
  it("maps catalog rows into a compact renderer cache shape", () => {
    const rootPath = path.resolve("/library");
    const response = createCachedLibraryResponse(
      {
        root: { rootPath, refreshState: "idle" },
        directories: [{ relativePath: "", present: true }],
        records: [
          {
            instanceId: 11,
            absolutePath: path.join(rootPath, "batch", "clip.mp4"),
            size: 2048,
            mtimeMs: 2_000,
            createdMs: 1_000,
            fingerprint: "fp-11",
            tags: ["pick"],
            rating: 4,
            reviewState: "pick",
            hasAudio: true,
            dimensions: { width: 640, height: 360 },
          },
        ],
      },
      rootPath,
      "scan-11",
      { generation: 9 }
    );

    expect(response).toMatchObject({
      cached: true,
      refreshing: true,
      scanId: "scan-11",
      totalRecordCount: 1,
      root: { rootPath, refreshState: "refreshing" },
      files: [
        {
          instanceId: 11,
          name: "clip.mp4",
          relativePath: path.join("batch", "clip.mp4"),
          dirname: "batch",
          fingerprint: "fp-11",
          tags: ["pick"],
          rating: 4,
          reviewState: "pick",
          hasAudio: true,
          dimensions: {
            width: 640,
            height: 360,
            aspectRatio: 640 / 360,
          },
        },
      ],
    });
    expect(response.files[0]).not.toHaveProperty("fullPath");
    expect(response.files[0]).not.toHaveProperty("basename");
    expect(response.files[0]).not.toHaveProperty("dateCreated");
    expect(response.files[0]).not.toHaveProperty("aspectRatio");
    expect(response.files[0].sourceUrl).toBe(
      "videoswarm-media://instance/11?v=2048-2000&g=9"
    );
  });

  it("returns no preview for an unindexed root", () => {
    expect(createCachedLibraryResponse(null, "/missing", "scan-x")).toBeNull();
  });

  it("preserves the full indexed count on a bounded preview", () => {
    const rootPath = path.resolve("/bounded-library");
    const response = createCachedLibraryResponse(
      {
        root: { rootPath },
        directories: [],
        totalRecordCount: 6_000,
        records: [
          {
            instanceId: 1,
            absolutePath: path.join(rootPath, "clip.mp4"),
            size: 1,
            mtimeMs: 1,
          },
        ],
      },
      rootPath,
      "scan-bounded"
    );

    expect(response.files).toHaveLength(1);
    expect(response.totalRecordCount).toBe(6_000);
  });

  it("preserves indexed order because renderer view sorting owns presentation", () => {
    const rootPath = path.resolve("/ordered-library");
    const response = createCachedLibraryResponse(
      {
        root: { rootPath },
        directories: [],
        records: [
          {
            instanceId: 1,
            absolutePath: path.join(rootPath, "z-last.mp4"),
            size: 1,
            mtimeMs: 1,
          },
          {
            instanceId: 2,
            absolutePath: path.join(rootPath, "a-first.mp4"),
            size: 1,
            mtimeMs: 1,
          },
        ],
      },
      rootPath,
      "scan-order"
    );

    expect(response.files.map((file) => file.name)).toEqual([
      "z-last.mp4",
      "a-first.mp4",
    ]);
  });

  it("preserves a 6,000-clip snapshot without imposing a renderer cache cap", () => {
    const rootPath = path.resolve("/large-library");
    const records = Array.from({ length: 6_000 }, (_, index) => ({
      instanceId: index + 1,
      absolutePath: path.join(
        rootPath,
        `run-${Math.floor(index / 100)}`,
        `clip-${String(index).padStart(4, "0")}.mp4`
      ),
      size: 1_024 + index,
      mtimeMs: 10_000 + index,
      createdMs: 5_000 + index,
      fingerprint: `fp-${index}`,
      tags: [],
      rating: null,
      reviewState: "unreviewed",
      dimensions: { width: 512, height: 288 },
    }));

    const response = createCachedLibraryResponse(
      {
        root: { rootPath },
        directories: [],
        records,
      },
      rootPath,
      "scan-6000"
    );

    expect(response.files).toHaveLength(6_000);
    expect(new Set(response.files.map((file) => file.id)).size).toBe(6_000);
    expect(response.files[0]).toMatchObject({
      instanceId: 1,
      dirname: "run-0",
      dimensions: {
        width: 512,
        height: 288,
        aspectRatio: 512 / 288,
      },
    });
    expect(response.files[0]).not.toHaveProperty("tags");
    expect(response.files[0]).not.toHaveProperty("rating");
    expect(response.files[0]).not.toHaveProperty("reviewState");
  });
});

// A tag view is the one collection whose rows arrive from several roots at
// once, and the one that shipped adopting the raw catalog projection. These
// pin the shape it must hand the renderer, because a record the grid cannot
// key or play looks exactly like an empty library.
describe("tagged library files", () => {
  const rootA = path.resolve("/library-a");
  const rootB = path.resolve("/library-b");

  const taggedRecords = [
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
      rating: 4,
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
  ];

  it("gives the grid the same record shape a folder view does", () => {
    const [file] = createTaggedLibraryFiles(taggedRecords, { generation: 9 });

    expect(file).toMatchObject({
      id: path.join(rootA, "2026-08-09", "clip.mp4"),
      instanceId: 11,
      name: "clip.mp4",
      relativePath: path.join("2026-08-09", "clip.mp4"),
      dirname: "2026-08-09",
      isElectronFile: true,
      fingerprint: "fp-11",
      tags: ["keeper"],
      rating: 4,
      reviewState: "pick",
      hasAudio: true,
    });
    // Without these the collection loads and then renders nothing: no key to
    // identify a clip by, and no URL to play it from.
    expect(file.sourceUrl).toBe("videoswarm-media://instance/11?v=2048-2000&g=9");
    expect(file.dateModified).toBeInstanceOf(Date);
    expect(file.dateModified.getTime()).toBe(2_000);
  });

  it("resolves each record against its own root", () => {
    const files = createTaggedLibraryFiles(taggedRecords, { generation: 9 });

    expect(files.map((file) => file.rootPath)).toEqual([rootA, rootB]);
    // Same relative path under two roots stays two distinct clips.
    expect(files[0].id).not.toBe(files[1].id);
    expect(files[0].relativePath).toBe(files[1].relativePath);
  });

  it("drops a record that names no root rather than resolving it somewhere", () => {
    expect(
      createTaggedLibraryFiles([{ ...taggedRecords[0], rootPath: undefined }])
    ).toEqual([]);
    expect(createTaggedLibraryFiles(null)).toEqual([]);
  });
});
