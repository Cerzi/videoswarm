import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import {
  VERSION_FILTERS,
  buildGenerationVersionIndex,
  distinctGenerationKeys,
  matchesVersionFilter,
  normalizeVersionFilter,
  orderVersions,
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
    expect(index.get("draft")).toEqual({
      generationKey: KEY_A,
      versionCount: 3,
      superseded: true,
      supersedes: false,
      best: false,
    });
    expect(index.get("final")).toEqual({
      generationKey: KEY_A,
      versionCount: 3,
      superseded: false,
      supersedes: true,
      best: true,
    });
    expect(index.get("final-copy").superseded).toBe(false);
    expect(index.get("sweep-1")).toEqual({
      generationKey: KEY_B,
      versionCount: 2,
      superseded: false,
      supersedes: false,
      best: true,
    });
    // Unknown dimensions sort as zero pixels.
    expect(index.get("unmeasured").superseded).toBe(true);
    expect(index.has("unkeyed")).toBe(false);
  });

  it("lets the library summary add versions outside the collection", () => {
    const index = buildGenerationVersionIndex([clip("sweep-1", "s1", KEY_B, 640, 360)], {
      [KEY_B]: { versionCount: 4, maxPixels: 1920 * 1080 },
    });
    expect(index.get("sweep-1")).toEqual({
      generationKey: KEY_B,
      versionCount: 4,
      superseded: true,
      supersedes: false,
      best: false,
    });
    // And a smaller version elsewhere makes this one a re-render of it.
    const upscaled = buildGenerationVersionIndex([clip("final", "ff", KEY_A, 1280, 720)], {
      [KEY_A]: { versionCount: 2, maxPixels: 1280 * 720, minPixels: 640 * 360 },
    });
    expect(upscaled.get("final")).toMatchObject({ superseded: false, supersedes: true });
  });

  it("lets ratings overrule size for the best version", () => {
    const rated = (id, fp, w, h, rating) => ({ ...clip(id, fp, KEY_A, w, h), rating });
    // The smaller version rated higher is best, though a larger one exists.
    let index = buildGenerationVersionIndex([rated("draft", "fd", 640, 360, 5), rated("up", "fu", 1280, 720, 3)]);
    expect(index.get("draft")).toMatchObject({ best: true, superseded: true });
    expect(index.get("up").best).toBe(false);
    expect(matchesVersionFilter(index.get("draft"), VERSION_FILTERS.BEST)).toBe(true);
    expect(matchesVersionFilter(index.get("draft"), VERSION_FILTERS.SUPERSEDED)).toBe(true);
    // An unrated version competes on size: a new upscale of a rated draft.
    index = buildGenerationVersionIndex([rated("draft", "fd", 640, 360, 5), rated("up", "fu", 1280, 720, null)]);
    expect(index.get("up").best).toBe(true);
    expect(index.get("draft").best).toBe(false);
    // Equal ratings: the larger wins.
    index = buildGenerationVersionIndex([rated("draft", "fd", 640, 360, 4), rated("up", "fu", 1280, 720, 4)]);
    expect(index.get("up").best).toBe(true);
    // The library summary's top rating counts too.
    index = buildGenerationVersionIndex([rated("up", "fu", 1280, 720, 3)], {
      [KEY_A]: { versionCount: 2, maxPixels: 1280 * 720, maxRating: 5, bestPixels: 640 * 360, unratedMaxPixels: 0 },
    });
    expect(index.get("up").best).toBe(false);
  });

  it("orders versions best first: top rated or unrated by size, then the rest by rating", () => {
    const facts = (v) => ({ rating: v.r, pixels: v.p, durationMs: 0, mtimeMs: 0, key: v.k });
    const ordered = orderVersions(
      [
        { k: "a", r: 3, p: 4 },
        { k: "b", r: 5, p: 1 },
        { k: "c", r: null, p: 2 },
        { k: "d", r: 4, p: 9 },
      ],
      facts
    );
    expect(ordered.map((v) => v.k)).toEqual(["c", "b", "d", "a"]);
  });

  it("finds re-renders and upscales: versions with a smaller version", () => {
    const index = buildGenerationVersionIndex(videos);
    const found = videos.filter((video) =>
      matchesVersionFilter(index.get(video.id), VERSION_FILTERS.SUPERSEDES)
    );
    // Same-size sweeps and unmeasured clips are not re-renders of anything.
    expect(found.map((video) => video.id)).toEqual(["final", "final-copy"]);
    expect(normalizeVersionFilter("supersedes")).toBe("supersedes");
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
