import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { SortKey } from "../../../sorting/sorting.js";
import { useMasonryLayout } from "../useMasonryLayout.js";

vi.mock("../../hooks/useChunkedMasonry", () => ({
  __esModule: true,
  default: vi.fn(() => ({
    updateAspectRatio: vi.fn(),
    onItemsChanged: vi.fn(),
    setZoomClass: vi.fn(),
    scheduleLayout: vi.fn(),
  })),
}));

vi.mock("../../hooks/ui-perf/useIntersectionObserverRegistry", () => ({
  __esModule: true,
  default: vi.fn(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    refresh: vi.fn(),
    setNearPx: vi.fn(),
    isNear: () => false,
  })),
}));

describe("useMasonryLayout sorting", () => {
  beforeAll(() => {
    class IO {
      constructor() {}
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    }
    global.IntersectionObserver = IO;
  });

  afterAll(() => {
    delete global.IntersectionObserver;
  });

  const baseVideos = Array.from({ length: 10 }).map((_, idx) => ({
    id: `id-${idx}`,
    basename: `video-${idx}`,
    dirname: idx < 5 ? "A" : "B",
    createdMs: idx * 10,
  }));

  let scrollRef;
  let gridRef;

  beforeEach(() => {
    scrollRef = { current: null };
    gridRef = { current: null };
  });

  it("returns videos sorted by created desc across entire list", () => {
    const { result, rerender } = renderHook(
      ({ sortKey, sortDir }) =>
        useMasonryLayout({
          videos: baseVideos,
          filteredVideos: baseVideos,
          sortKey,
          sortDir,
          groupByFolders: false,
          randomSeed: null,
          zoomLevel: 1,
          scrollContainerRef: scrollRef,
          gridRef,
        }),
      {
        initialProps: { sortKey: SortKey.NAME, sortDir: "asc" },
      }
    );

    expect(result.current.orderedVideos.map((v) => v.id)).toEqual(
      baseVideos.map((v) => v.id)
    );

    rerender({ sortKey: SortKey.CREATED, sortDir: "desc" });

    expect(result.current.orderedVideos.map((v) => v.id)).toEqual(
      [...baseVideos]
        .sort((a, b) => b.createdMs - a.createdMs)
        .map((v) => v.id)
    );
  });

  it("shuffles entire list when random sort is used", () => {
    const { result } = renderHook(() =>
      useMasonryLayout({
        videos: baseVideos,
        filteredVideos: baseVideos,
        sortKey: SortKey.RANDOM,
        sortDir: "asc",
        groupByFolders: false,
        randomSeed: 123,
        zoomLevel: 1,
        scrollContainerRef: scrollRef,
        gridRef,
      })
    );

    const ids = result.current.orderedVideos.map((v) => v.id);
    expect(ids).toHaveLength(baseVideos.length);
    expect(new Set(ids).size).toBe(baseVideos.length);
    expect(ids).not.toEqual(baseVideos.map((v) => v.id));
  });
});
