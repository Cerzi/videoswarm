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
  const renderFilters = (companions = [{ id: "c1", entries: companionEntries }]) =>
    renderHook(() =>
      useFilterState({
        videos: clips,
        filtersButtonRef: createRef(),
        filtersPopoverRef: createRef(),
        companions,
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
    act(() => result.current.updateFilters({ companionFilters: { "c1/polish": "sent" } }));
    expect(ids(result)).toEqual(["polishing", "taken-back", "unknown"]);
    act(() =>
      result.current.updateFilters({
        companionFilters: { "c1/polish": "not-sent", enlarge: "not-sent", bogus: "x" },
      })
    );
    // A plain action id is the first companion's.
    expect(result.current.filters.companionFilters).toEqual({
      "c1/polish": "not-sent",
      "c1/enlarge": "not-sent",
    });
    expect(ids(result)).toEqual(["unknown"]);
  });

  it("asks each companion about its own actions", () => {
    const editor = new Map([[4, { actions: { cut: stage("done") } }]]);
    const { result } = renderFilters([
      { id: "c1", entries: companionEntries },
      { id: "c2", entries: editor },
    ]);
    act(() => result.current.updateFilters({ companionFilters: { "c2/cut": "not-sent" } }));
    expect(ids(result)).toEqual(["fresh", "polishing", "taken-back"]);
    act(() => result.current.updateFilters({ companionFilters: {}, companionHideSent: true }));
    expect(ids(result)).toEqual(["fresh"]);
  });

  it("ignores companion filters while there is no companion", () => {
    const { result } = renderFilters([]);
    act(() => result.current.updateFilters({ companionHideSent: true }));
    expect(ids(result)).toEqual(["fresh", "polishing", "taken-back", "unknown"]);
  });
});

describe("useFilterState prompt search", () => {
  const clips = [
    { id: "beach", promptKey: "pk-beach", reviewState: "unreviewed" },
    { id: "studio", promptKey: "pk-studio", reviewState: "unreviewed" },
    { id: "plain", reviewState: "unreviewed" },
  ];
  afterEach(() => {
    vi.useRealTimers();
    delete window.electronAPI;
  });

  it("keeps clips whose prompts match, once main answers", async () => {
    vi.useFakeTimers();
    const search = vi.fn(async (keys, query) => ({
      success: true,
      matches: query === "beach" ? ["pk-beach"] : [],
      unread: 0,
    }));
    window.electronAPI = { prompts: { search } };
    const { result } = renderHook(() =>
      useFilterState({ videos: clips, filtersButtonRef: createRef(), filtersPopoverRef: createRef() })
    );
    act(() => result.current.updateFilters({ promptQuery: "beach" }));
    // Until the answer, the grid is left as it was.
    expect(result.current.filteredVideos.map((video) => video.id)).toEqual(["beach", "studio", "plain"]);
    expect(result.current.promptSearch.pending).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(400);
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    expect(search).toHaveBeenCalledWith(["pk-beach", "pk-studio"], "beach");
    expect(result.current.filteredVideos.map((video) => video.id)).toEqual(["beach"]);
    expect(result.current.filtersActiveCount).toBe(1);

    act(() => result.current.updateFilters({ promptQuery: "" }));
    expect(result.current.filteredVideos).toHaveLength(3);
  });
});

