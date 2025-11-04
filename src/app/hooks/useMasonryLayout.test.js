import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { SortKey } from "../../sorting/sorting";

vi.mock("../../hooks/useChunkedMasonry", () => {
  return {
    __esModule: true,
    default: vi.fn(() => ({
      updateAspectRatio: vi.fn(),
      onItemsChanged: vi.fn(),
      setZoomClass: vi.fn(),
      scheduleLayout: vi.fn(),
    })),
  };
});

vi.mock("../../hooks/ui-perf/useIntersectionObserverRegistry", () => {
  return {
    __esModule: true,
    default: vi.fn(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      refresh: vi.fn(),
      setNearPx: vi.fn(),
    })),
  };
});

import { useMasonryLayout } from "./useMasonryLayout";

const makeVideo = (id, basename, dirname, createdMs) => ({
  id,
  basename,
  dirname,
  createdMs,
});

const sampleVideos = [
  makeVideo("a", "zeta.mp4", "folderA", 1000),
  makeVideo("b", "beta.mp4", "folderB", 3000),
  makeVideo("c", "alpha.mp4", "folderA", 2000),
  makeVideo("d", "gamma.mp4", "folderB", 4000),
  makeVideo("e", "delta.mp4", "folderC", 1500),
];

describe("useMasonryLayout sorting", () => {
  const defaultProps = {
    videos: sampleVideos,
    filteredVideos: sampleVideos,
    sortKey: SortKey.NAME,
    sortDir: "asc",
    groupByFolders: false,
    randomSeed: 1234,
    zoomLevel: 1,
    scrollContainerRef: { current: null },
    gridRef: { current: null },
  };

  it("sorts entire collection by name", () => {
    const { result } = renderHook(() => useMasonryLayout(defaultProps));
    expect(result.current.orderedVideos.map((v) => v.id)).toEqual([
      "c",
      "b",
      "e",
      "d",
      "a",
    ]);
  });

  it("sorts entire collection by created date", () => {
    const { result, rerender } = renderHook(
      (props) => useMasonryLayout(props),
      { initialProps: defaultProps }
    );

    rerender({
      ...defaultProps,
      sortKey: SortKey.CREATED,
      sortDir: "desc",
    });

    expect(result.current.orderedVideos.map((v) => v.id)).toEqual([
      "d",
      "b",
      "c",
      "e",
      "a",
    ]);
  });

  it("groups by folders while sorting by name", () => {
    const { result } = renderHook(() =>
      useMasonryLayout({
        ...defaultProps,
        groupByFolders: true,
      })
    );

    expect(result.current.orderedVideos.map((v) => v.id)).toEqual([
      "c",
      "a",
      "b",
      "d",
      "e",
    ]);
  });
});
