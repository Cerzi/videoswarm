import {
  FolderViewStateCache,
  MAX_RESTORED_SELECTION_IDS,
  makeFolderViewKey,
} from "./folderViewState";

describe("FolderViewStateCache", () => {
  it("restores serializable view state without sharing mutable values", () => {
    const cache = new FolderViewStateCache();
    const selectedIds = new Set(["one", "two"]);
    cache.set("/root", "runs/a", "current-folder", {
      scrollTop: 412,
      selectedIds,
      sortKey: "created",
      sortDir: "desc",
      groupByFolders: true,
      randomSeed: 42,
      filters: { includeTags: [" cat "], reviewFilter: "pick" },
    });

    selectedIds.clear();
    const restored = cache.get("/root", "runs/a", "current-folder");
    expect(restored).toMatchObject({
      scrollTop: 412,
      selectedIds: ["one", "two"],
      sortKey: "created",
      sortDir: "desc",
      groupByFolders: true,
      randomSeed: 42,
      filters: { includeTags: ["cat"], reviewFilter: "pick" },
    });
    restored.selectedIds.push("mutated");
    expect(cache.get("/root", "runs/a", "current-folder").selectedIds).toEqual([
      "one",
      "two",
    ]);
  });

  it("bounds entries, locations, and retained selection IDs", () => {
    const cache = new FolderViewStateCache(2);
    const hugeSelection = Array.from(
      { length: MAX_RESTORED_SELECTION_IDS + 20 },
      (_, index) => `video-${index}`
    );
    cache.set("/one", "", "all-descendants", { selectedIds: hugeSelection });
    cache.set("/two", "", "all-descendants", {});
    cache.set("/three", "", "all-descendants", {});

    expect(cache.get("/one", "", "all-descendants")).toBeNull();
    expect(cache.views.size).toBe(2);
    expect(cache.locations.size).toBe(2);
    expect(cache.get("/three", "", "all-descendants").selectedIds).toHaveLength(0);

    cache.set("/four", "", "all-descendants", { selectedIds: hugeSelection });
    expect(cache.get("/four", "", "all-descendants").selectedIds).toHaveLength(
      MAX_RESTORED_SELECTION_IDS
    );
  });

  it("resets a saved scroll offset without dropping the rest of the snapshot", () => {
    const cache = new FolderViewStateCache();
    cache.set("/root", "runs/a", "current-folder", {
      scrollTop: 412,
      selectedIds: ["one"],
      sortKey: "created",
    });

    expect(cache.resetScroll("/root", "runs/a", "current-folder")).toBe(true);
    expect(cache.get("/root", "runs/a", "current-folder")).toMatchObject({
      scrollTop: 0,
      selectedIds: ["one"],
      sortKey: "created",
    });
    expect(cache.resetScroll("/root", "runs/missing", "current-folder")).toBe(
      false
    );
  });

  it("uses normalized cross-platform keys", () => {
    expect(makeFolderViewKey(" C:\\root ", "a\\b/../c", "invalid")).toBe(
      JSON.stringify(["C:\\root", "a/c", "all-descendants"])
    );
  });

  it("keeps a clip to reveal for one arrival only", () => {
    const cache = new FolderViewStateCache();
    cache.set("/library", "run-a", "current-folder", {
      selectedIds: ["/library/run-a/clip.mp4"],
      revealId: "/library/run-a/clip.mp4",
    });
    expect(cache.get("/library", "run-a", "current-folder").revealId).toBe(
      "/library/run-a/clip.mp4"
    );
    expect(cache.getLocation("/library")).toEqual({
      directory: "run-a",
      scope: "current-folder",
    });

    expect(cache.clearReveal("/library", "run-a", "current-folder")).toBe(true);
    const after = cache.get("/library", "run-a", "current-folder");
    expect(after.revealId).toBeNull();
    expect(after.selectedIds).toEqual(["/library/run-a/clip.mp4"]);
    expect(cache.clearReveal("/library", "run-a", "current-folder")).toBe(false);

    cache.set("/library", "", "all-descendants", { revealId: { not: "an id" } });
    expect(cache.get("/library", "", "all-descendants").revealId).toBeNull();
  });
});

