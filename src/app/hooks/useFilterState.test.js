import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { useFilterState } from "./useFilterState";
import { buildTagHierarchy } from "../filters/tagHierarchy";

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

  it("shows one summary chip per bound, each clearing only its own", () => {
    const { result } = renderFilters();
    expect(result.current.resolutionSummary).toEqual([]);
    act(() =>
      result.current.updateFilters({ minMegapixels: 0.5, maxMegapixels: 2 })
    );
    expect(result.current.resolutionSummary.map((chip) => chip.label)).toEqual([
      "≥ 0.5 MP",
      "≤ 2 MP",
    ]);
    act(() => result.current.resolutionSummary[0].onClear());
    expect(result.current.filters.minMegapixels).toBeNull();
    expect(result.current.filters.maxMegapixels).toBe(2);
    expect(result.current.resolutionSummary.map((chip) => chip.label)).toEqual(["≤ 2 MP"]);
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

describe("useFilterState tag hierarchy", () => {
  const clips = [
    { id: "belly", tags: ["bellydance"], reviewState: "unreviewed" },
    { id: "tap-outdoor", tags: ["tap", "outdoor"], reviewState: "unreviewed" },
    { id: "plain-dance", tags: ["Dance"], reviewState: "unreviewed" },
    { id: "outdoor", tags: ["outdoor"], reviewState: "unreviewed" },
  ];
  const tagHierarchy = buildTagHierarchy([
    { name: "dance", parent: null },
    { name: "bellydance", parent: "dance" },
    { name: "tap", parent: "dance" },
  ]);
  const renderFilters = () =>
    renderHook(() =>
      useFilterState({
        videos: clips,
        filtersButtonRef: createRef(),
        filtersPopoverRef: createRef(),
        tagHierarchy,
      })
    );
  const ids = (result) => result.current.filteredVideos.map((video) => video.id);

  it("includes and excludes a tag together with the tags under it", () => {
    const { result } = renderFilters();
    act(() => result.current.updateFilters({ includeTags: ["dance"] }));
    expect(ids(result)).toEqual(["belly", "tap-outdoor", "plain-dance"]);

    act(() => result.current.updateFilters({ includeTags: ["dance", "outdoor"] }));
    expect(ids(result)).toEqual(["tap-outdoor"]);

    act(() => result.current.updateFilters({ includeTags: [], excludeTags: ["dance"] }));
    expect(ids(result)).toEqual(["outdoor"]);

    // A child tag still means only itself.
    act(() => result.current.updateFilters({ excludeTags: [], includeTags: ["tap"] }));
    expect(ids(result)).toEqual(["tap-outdoor"]);
  });
});


describe("useFilterState companion filters", () => {
  const clips = [
    { id: "fresh", instanceId: 1, reviewState: "pick" },
    { id: "polishing", instanceId: 2, reviewState: "pick" },
    { id: "taken-back", instanceId: 3, reviewState: "pick" },
    { id: "unknown", instanceId: 4, reviewState: "pick" },
  ];
  const stage = (phase) => ({ phase, why: "" });
  const companionEntries = new Map([
    [1, { actions: { polish: stage("not-sent"), enlarge: stage("n/a") } }],
    [2, { actions: { polish: stage("under-way"), enlarge: stage("not-sent") } }],
    [3, { actions: { polish: stage("stopped"), enlarge: stage("not-sent") } }],
  ]);
  const renderFilters = (entries = companionEntries) =>
    renderHook(() =>
      useFilterState({
        videos: clips,
        filtersButtonRef: createRef(),
        filtersPopoverRef: createRef(),
        companionEntries: entries,
      })
    );
  const ids = (result) => result.current.filteredVideos.map((video) => video.id);

  it("drops clips already sent for any action, and keeps unanswered ones", () => {
    const { result } = renderFilters();
    act(() => result.current.updateFilters({ companionHideSent: true }));
    expect(ids(result)).toEqual(["fresh", "unknown"]);
    expect(result.current.filtersActiveCount).toBe(1);
  });

  it("filters by an action's phase and combines with other filters", () => {
    const { result } = renderFilters();
    act(() => result.current.updateFilters({ companionFilters: { polish: "sent" } }));
    expect(ids(result)).toEqual(["polishing", "taken-back", "unknown"]);
    act(() =>
      result.current.updateFilters({
        companionFilters: { polish: "not-sent", enlarge: "not-sent", bogus: "x" },
      })
    );
    expect(result.current.filters.companionFilters).toEqual({
      polish: "not-sent",
      enlarge: "not-sent",
    });
    expect(ids(result)).toEqual(["unknown"]);
  });

  it("ignores companion filters while there is no companion", () => {
    const { result } = renderFilters(null);
    act(() => result.current.updateFilters({ companionHideSent: true }));
    expect(ids(result)).toEqual(["fresh", "polishing", "taken-back", "unknown"]);
  });
});
