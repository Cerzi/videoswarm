import { describe, expect, it } from "vitest";
import {
  FolderScope,
  buildBreadcrumbs,
  buildFolderTree,
  filterVideosByFolderScope,
  findFolderNode,
  flattenExpandedFolderTree,
  getSiblingFolder,
  getSiblingNavigation,
  isDirectoryInSubtree,
  isVideoReviewed,
  normalizeRelativePath,
} from "./folderModel";

const video = (id, dirname, options = {}) => ({
  id,
  dirname,
  relativePath: dirname ? `${dirname}/${id}.mp4` : `${id}.mp4`,
  rating: null,
  ...options,
});

describe("folder path and scope helpers", () => {
  it("normalizes POSIX and Windows relative paths without escaping the root", () => {
    expect(normalizeRelativePath(" ./runs\\seed-01//clips/../final/ ")).toBe(
      "runs/seed-01/final"
    );
    expect(normalizeRelativePath("../../runs\\seed-02")).toBe("runs/seed-02");
    expect(normalizeRelativePath(".")).toBe("");
    expect(normalizeRelativePath(null)).toBe("");
  });

  it("recognizes exact directories and nested subtrees", () => {
    expect(isDirectoryInSubtree("run-a/seed-2", "run-a")).toBe(true);
    expect(isDirectoryInSubtree("run-a", "run-a")).toBe(true);
    expect(isDirectoryInSubtree("run-ab", "run-a")).toBe(false);
    expect(isDirectoryInSubtree("anything/deep", "")).toBe(true);
  });

  it("applies all-descendant, current-folder, and current-subtree scope", () => {
    const videos = [
      video("root", ""),
      video("a", "run-a"),
      video("nested", "run-a\\seed-1"),
      video("b", "run-b"),
    ];

    expect(
      filterVideosByFolderScope(videos, {
        scope: FolderScope.ALL_DESCENDANTS,
        currentDirectory: "run-a",
      }).map((item) => item.id)
    ).toEqual(["root", "a", "nested", "b"]);
    expect(
      filterVideosByFolderScope(videos, {
        scope: FolderScope.CURRENT_FOLDER,
        currentDirectory: "run-a/",
      }).map((item) => item.id)
    ).toEqual(["a"]);
    expect(
      filterVideosByFolderScope(videos, {
        scope: FolderScope.CURRENT_SUBTREE,
        currentDirectory: "run-a",
      }).map((item) => item.id)
    ).toEqual(["a", "nested"]);
    expect(
      filterVideosByFolderScope(videos, {
        scope: FolderScope.CURRENT_FOLDER,
        currentDirectory: "",
      }).map((item) => item.id)
    ).toEqual(["root"]);
  });

  it("supports explicit and rating-derived review state", () => {
    expect(isVideoReviewed({ reviewed: true })).toBe(true);
    expect(isVideoReviewed({ reviewed: false, rating: 5 })).toBe(false);
    expect(isVideoReviewed({ reviewState: "reject" })).toBe(true);
    expect(isVideoReviewed({ reviewState: "pending", rating: 5 })).toBe(false);
    expect(isVideoReviewed({ rating: 0 })).toBe(true);
    expect(isVideoReviewed({ rating: null })).toBe(false);
  });
});

describe("buildFolderTree", () => {
  const summaries = [
    { relativePath: "", name: "outputs" },
    { relativePath: "run-a", name: "run-a" },
    { relativePath: "run-a/seed-1", name: "seed-1" },
    { relativePath: "run-b", name: "run-b" },
    { relativePath: "empty", name: "empty" },
  ];
  const videos = [
    video("root", ""),
    video("a", "run-a", { rating: 4 }),
    video("nested", "run-a/seed-1", { reviewed: true }),
    video("b", "run-b"),
  ];
  const matches = [videos[1], videos[3]];

  it("keeps indexed empty folders and derives direct/subtree video, match, and review counts", () => {
    const tree = buildFolderTree({
      directorySummaries: summaries,
      videos,
      matchingVideos: matches,
      rootName: "fallback",
    });

    expect(tree).toMatchObject({
      path: "",
      name: "outputs",
      directVideoCount: 1,
      videoCount: 4,
      directMatchingCount: 0,
      matchingCount: 2,
      directReviewedCount: 0,
      reviewedCount: 2,
    });
    expect(tree.children.map((node) => node.path)).toEqual([
      "empty",
      "run-a",
      "run-b",
    ]);

    expect(findFolderNode(tree, "run-a")).toMatchObject({
      directVideoCount: 1,
      videoCount: 2,
      directMatchingCount: 1,
      matchingCount: 1,
      directReviewedCount: 1,
      reviewedCount: 2,
    });
    expect(findFolderNode(tree, "run-a\\seed-1")).toMatchObject({
      directVideoCount: 1,
      videoCount: 1,
      directMatchingCount: 0,
      matchingCount: 0,
      reviewedCount: 1,
    });
    expect(findFolderNode(tree, "run-b")).toMatchObject({
      videoCount: 1,
      matchingCount: 1,
      reviewedCount: 0,
    });
    expect(findFolderNode(tree, "empty")).toMatchObject({
      directVideoCount: 0,
      videoCount: 0,
      matchingCount: 0,
      reviewedCount: 0,
    });
  });

  it("creates missing ancestors for live videos not present in catalog summaries", () => {
    const tree = buildFolderTree({
      videos: [video("clip", "new-run/seed/deep")],
      matchingVideos: [],
      rootName: "outputs",
    });

    expect(findFolderNode(tree, "new-run")).toBeTruthy();
    expect(findFolderNode(tree, "new-run/seed")).toBeTruthy();
    expect(findFolderNode(tree, "new-run/seed/deep")).toMatchObject({
      directVideoCount: 1,
      matchingCount: 0,
    });
    expect(tree.videoCount).toBe(1);
  });

  it("uses durable summary counts when no live collection has been supplied", () => {
    const tree = buildFolderTree({
      directorySummaries: [
        {
          relativePath: "",
          name: "outputs",
          directPresentCount: 1,
          presentCount: 5,
          directReviewedCount: 1,
          reviewedCount: 3,
        },
      ],
    });

    expect(tree).toMatchObject({
      directVideoCount: 1,
      videoCount: 5,
      directMatchingCount: 0,
      matchingCount: 5,
      directReviewedCount: 1,
      reviewedCount: 3,
    });
  });
});

