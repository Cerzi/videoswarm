export const FolderScope = Object.freeze({
  ALL_DESCENDANTS: "all-descendants",
  CURRENT_FOLDER: "current-folder",
  CURRENT_SUBTREE: "current-subtree",
});

const VALID_SCOPES = new Set(Object.values(FolderScope));

const asCount = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
};

export function normalizeRelativePath(value) {
  if (typeof value !== "string") return "";

  const segments = value
    .trim()
    .replace(/\\/g, "/")
    .split("/");
  const normalized = [];

  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }

  return normalized.join("/");
}

export const normalizeDirectoryPath = normalizeRelativePath;

export function getParentDirectory(value) {
  const normalized = normalizeRelativePath(value);
  const separator = normalized.lastIndexOf("/");
  return separator === -1 ? "" : normalized.slice(0, separator);
}

export function getDirectoryName(value, fallback = "") {
  const normalized = normalizeRelativePath(value);
  if (!normalized) return fallback;
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function getVideoDirectory(video) {
  if (typeof video?.dirname === "string") {
    return normalizeRelativePath(video.dirname);
  }
  if (typeof video?.relativePath === "string") {
    return getParentDirectory(video.relativePath);
  }
  return "";
}

export function normalizeFolderScope(value) {
  return VALID_SCOPES.has(value) ? value : FolderScope.ALL_DESCENDANTS;
}

export function isDirectoryInSubtree(directoryPath, subtreePath) {
  const directory = normalizeRelativePath(directoryPath);
  const subtree = normalizeRelativePath(subtreePath);
  return !subtree || directory === subtree || directory.startsWith(`${subtree}/`);
}

export function filterVideosByFolderScope(
  videos,
  { scope = FolderScope.ALL_DESCENDANTS, currentDirectory = "" } = {}
) {
  const source = Array.isArray(videos) ? videos : [];
  const normalizedScope = normalizeFolderScope(scope);
  const directory = normalizeRelativePath(currentDirectory);

  if (normalizedScope === FolderScope.ALL_DESCENDANTS) {
    return source;
  }

  if (normalizedScope === FolderScope.CURRENT_FOLDER) {
    return source.filter((video) => getVideoDirectory(video) === directory);
  }

  return source.filter((video) =>
    isDirectoryInSubtree(getVideoDirectory(video), directory)
  );
}

export function isVideoReviewed(video) {
  if (typeof video?.reviewed === "boolean") return video.reviewed;

  const state = String(video?.reviewState || video?.reviewStatus || "")
    .trim()
    .toLowerCase();
  if (["pick", "picked", "reject", "rejected", "reviewed", "accepted"].includes(state)) {
    return true;
  }
  if (["pending", "unreviewed"].includes(state)) return false;

  return typeof video?.rating === "number" && Number.isFinite(video.rating);
}

function makeNode(relativePath, summary = null, rootName = "") {
  const path = normalizeRelativePath(relativePath);
  return {
    path,
    relativePath: path,
    parentPath: path ? getParentDirectory(path) : null,
    name:
      summary?.name ||
      (path ? getDirectoryName(path) : rootName || "Root"),
    children: [],
    directVideoCount: asCount(
      summary?.directPresentCount ?? summary?.directInstanceCount
    ),
    videoCount: asCount(summary?.presentCount ?? summary?.instanceCount),
    directMatchingCount: 0,
    matchingCount: 0,
    directReviewedCount: asCount(summary?.directReviewedCount),
    reviewedCount: asCount(summary?.reviewedCount),
    missingCount: asCount(summary?.missingCount),
  };
}

function ensureNode(nodes, relativePath, summary, rootName) {
  const path = normalizeRelativePath(relativePath);
  if (!nodes.has(path)) {
    nodes.set(path, makeNode(path, summary, rootName));
  } else if (summary) {
    const node = nodes.get(path);
    node.name = summary.name || node.name;
    node.directVideoCount = asCount(
      summary.directPresentCount ?? summary.directInstanceCount
    );
    node.videoCount = asCount(summary.presentCount ?? summary.instanceCount);
    node.directReviewedCount = asCount(summary.directReviewedCount);
    node.reviewedCount = asCount(summary.reviewedCount);
    node.missingCount = asCount(summary.missingCount);
  }

  let ancestor = path;
  while (ancestor) {
    ancestor = getParentDirectory(ancestor);
    if (!nodes.has(ancestor)) {
      nodes.set(ancestor, makeNode(ancestor, null, rootName));
    }
  }
  return nodes.get(path);
}

/**
 * Build a folder hierarchy from the durable directory summaries and current
 * renderer records. Counts are deliberately plain numbers so this model never
 * retains React nodes, media elements, or other heavyweight resources.
 */
export function buildFolderTree({
  directorySummaries = [],
  videos = null,
  matchingVideos = null,
  rootName = "",
  reviewedPredicate = isVideoReviewed,
} = {}) {
  const nodes = new Map();
  ensureNode(nodes, "", null, rootName);

  for (const summary of Array.isArray(directorySummaries)
    ? directorySummaries
    : []) {
    ensureNode(nodes, summary?.relativePath || "", summary, rootName);
  }

  const hasLiveVideos = Array.isArray(videos);
  if (hasLiveVideos) {
    nodes.forEach((node) => {
      node.directVideoCount = 0;
      node.directReviewedCount = 0;
    });
    for (const video of videos) {
      const node = ensureNode(nodes, getVideoDirectory(video), null, rootName);
      node.directVideoCount += 1;
      if (reviewedPredicate(video)) node.directReviewedCount += 1;
    }
  }

  const effectiveMatchingVideos = Array.isArray(matchingVideos)
    ? matchingVideos
    : hasLiveVideos
      ? videos
      : null;
  if (effectiveMatchingVideos) {
    nodes.forEach((node) => {
      node.directMatchingCount = 0;
    });
    for (const video of effectiveMatchingVideos) {
      const node = ensureNode(nodes, getVideoDirectory(video), null, rootName);
      node.directMatchingCount += 1;
    }
  }

  nodes.forEach((node) => {
    node.children = [];
  });
  nodes.forEach((node) => {
    if (!node.path) return;
    const parent = ensureNode(nodes, node.parentPath, null, rootName);
    parent.children.push(node);
  });

  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });
  nodes.forEach((node) => {
    node.children.sort((left, right) => collator.compare(left.name, right.name));
  });

  const aggregate = (node) => {
    let videoCount = node.directVideoCount;
    let matchingCount = effectiveMatchingVideos
      ? node.directMatchingCount
      : node.directVideoCount;
    let reviewedCount = node.directReviewedCount;

    node.children.forEach((child) => {
      aggregate(child);
      videoCount += child.videoCount;
      matchingCount += child.matchingCount;
      reviewedCount += child.reviewedCount;
    });

    // When no live collection is supplied, retain aggregate catalog counts in
    // case a caller supplied only a root summary instead of every descendant.
    node.videoCount = hasLiveVideos ? videoCount : Math.max(videoCount, node.videoCount);
    node.reviewedCount = hasLiveVideos
      ? reviewedCount
      : Math.max(reviewedCount, node.reviewedCount);
    node.matchingCount = effectiveMatchingVideos ? matchingCount : node.videoCount;
    return node;
  };

  return aggregate(nodes.get(""));
}