describe("useFilterState might be", () => {
  const clips = [
    { id: "a", instanceId: 1, fingerprint: "fp-a", promptKey: "pk-a", tags: [], reviewState: "unreviewed" },
    { id: "b", instanceId: 2, fingerprint: "fp-b", promptKey: "pk-b", tags: [], reviewState: "unreviewed" },
    { id: "c", instanceId: 3, fingerprint: "fp-c", promptKey: "pk-c", tags: [], reviewState: "unreviewed" },
    { id: "plain", instanceId: 4, fingerprint: "fp-d", tags: [], reviewState: "unreviewed" },
  ];
  const tagHierarchy = buildTagHierarchy([
    { name: "dance", parent: null },
    { name: "bellydance", parent: "dance" },
  ]);
  afterEach(async () => {
    vi.useRealTimers();
    const { resetTurnedDownTags } = await import("../tags/likelyTags");
    resetTurnedDownTags();
    delete window.electronAPI;
  });
  const settle = async () => {
    await act(async () => {
      vi.advanceTimersByTime(400);
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
  };

  it("shows only the rows main says might be the tag, and drops them once tagged or turned down", async () => {
    vi.useFakeTimers();
    const mightBe = vi.fn(async () => ({ success: true, usable: true, matches: [1, 2, 3] }));
    const dismiss = vi.fn(async () => ({ success: true, dismissed: 1 }));
    window.electronAPI = { tagSuggestions: { mightBe, dismiss } };
    let videos = clips;
    const { result, rerender } = renderHook(() =>
      useFilterState({
        videos,
        filtersButtonRef: createRef(),
        filtersPopoverRef: createRef(),
        tagHierarchy,
      })
    );
    act(() => result.current.updateFilters({ mightBe: " dance " }));
    // Nothing is known to be the tag before main answers.
    expect(result.current.filteredVideos).toEqual([]);
    expect(result.current.mightBe.pending).toBe(true);
    await settle();
    // Only clips with a prompt key are asked about.
    expect(mightBe).toHaveBeenCalledWith([1, 2, 3], "dance");
    expect(result.current.filteredVideos.map((video) => video.id)).toEqual(["a", "b", "c"]);
    expect(result.current.filtersActiveCount).toBe(1);

    // Tagged with a tag under it: done with.
    videos = clips.map((video) => (video.id === "a" ? { ...video, tags: ["bellydance"] } : video));
    rerender();
    // The collection changed, so main is asked again; the old answer stays meanwhile.
    expect(result.current.filteredVideos.map((video) => video.id)).toEqual(["b", "c"]);

    const { turnDownLikelyTag } = await import("../tags/likelyTags");
    await act(async () => {
      await turnDownLikelyTag(["fp-b"], "Dance");
    });
    expect(dismiss).toHaveBeenCalledWith(["fp-b"], "Dance");
    expect(result.current.filteredVideos.map((video) => video.id)).toEqual(["c"]);

    act(() => result.current.updateFilters({ mightBe: "" }));
    expect(result.current.filteredVideos).toHaveLength(4);
  });

  it("says when the tag cannot be suggested", async () => {
    vi.useFakeTimers();
    window.electronAPI = {
      tagSuggestions: { mightBe: vi.fn(async () => ({ success: true, usable: false, matches: [] })) },
    };
    const { result } = renderHook(() =>
      useFilterState({ videos: clips, filtersButtonRef: createRef(), filtersPopoverRef: createRef() })
    );
    act(() => result.current.updateFilters({ mightBe: "keeper" }));
    await settle();
    expect(result.current.mightBe.usable).toBe(false);
    expect(result.current.filteredVideos).toEqual([]);
  });
});

describe("useFilterState frame rate and workflow filters", () => {
  const clips = [
    { id: "raw", fingerprint: "fr", dimensions: { width: 640, height: 360, frameRate: 16 }, tags: [] },
    { id: "film", fingerprint: "ff", dimensions: { width: 640, height: 360, frameRate: 23.976 }, tags: [] },
    { id: "smooth", fingerprint: "fs", dimensions: { width: 640, height: 360, frameRate: 60 }, tags: [] },
    { id: "untimed", fingerprint: "fu", dimensions: { width: 640, height: 360 }, tags: [] },
  ];
  const renderFilters = (props = {}) =>
    renderHook((extra) =>
      useFilterState({
        videos: clips,
        filtersButtonRef: createRef(),
        filtersPopoverRef: createRef(),
        ...props,
        ...extra,
      })
    );

  afterEach(() => {
    vi.useRealTimers();
    delete window.electronAPI;
  });

  it("bounds the frame rate to the nearest frame and hides clips not yet timed", () => {
    const { result } = renderFilters();
    act(() => result.current.updateFilters({ minFrameRate: 24 }));
    expect(result.current.filteredVideos.map((video) => video.id)).toEqual(["film", "smooth"]);
    act(() => result.current.updateFilters({ minFrameRate: null, maxFrameRate: 24 }));
    expect(result.current.filteredVideos.map((video) => video.id)).toEqual(["raw", "film"]);
    expect(result.current.filtersActiveCount).toBe(1);
  });

  it("asks main which clips' workflows match and keeps only those", async () => {
    vi.useFakeTimers();
    const match = vi.fn(async () => ({ success: true, matches: ["fs"], unread: 1 }));
    window.electronAPI = { workflow: { match } };
    const { result, rerender } = renderFilters();
    act(() => result.current.updateFilters({ workflowExclude: "Turbo, fast", minSteps: 12 }));
    // Until main answers, nothing is hidden.
    expect(result.current.filteredVideos).toHaveLength(4);
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(match).toHaveBeenCalledWith({
      fingerprints: ["ff", "fr", "fs", "fu"],
      include: [],
      exclude: ["turbo", "fast"],
      minSteps: 12,
      maxSteps: null,
    });
    expect(result.current.filteredVideos.map((video) => video.id)).toEqual(["smooth"]);
    expect(result.current.workflowSearch).toMatchObject({ pending: false, unread: 1 });
    expect(result.current.filtersActiveCount).toBe(2);

    // Background reading moves on: ask again.
    rerender({ workflowRefreshKey: "1:40" });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(match).toHaveBeenCalledTimes(2);
  });
});
