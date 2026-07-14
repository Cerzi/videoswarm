import path from "path";
import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  createCachedLibraryResponse,
} = require("../cached-library-snapshot");

describe("cached library snapshot", () => {
  it("maps serializable catalog rows into the normal renderer file shape", () => {
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
          aspectRatio: 640 / 360,
          metadata: { sizeFormatted: "2 KB" },
        },
      ],
    });
    expect(response.files[0].sourceUrl).toBe(
      "videoswarm-media://instance/11?v=2048-2000&g=9"
    );
  });

  it("returns no preview for an unindexed root", () => {
    expect(createCachedLibraryResponse(null, "/missing", "scan-x")).toBeNull();
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
      aspectRatio: 512 / 288,
    });
  });
});