export function findFolderNode(tree, relativePath) {
  const target = normalizeRelativePath(relativePath);
  const roots = Array.isArray(tree) ? tree : tree ? [tree] : [];
  const stack = [...roots];

  while (stack.length) {
    const node = stack.shift();
    if (normalizeRelativePath(node?.path ?? node?.relativePath) === target) {
      return node;
    }
    if (Array.isArray(node?.children)) stack.unshift(...node.children);
  }
  return null;
}

function folderMatchesScope(node, scope) {
  if (!node) return false;
  if (scope === FolderScope.CURRENT_FOLDER) {
    return asCount(node.directMatchingCount) > 0;
  }
  if (scope === FolderScope.CURRENT_SUBTREE) {
    return asCount(node.matchingCount) > 0;
  }
  return false;
}

export function getSiblingFolder(
  tree,
  currentPath,
  { direction = "next", scope = FolderScope.CURRENT_FOLDER, wrap = true } = {}
) {
  const normalizedScope = normalizeFolderScope(scope);
  if (normalizedScope === FolderScope.ALL_DESCENDANTS) return null;

  const current = findFolderNode(tree, currentPath);
  if (!current || current.parentPath == null) return null;
  const parent = findFolderNode(tree, current.parentPath);
  const siblings = Array.isArray(parent?.children) ? parent.children : [];
  const currentIndex = siblings.indexOf(current);
  if (currentIndex === -1 || siblings.length < 2) return null;

  const step = direction === "previous" || direction === -1 ? -1 : 1;
  for (let offset = 1; offset < siblings.length; offset += 1) {
    let candidateIndex = currentIndex + offset * step;
    if (!wrap && (candidateIndex < 0 || candidateIndex >= siblings.length)) {
      break;
    }
    candidateIndex =
      ((candidateIndex % siblings.length) + siblings.length) % siblings.length;
    const candidate = siblings[candidateIndex];
    if (folderMatchesScope(candidate, normalizedScope)) return candidate;
  }
  return null;
}

