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

  it("uses normalized cross-platform keys", () => {
    expect(makeFolderViewKey(" C:\\root ", "a\\b/../c", "invalid")).toBe(
      JSON.stringify(["C:\\root", "a/c", "all-descendants"])
    );
  });
});
