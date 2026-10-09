import { describe, it, expect } from "vitest";
import {
  SortKey,
  buildComparator,
  groupAndSort,
  buildRandomOrderMap,
} from "../sorting.js";

const makeItem = (id, basename, dirname, createdMs) => ({
  id,
  basename,
  dirname,
  createdMs,
});

describe("sorting module", () => {
  it("sorts by name asc/desc", () => {
    const items = [
      makeItem("1", "file10", "", 0),
      makeItem("2", "file2", "", 0),
      makeItem("3", "file1", "", 0),
    ];
    const asc = buildComparator({ sortKey: SortKey.NAME, sortDir: "asc" });
    const desc = buildComparator({ sortKey: SortKey.NAME, sortDir: "desc" });
    expect(
      groupAndSort(items, { groupByFolders: false, comparator: asc }).map(
        (i) => i.basename
      )
    ).toEqual(["file1", "file2", "file10"]);
    expect(
      groupAndSort(items, { groupByFolders: false, comparator: desc }).map(
        (i) => i.basename
      )
    ).toEqual(["file10", "file2", "file1"]);
  });

  it("sorts decimal numbers correctly when leading digits match", () => {
    // localeCompare+numeric compares digit *groups* as integers, so 0.7 vs 0.64
    // becomes [0,7] vs [0,64] → 7 < 64 → 0.7 sorts before 0.64 (wrong).
    const items = [
      makeItem("1", "video_0.9", "", 0),
      makeItem("2", "video_0.64", "", 0),
      makeItem("3", "video_0.7", "", 0),
      makeItem("4", "video_0.66", "", 0),
      makeItem("5", "video_0.68", "", 0),
      makeItem("6", "video_0.72", "", 0),
      makeItem("7", "video_0.92", "", 0),
      makeItem("8", "video_0.94", "", 0),
      makeItem("9", "video_0.96", "", 0),
    ];
    const asc = buildComparator({ sortKey: SortKey.NAME, sortDir: "asc" });
    const sorted = groupAndSort(items, { groupByFolders: false, comparator: asc }).map(
      (i) => i.basename
    );
    // Correct numeric order for decimals with matching leading digits:
    expect(sorted).toEqual([
      "video_0.64",
      "video_0.66",
      "video_0.68",
      "video_0.7",
      "video_0.72",
      "video_0.9",
      "video_0.92",
      "video_0.94",
      "video_0.96",
    ]);
  });

  it("sorts multiple numbers correctly (multi-key alphanumeric)", () => {
    // Names split into alternating text and number segments compared pairwise.
    const items = [
      makeItem("1", "clip_1.2_pass3", "", 0),
      makeItem("2", "clip_1.10_pass1", "", 0),
      makeItem("3", "clip_1.2_pass1", "", 0),
      makeItem("4", "clip_1.2_pass10", "", 0),
      makeItem("5", "clip_A10_B1", "", 0),
      makeItem("6", "clip_A2_B5", "", 0),
      makeItem("7", "clip_A1_B20", "", 0),
      makeItem("8", "step_3_pass12", "", 0),
      makeItem("9", "step_3_pass3", "", 0),
      makeItem("10", "step_12_pass1", "", 0),
    ];
    const asc = buildComparator({ sortKey: SortKey.NAME, sortDir: "asc" });
    const sorted = groupAndSort(items, { groupByFolders: false, comparator: asc }).map(
      (i) => i.basename
    );
    // "1.10" reads as the decimal 1.1, so it sorts before 1.2.
    expect(sorted).toEqual([
      "clip_1.10_pass1",
      "clip_1.2_pass1",
      "clip_1.2_pass3",
      "clip_1.2_pass10",
      "clip_A1_B20",
      "clip_A2_B5",
      "clip_A10_B1",
      "step_3_pass3",
      "step_3_pass12",
      "step_12_pass1",
    ]);
  });

  it("sorts names when only one side starts with a number", () => {
    const items = [
      makeItem("1", "clip2", "", 0),
      makeItem("2", "2clip", "", 0),
      makeItem("3", "clip10", "", 0),
      makeItem("4", "10clip", "", 0),
    ];
    const asc = buildComparator({ sortKey: SortKey.NAME, sortDir: "asc" });
    const sorted = groupAndSort(items, { groupByFolders: false, comparator: asc }).map(
      (i) => i.basename
    );
    expect(sorted).toEqual(["2clip", "10clip", "clip2", "clip10"]);
  });

  it("orders long digit runs exactly instead of rounding them", () => {
    // Both seeds round to the same double, so a float comparison ties them.
    const items = [
      makeItem("1", "seed_18446744073709551615", "", 0),
      makeItem("2", "seed_18446744073709551614", "", 0),
      makeItem("3", "seed_0.30000000000000001", "", 0),
      makeItem("4", "seed_0.3", "", 0),
      makeItem("5", "seed_007", "", 0),
      makeItem("6", "seed_8", "", 0),
    ];
    const asc = buildComparator({ sortKey: SortKey.NAME, sortDir: "asc" });
    const desc = buildComparator({ sortKey: SortKey.NAME, sortDir: "desc" });
    const order = [
      "seed_0.3",
      "seed_0.30000000000000001",
      "seed_007",
      "seed_8",
      "seed_18446744073709551614",
      "seed_18446744073709551615",
    ];
    expect(
      groupAndSort(items, { groupByFolders: false, comparator: asc }).map((i) => i.basename)
    ).toEqual(order);
    expect(
      groupAndSort(items, { groupByFolders: false, comparator: desc }).map((i) => i.basename)
    ).toEqual([...order].reverse());
  });

  it("sorts by created time asc/desc", () => {
    const items = [
      makeItem("a", "a", "", 300),
      makeItem("b", "b", "", 100),
      makeItem("c", "c", "", 200),
    ];
    const asc = buildComparator({ sortKey: SortKey.CREATED, sortDir: "asc" });
    const desc = buildComparator({ sortKey: SortKey.CREATED, sortDir: "desc" });
    expect(
      groupAndSort(items, { groupByFolders: false, comparator: asc }).map(
        (i) => i.id
      )
    ).toEqual(["b", "c", "a"]);
    expect(
      groupAndSort(items, { groupByFolders: false, comparator: desc }).map(
        (i) => i.id
      )
    ).toEqual(["a", "c", "b"]);
  });

  it("sorts by rating with newest clips first inside each rating", () => {
    const items = [
      { ...makeItem("old-five", "old-five", "", 100), rating: 5 },
      { ...makeItem("new-four", "new-four", "", 500), rating: 4 },
      { ...makeItem("new-five", "new-five", "", 400), rating: 5 },
      { ...makeItem("unrated", "unrated", "", 900), rating: null },
      { ...makeItem("same-rating-b", "b", "", 300), rating: 5 },
      { ...makeItem("same-rating-a", "a", "", 300), rating: 5 },
    ];
    const desc = buildComparator({ sortKey: SortKey.RATING, sortDir: "desc" });
    expect(
      groupAndSort(items, { groupByFolders: false, comparator: desc }).map(
        (i) => i.id
      )
    ).toEqual([
      "new-five",
      "same-rating-a",
      "same-rating-b",
      "old-five",
      "new-four",
      "unrated",
    ]);

    const asc = buildComparator({ sortKey: SortKey.RATING, sortDir: "asc" });
    expect(
      groupAndSort(items, { groupByFolders: false, comparator: asc }).map(
        (i) => i.id
      )
    ).toEqual([
      "unrated",
      "new-four",
      "new-five",
      "same-rating-a",
      "same-rating-b",
      "old-five",
    ]);
  });

  it("random order is stable for same seed", () => {
    const items = [
      makeItem("1", "1", "", 0),
      makeItem("2", "2", "", 0),
      makeItem("3", "3", "", 0),
      makeItem("4", "4", "", 0),
    ];
    const paths = items.map((i) => i.id);
    const seed = 42;
    const map1 = buildRandomOrderMap(paths, seed);
    const comp1 = buildComparator({
      sortKey: SortKey.RANDOM,
      sortDir: "asc",
      randomOrderMap: map1,
    });
    const map2 = buildRandomOrderMap(paths, seed);
    const comp2 = buildComparator({
      sortKey: SortKey.RANDOM,
      sortDir: "asc",
      randomOrderMap: map2,
    });
    const order1 = groupAndSort(items, { groupByFolders: false, comparator: comp1 }).map(
      (i) => i.id
    );
    const order2 = groupAndSort(items, { groupByFolders: false, comparator: comp2 }).map(
      (i) => i.id
    );
    expect(order1).toEqual(order2);
  });

  it("respects sortDir when using random order", () => {
    const items = ["1", "2", "3", "4"].map((n) => makeItem(n, n, "", 0));
    const seed = 7;
    const map = buildRandomOrderMap(items.map((i) => i.id), seed);
    const asc = buildComparator({
      sortKey: SortKey.RANDOM,
      sortDir: "asc",
      randomOrderMap: map,
    });
    const desc = buildComparator({
      sortKey: SortKey.RANDOM,
      sortDir: "desc",
      randomOrderMap: map,
    });
    const ascOrder = groupAndSort(items, {
      groupByFolders: false,
      comparator: asc,
    }).map((i) => i.id);
    const descOrder = groupAndSort(items, {
      groupByFolders: false,
      comparator: desc,
    }).map((i) => i.id);
    expect(descOrder).toEqual([...ascOrder].reverse());
  });

  it("different seeds produce different random order", () => {
    const items = ["1", "2", "3", "4"].map((n) => makeItem(n, n, "", 0));
    const map1 = buildRandomOrderMap(items.map((i) => i.id), 1);
    const map2 = buildRandomOrderMap(items.map((i) => i.id), 2);
    const comp1 = buildComparator({
      sortKey: SortKey.RANDOM,
      sortDir: "asc",
      randomOrderMap: map1,
    });
    const comp2 = buildComparator({
      sortKey: SortKey.RANDOM,
      sortDir: "asc",
      randomOrderMap: map2,
    });
    const order1 = groupAndSort(items, {
      groupByFolders: false,
      comparator: comp1,
    }).map((i) => i.id);
    const order2 = groupAndSort(items, {
      groupByFolders: false,
      comparator: comp2,
    }).map((i) => i.id);
    expect(order1).not.toEqual(order2);
  });

  it("groups by folder then sorts", () => {
    const items = [
      makeItem("b2", "b2", "b", 0),
      makeItem("a1", "a1", "a", 0),
      makeItem("a2", "a2", "a", 0),
      makeItem("b1", "b1", "b", 0),
    ];
    const comp = buildComparator({ sortKey: SortKey.NAME, sortDir: "asc" });
    const result = groupAndSort(items, { groupByFolders: true, comparator: comp });
    expect(result.map((i) => i.id)).toEqual(["a1", "a2", "b1", "b2"]);
  });

  // A library-wide tag view is the only collection that mixes roots, and two
  // roots dated the same day is the ordinary case, not a contrived one.
  it("keeps same-named folders from different roots apart", () => {
    const items = [
      { ...makeItem("b-late", "z", "2026-08-09", 0), rootPath: "/roots/b" },
      { ...makeItem("a-early", "a", "2026-08-09", 0), rootPath: "/roots/a" },
      { ...makeItem("b-early", "a", "2026-08-09", 0), rootPath: "/roots/b" },
      { ...makeItem("a-late", "z", "2026-08-09", 0), rootPath: "/roots/a" },
    ];
    const comp = buildComparator({ sortKey: SortKey.NAME, sortDir: "asc" });
    const result = groupAndSort(items, { groupByFolders: true, comparator: comp });
    // Interleaving the two roots would mean the grid claimed one folder where
    // there are two.
    expect(result.map((i) => i.id)).toEqual([
      "a-early",
      "a-late",
      "b-early",
      "b-late",
    ]);
  });

  it("places root folder group first", () => {
    const items = [
      makeItem("root2", "b", "", 0),
      makeItem("a1", "a1", "a", 0),
      makeItem("root1", "a", "", 0),
      makeItem("b1", "b1", "b", 0),
    ];
    const comp = buildComparator({ sortKey: SortKey.NAME, sortDir: "asc" });
    const result = groupAndSort(items, { groupByFolders: true, comparator: comp });
    expect(result.map((i) => i.id)).toEqual(["root1", "root2", "a1", "b1"]);
  });

  it("handles missing created timestamps", () => {
    const items = [
      makeItem("1", "a", "", undefined),
      makeItem("2", "b", "", 100),
    ];
    const comp = buildComparator({ sortKey: SortKey.CREATED, sortDir: "asc" });
    const result = groupAndSort(items, { groupByFolders: false, comparator: comp });
    expect(result.map((i) => i.id)).toEqual(["1", "2"]);
  });

  it("orderedVideos updates when state changes", () => {
    const items = [
      makeItem("1", "a", "a", 100),
      makeItem("2", "c", "b", 150),
      makeItem("3", "b", "b", 50),
    ];
    const compName = buildComparator({ sortKey: SortKey.NAME, sortDir: "asc" });
    const withGrouping = groupAndSort(items, {
      groupByFolders: true,
      comparator: compName,
    });
    const compCreated = buildComparator({
      sortKey: SortKey.CREATED,
      sortDir: "desc",
    });
    const withoutGrouping = groupAndSort(items, {
      groupByFolders: false,
      comparator: compCreated,
    });
    expect(withGrouping).not.toEqual(withoutGrouping);
  });
});

