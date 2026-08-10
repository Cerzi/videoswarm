import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { useFilterState } from "./useFilterState";

const videos = [
  { id: "new", tags: ["wan"], rating: null, reviewState: "unreviewed" },
  { id: "done", tags: ["wan"], rating: 4, reviewState: "reviewed" },
  { id: "pick", tags: ["hunyuan"], rating: 5, reviewState: "pick" },
  { id: "reject", tags: [], rating: 1, reviewState: "reject" },
];

describe("useFilterState review filters", () => {
  const renderFilters = () =>
    renderHook(() =>
      useFilterState({
        videos,
        filtersButtonRef: createRef(),
        filtersPopoverRef: createRef(),
      })
    );

  it("treats picks and rejects as reviewed while preserving exact states", () => {
    const { result } = renderFilters();

    act(() => result.current.updateFilters({ reviewFilter: "reviewed" }));
    expect(result.current.filteredVideos.map((video) => video.id)).toEqual([
      "done",
      "pick",
      "reject",
    ]);

    act(() => result.current.updateFilters({ reviewFilter: "pick" }));
    expect(result.current.filteredVideos.map((video) => video.id)).toEqual([
      "pick",
    ]);
    expect(result.current.filtersActiveCount).toBe(1);
  });

  it("combines review state with tags and ratings", () => {
    const { result } = renderFilters();
    act(() =>
      result.current.updateFilters({
        includeTags: ["wan"],
        minRating: 3,
        reviewFilter: "reviewed",
      })
    );
    expect(result.current.filteredVideos.map((video) => video.id)).toEqual([
      "done",
    ]);
    expect(result.current.filtersActiveCount).toBe(3);
  });
});

describe("useFilterState resolution filters", () => {
  const clips = [
    { id: "draft", dimensions: { width: 640, height: 360 }, tags: [], reviewState: "unreviewed" },
    { id: "mid", dimensions: { width: 1280, height: 720 }, tags: [], reviewState: "unreviewed" },
    { id: "full", dimensions: { width: 1920, height: 1080 }, tags: [], reviewState: "unreviewed" },
    { id: "unmeasured", tags: [], reviewState: "unreviewed" },
  ];
  const renderFilters = () =>
    renderHook(() =>
      useFilterState({
        videos: clips,
        filtersButtonRef: createRef(),
        filtersPopoverRef: createRef(),
      })
    );

  it("finds the low-resolution clips with an upper bound", () => {
    const { result } = renderFilters();
    act(() => result.current.updateFilters({ maxMegapixels: 1 }));
    // 640x360 is 0.23 MP, 1280x720 is 0.92 MP, 1920x1080 is 2.07 MP.
    expect(result.current.filteredVideos.map((video) => video.id)).toEqual([
      "draft",
      "mid",
    ]);
    expect(result.current.filtersActiveCount).toBe(1);
  });

  it("finds already-promoted clips with a lower bound", () => {
    const { result } = renderFilters();
    act(() => result.current.updateFilters({ minMegapixels: 1 }));
    expect(result.current.filteredVideos.map((video) => video.id)).toEqual([
      "full",
    ]);
  });

  it("hides clips whose dimensions have never been read", () => {
    const { result } = renderFilters();
    // Including an unmeasured clip would assert a size nobody has measured.
    act(() => result.current.updateFilters({ maxMegapixels: 2 }));
    expect(result.current.filteredVideos.map((video) => video.id)).not.toContain(
      "unmeasured"
    );
  });

  it("returns every clip when no bound is set", () => {
    const { result } = renderFilters();
    expect(result.current.filteredVideos).toHaveLength(4);
    expect(result.current.filtersActiveCount).toBe(0);
  });

  it("counts both bounds and combines them into a band", () => {
    const { result } = renderFilters();
    act(() =>
      result.current.updateFilters({ minMegapixels: 0.5, maxMegapixels: 1 })
    );
    expect(result.current.filteredVideos.map((video) => video.id)).toEqual([
      "mid",
    ]);
    expect(result.current.filtersActiveCount).toBe(2);
  });
});

describe("useFilterState tag match mode", () => {
  const clips = [
    { id: "both", tags: ["wan", "hero"], reviewState: "unreviewed" },
    { id: "wan-only", tags: ["wan"], reviewState: "unreviewed" },
    { id: "hero-only", tags: ["hero"], reviewState: "unreviewed" },
    { id: "neither", tags: ["other"], reviewState: "unreviewed" },
  ];
  const renderFilters = () =>
    renderHook(() =>
      useFilterState({
        videos: clips,
        filtersButtonRef: createRef(),
        filtersPopoverRef: createRef(),
      })
    );

  it("intersects included tags by default", () => {
    const { result } = renderFilters();
    act(() => result.current.updateFilters({ includeTags: ["wan", "hero"] }));
    expect(result.current.filteredVideos.map((video) => video.id)).toEqual([
      "both",
    ]);
  });

  it("unions included tags in any mode", () => {
    const { result } = renderFilters();
    act(() =>
      result.current.updateFilters({
        includeTags: ["wan", "hero"],
        includeTagsMode: "any",
      })
    );
    expect(result.current.filteredVideos.map((video) => video.id)).toEqual([
      "both",
      "wan-only",
      "hero-only",
    ]);
  });

  it("keeps exclusion meaning none of these in either mode", () => {
    const { result } = renderFilters();
    act(() =>
      result.current.updateFilters({
        includeTags: ["wan", "hero"],
        includeTagsMode: "any",
        excludeTags: ["hero"],
      })
    );
    // Union of the includes, minus anything carrying an excluded tag.
    expect(result.current.filteredVideos.map((video) => video.id)).toEqual([
      "wan-only",
    ]);
  });

  it("does not count the mode itself as an active filter", () => {
    const { result } = renderFilters();
    act(() => result.current.updateFilters({ includeTagsMode: "any" }));
    expect(result.current.filtersActiveCount).toBe(0);
    expect(result.current.filteredVideos).toHaveLength(4);
  });
});
