import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import {
  VERSION_FILTERS,
  buildGenerationVersionIndex,
  distinctGenerationKeys,
  matchesVersionFilter,
  normalizeVersionFilter,
} from "./generationVersions";
import { useFilterState } from "../hooks/useFilterState";

const KEY_A = `gk1-${"a".repeat(32)}`;
const KEY_B = `gk1-${"b".repeat(32)}`;

const clip = (id, fingerprint, key, width, height) => ({
  id,
  fingerprint,
  generationKey: key,
  generationKeyChecked: Boolean(key),
  dimensions: width ? { width, height } : null,
  tags: [],
});

// A draft with two re-renders (one copied into a second folder), a
// same-resolution sweep, and a clip that was never keyed.
const videos = [
  clip("draft", "fd", KEY_A, 640, 360),
  clip("final", "ff", KEY_A, 1280, 720),
  clip("final-copy", "ff", KEY_A, 1280, 720),
  clip("sweep-1", "s1", KEY_B, 640, 360),
  clip("sweep-2", "s2", KEY_B, 640, 360),
  clip("unkeyed", "fu", null, 320, 240),
  clip("unmeasured", "fx", KEY_A, null, null),
];

describe("generation version index", () => {
  it("counts content once and marks lower-resolution versions superseded", () => {
    const index = buildGenerationVersionIndex(videos);
    expect(index.get("draft")).toEqual({ generationKey: KEY_A, versionCount: 3, superseded: true });
    expect(index.get("final")).toEqual({ generationKey: KEY_A, versionCount: 3, superseded: false });
    expect(index.get("final-copy").superseded).toBe(false);
    expect(index.get("sweep-1")).toEqual({ generationKey: KEY_B, versionCount: 2, superseded: false });
    // Unknown dimensions sort as zero pixels.
    expect(index.get("unmeasured").superseded).toBe(true);
    expect(index.has("unkeyed")).toBe(false);
  });

  it("lets the library summary add versions outside the collection", () => {
    const index = buildGenerationVersionIndex([clip("sweep-1", "s1", KEY_B, 640, 360)], {
      [KEY_B]: { versionCount: 4, maxPixels: 1920 * 1080 },
    });
    expect(index.get("sweep-1")).toEqual({ generationKey: KEY_B, versionCount: 4, superseded: true });
  });

  it("partitions every collection into superseded and best", () => {
    const index = buildGenerationVersionIndex(videos);
    const superseded = videos.filter((video) =>
      matchesVersionFilter(index.get(video.id), VERSION_FILTERS.SUPERSEDED)
    );
    const best = videos.filter((video) =>
      matchesVersionFilter(index.get(video.id), VERSION_FILTERS.BEST)
    );
    expect(superseded.length + best.length).toBe(videos.length);
    expect(superseded.map((video) => video.id)).toEqual(["draft", "unmeasured"]);
    expect(best.map((video) => video.id)).toContain("unkeyed");
    expect(videos.every((video) => matchesVersionFilter(index.get(video.id), "any"))).toBe(true);
  });

  it("normalizes filter values and lists distinct keys", () => {
    expect(normalizeVersionFilter("best")).toBe("best");
    expect(normalizeVersionFilter("nonsense")).toBe("any");
    expect(distinctGenerationKeys(videos)).toEqual([KEY_A, KEY_B]);
  });
});

describe("useFilterState version filter", () => {
  const render = () =>
    renderHook(() =>
      useFilterState({
        videos,
        filtersButtonRef: createRef(),
        filtersPopoverRef: createRef(),
        generationVersionIndex: buildGenerationVersionIndex(videos),
      })
    );

  it("filters by version and counts as an active filter", () => {
    const { result } = render();
    act(() => result.current.updateFilters({ versionFilter: "superseded" }));
    expect(result.current.filteredVideos.map((video) => video.id)).toEqual(["draft", "unmeasured"]);
    expect(result.current.filtersActiveCount).toBe(1);
    act(() => result.current.clearVersionFilter());
    expect(result.current.filteredVideos).toBe(videos);
    expect(result.current.filtersActiveCount).toBe(0);
  });

  it("combines best version with a maximum resolution into the re-render worklist", () => {
    const { result } = render();
    act(() => result.current.updateFilters({ versionFilter: "best", maxMegapixels: 0.5 }));
    // The draft has a re-render, so it drops out; the same-resolution sweep
    // and the unkeyed clip have none.
    expect(result.current.filteredVideos.map((video) => video.id)).toEqual([
      "sweep-1",
      "sweep-2",
      "unkeyed",
    ]);
  });

  it("ignores an unknown version filter value", () => {
    const { result } = render();
    act(() => result.current.updateFilters({ versionFilter: "everything" }));
    expect(result.current.filters.versionFilter).toBe("any");
  });
});