export function getSiblingNavigation(tree, currentPath, scope, options = {}) {
  return {
    previous: getSiblingFolder(tree, currentPath, {
      ...options,
      scope,
      direction: "previous",
    }),
    next: getSiblingFolder(tree, currentPath, {
      ...options,
      scope,
      direction: "next",
    }),
  };
}

export function flattenExpandedFolderTree(tree, expandedPaths = new Set()) {
  const roots = Array.isArray(tree) ? tree : tree ? [tree] : [];
  const expanded =
    expandedPaths instanceof Set ? expandedPaths : new Set(expandedPaths || []);
  const rows = [];

  const visit = (node, depth) => {
    rows.push({ node, depth });
    const path = normalizeRelativePath(node?.path ?? node?.relativePath);
    if (!expanded.has(path)) return;
    (Array.isArray(node?.children) ? node.children : []).forEach((child) =>
      visit(child, depth + 1)
    );
  };
  roots.forEach((root) => visit(root, 0));
  return rows;
}

function rootBasename(rootPath) {
  if (typeof rootPath !== "string" || !rootPath.trim()) return "Root";
  const trimmed = rootPath.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return rootPath.trim();
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || trimmed;
}

function joinRootPath(rootPath, relativePath) {
  const root = typeof rootPath === "string" ? rootPath : "";
  const relative = normalizeRelativePath(relativePath);
  if (!relative) return root;
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const base = root.replace(/[\\/]+$/, "");
  const suffix = relative.split("/").join(separator);
  return base ? `${base}${separator}${suffix}` : `${separator}${suffix}`;
}

export function buildBreadcrumbs(
  rootPath,
  currentDirectory = "",
  { rootLabel = "" } = {}
) {
  const current = normalizeRelativePath(currentDirectory);
  const crumbs = [
    {
      key: "root",
      label: rootLabel || rootBasename(rootPath),
      relativePath: "",
      fullPath: rootPath || "",
      current: current === "",
    },
  ];

  if (!current) return crumbs;

  const parts = current.split("/");
  parts.forEach((label, index) => {
    const relativePath = parts.slice(0, index + 1).join("/");
    crumbs.push({
      key: relativePath,
      label,
      relativePath,
      fullPath: joinRootPath(rootPath, relativePath),
      current: index === parts.length - 1,
    });
  });
  return crumbs;
}
