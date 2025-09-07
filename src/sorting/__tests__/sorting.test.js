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