describe("resolution sort", () => {
  const clip = (name, width, height) => ({
    id: name,
    name,
    ...(width ? { dimensions: { width, height } } : {}),
  });

  it("orders by pixel count and breaks ties by name", () => {
    const videos = [
      clip("big.mp4", 1920, 1080),
      clip("small.mp4", 640, 360),
      clip("mid-b.mp4", 1280, 720),
      clip("mid-a.mp4", 1280, 720),
    ];
    const ascending = [...videos].sort(
      buildComparator({ sortKey: SortKey.RESOLUTION, sortDir: "asc" })
    );
    expect(ascending.map((video) => video.name)).toEqual([
      "small.mp4",
      "mid-a.mp4",
      "mid-b.mp4",
      "big.mp4",
    ]);
  });

  it("keeps unmeasured clips together at the low end", () => {
    const videos = [
      clip("measured.mp4", 1920, 1080),
      clip("unknown.mp4"),
      clip("draft.mp4", 640, 360),
    ];
    const ascending = [...videos].sort(
      buildComparator({ sortKey: SortKey.RESOLUTION, sortDir: "asc" })
    );
    // Unknown counts as zero pixels, so it never interleaves with real values.
    expect(ascending[0].name).toBe("unknown.mp4");
    expect(ascending.at(-1).name).toBe("measured.mp4");
  });
});