describe("folder breadcrumbs and expansion", () => {
  it("builds clickable POSIX breadcrumb segments with full paths", () => {
    expect(buildBreadcrumbs("/mnt/models/outputs", "run-a/seed-02")).toEqual([
      {
        key: "root",
        label: "outputs",
        relativePath: "",
        fullPath: "/mnt/models/outputs",
        current: false,
      },
      {
        key: "run-a",
        label: "run-a",
        relativePath: "run-a",
        fullPath: "/mnt/models/outputs/run-a",
        current: false,
      },
      {
        key: "run-a/seed-02",
        label: "seed-02",
        relativePath: "run-a/seed-02",
        fullPath: "/mnt/models/outputs/run-a/seed-02",
        current: true,
      },
    ]);
  });

  it("preserves Windows separators in breadcrumb full paths", () => {
    const crumbs = buildBreadcrumbs(
      "D:\\wan\\outputs\\",
      "run-a\\seed-01",
      { rootLabel: "Wan outputs" }
    );

    expect(crumbs.map((crumb) => crumb.label)).toEqual([
      "Wan outputs",
      "run-a",
      "seed-01",
    ]);
    expect(crumbs.at(-1).fullPath).toBe(
      "D:\\wan\\outputs\\run-a\\seed-01"
    );
  });

  it("flattens only branches explicitly expanded by the caller", () => {
    const tree = buildFolderTree({
      videos: [
        video("a", "run-a/seed-1"),
        video("b", "run-b/deep"),
      ],
    });

    expect(
      flattenExpandedFolderTree(tree, new Set([""])).map(({ node }) => node.path)
    ).toEqual(["", "run-a", "run-b"]);
    expect(
      flattenExpandedFolderTree(tree, new Set(["", "run-a"])).map(
        ({ node }) => node.path
      )
    ).toEqual(["", "run-a", "run-a/seed-1", "run-b"]);
  });
});

describe("filtered sibling navigation", () => {
  const videos = [
    video("a", "a"),
    video("b-hidden", "b"),
    video("c", "c"),
    video("d-nested", "d/deep"),
  ];
  const tree = buildFolderTree({
    directorySummaries: [
      { relativePath: "" },
      { relativePath: "a" },
      { relativePath: "b" },
      { relativePath: "c" },
      { relativePath: "d" },
      { relativePath: "d/deep" },
    ],
    videos,
    matchingVideos: [videos[0], videos[2], videos[3]],
  });

  it("wraps and skips siblings with no direct filtered matches", () => {
    expect(
      getSiblingFolder(tree, "a", {
        direction: "next",
        scope: FolderScope.CURRENT_FOLDER,
      })?.path
    ).toBe("c");
    expect(
      getSiblingFolder(tree, "a", {
        direction: "previous",
        scope: FolderScope.CURRENT_FOLDER,
      })?.path
    ).toBe("c");
    expect(
      getSiblingFolder(tree, "c", {
        direction: "next",
        scope: FolderScope.CURRENT_FOLDER,
      })?.path
    ).toBe("a");
  });

  it("uses subtree match counts for current-subtree navigation", () => {
    const navigation = getSiblingNavigation(
      tree,
      "c",
      FolderScope.CURRENT_SUBTREE
    );
    expect(navigation.previous?.path).toBe("a");
    expect(navigation.next?.path).toBe("d");
  });

  it("disables sibling navigation for flattened all-descendants scope", () => {
    expect(
      getSiblingNavigation(tree, "a", FolderScope.ALL_DESCENDANTS)
    ).toEqual({ previous: null, next: null });
  });

  it("can stop at collection edges when wrapping is disabled", () => {
    expect(
      getSiblingFolder(tree, "a", {
        direction: "previous",
        scope: FolderScope.CURRENT_FOLDER,
        wrap: false,
      })
    ).toBeNull();
  });
});
