import {
  FolderScope,
  getParentDirectory,
  normalizeFolderScope,
  normalizeRelativePath,
} from "../library/folderModel";
import { REVIEW_FILTERS, normalizeReviewFilter, normalizeReviewState } from "./reviewState";
import { SortKey } from "../sorting/sorting";

export const REVIEW_CHECKPOINT_VIEW_VERSION = 1;
export const REVIEW_SESSION_TAG_LIMIT = 100;

const REVIEW_SESSION_TAG_LENGTH_LIMIT = 80;
const REVIEW_SESSION_FINGERPRINT_LIMIT = 512;
const VALID_SORT_KEYS = new Set(Object.values(SortKey));

const compareCaseInsensitive = (left, right) => {
  const leftFolded = left.toLowerCase();
  const rightFolded = right.toLowerCase();
  if (leftFolded < rightFolded) return -1;
  if (leftFolded > rightFolded) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
};

const normalizeTags = (values) => {
  const sorted = (Array.isArray(values) ? values : [])
    .map((value) => String(value ?? "").trim().slice(0, REVIEW_SESSION_TAG_LENGTH_LIMIT))
    .filter(Boolean)
    .sort(compareCaseInsensitive);
  const seen = new Set();
  const result = [];

  for (const value of sorted) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= REVIEW_SESSION_TAG_LIMIT) break;
  }
  return result;
};

const normalizeRating = (value, minimum) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(minimum, Math.min(5, Math.round(number)));
};

const normalizeRandomSeed = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(
    Number.MIN_SAFE_INTEGER,
    Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(number))
  );
};

const normalizeRootPath = (value) =>
  typeof value === "string" && value.trim() ? value : "";

const normalizeInstanceId = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

const normalizeFingerprint = (value) => {
  if (typeof value !== "string") return null;
  const fingerprint = value.trim();
  return fingerprint
    ? fingerprint.slice(0, REVIEW_SESSION_FINGERPRINT_LIMIT)
    : null;
};

export function normalizeReviewSessionView(input = {}) {
  const filters = input?.filters && typeof input.filters === "object"
    ? input.filters
    : {};
  const sort = input?.sort && typeof input.sort === "object" ? input.sort : {};
  const exactRating = normalizeRating(filters.exactRating, 0);
  const key = VALID_SORT_KEYS.has(sort.key) ? sort.key : SortKey.NAME;

  return {
    version: REVIEW_CHECKPOINT_VIEW_VERSION,
    filters: {
      includeTags: normalizeTags(filters.includeTags),
      excludeTags: normalizeTags(filters.excludeTags),
      minRating: exactRating === null
        ? normalizeRating(filters.minRating, 1)
        : null,
      exactRating,
      reviewFilter: normalizeReviewFilter(filters.reviewFilter),
    },
    sort: {
      key,
      dir: sort.dir === "desc" ? "desc" : "asc",
      groupByFolders: sort.groupByFolders !== false,
      randomSeed: key === SortKey.RANDOM
        ? normalizeRandomSeed(sort.randomSeed)
        : null,
    },
  };
}

export function normalizeReviewAnchor(input = {}) {
  const source = input?.anchor && typeof input.anchor === "object"
    ? input.anchor
    : input;
  return {
    anchorInstanceId: normalizeInstanceId(
      input?.anchorInstanceId ?? source?.instanceId ?? source?.anchorInstanceId
    ),
    anchorFingerprint: normalizeFingerprint(
      input?.anchorFingerprint ?? source?.fingerprint ?? source?.anchorFingerprint
    ),
  };
}

export function normalizeReviewCheckpoint(input = {}) {
  const scope = normalizeFolderScope(input?.scope);
  const directory = scope === FolderScope.ALL_DESCENDANTS
    ? ""
    : normalizeRelativePath(input?.directory);
  const updatedAtValue = Number(input?.updatedAt);

  return {
    rootPath: normalizeRootPath(input?.rootPath),
    directory,
    scope,
    view: normalizeReviewSessionView(input?.view),
    ...normalizeReviewAnchor(input),
    updatedAt: Number.isSafeInteger(updatedAtValue) && updatedAtValue >= 0
      ? updatedAtValue
      : 0,
  };
}

export function buildReviewCheckpointDraft(input = {}) {
  const { updatedAt: _updatedAt, ...draft } = normalizeReviewCheckpoint(input);
  return draft;
}

export function createReviewCheckpointSignature(input = {}) {
  return JSON.stringify(buildReviewCheckpointDraft(input));
}

export function checkpointLocationMatches(checkpoint, location) {
  if (!checkpoint || !location) return false;
  const left = normalizeReviewCheckpoint(checkpoint);
  const rightScope = normalizeFolderScope(location.scope);
  return (
    left.rootPath === normalizeRootPath(location.rootPath) &&
    left.scope === rightScope &&
    left.directory === (
      rightScope === FolderScope.ALL_DESCENDANTS
        ? ""
        : normalizeRelativePath(location.directory)
    )
  );
}

const directoryValue = (value) => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || value.present === false) return null;
  if (typeof value.relativePath === "string") return value.relativePath;
  return typeof value.path === "string" ? value.path : null;
};

export function findNearestPresentDirectory(directory, directories = []) {
  const present = new Set([""]);
  for (const entry of Array.isArray(directories) ? directories : []) {
    const value = directoryValue(entry);
    if (value !== null) present.add(normalizeRelativePath(value));
  }

  let candidate = normalizeRelativePath(directory);
  while (!present.has(candidate) && candidate) {
    candidate = getParentDirectory(candidate);
  }
  return present.has(candidate) ? candidate : "";
}

export function resolveReviewCheckpointLocation(checkpoint, directories = []) {
  const normalized = normalizeReviewCheckpoint(checkpoint);
  const requestedDirectory = normalized.directory;
  const directory = normalized.scope === FolderScope.ALL_DESCENDANTS
    ? ""
    : findNearestPresentDirectory(requestedDirectory, directories);
  return {
    rootPath: normalized.rootPath,
    directory,
    scope: normalized.scope,
    didFallback: directory !== requestedDirectory,
    requestedDirectory,
  };
}

const isUnreviewedCandidate = (video) =>
  video?.present !== false &&
  normalizeReviewState(video?.reviewState) === REVIEW_FILTERS.UNREVIEWED;

const candidateResult = (video, index, context) => ({
  candidateId: video?.id ?? null,
  candidateInstanceId: normalizeInstanceId(video?.instanceId),
  candidateFingerprint: normalizeFingerprint(video?.fingerprint),
  candidateName: String(
    video?.basename ?? video?.name ?? video?.relativePath ?? ""
  ),
  candidateIndex: index,
  ...context,
});

const emptyCandidateResult = (context) => ({
  candidateId: null,
  candidateInstanceId: null,
  candidateFingerprint: null,
  candidateName: "",
  candidateIndex: -1,
  ...context,
});

export function resolveContinueReviewCandidate(orderedVideos, checkpoint = {}) {
  const videos = Array.isArray(orderedVideos) ? orderedVideos : [];
  const anchor = normalizeReviewAnchor(checkpoint);
  let anchorIndex = -1;
  let anchorResolution = anchor.anchorFingerprint ? "missing" : "none";

  if (anchor.anchorInstanceId !== null && anchor.anchorFingerprint) {
    anchorIndex = videos.findIndex((video) =>
      normalizeInstanceId(video?.instanceId) === anchor.anchorInstanceId &&
      normalizeFingerprint(video?.fingerprint) === anchor.anchorFingerprint
    );
    if (anchorIndex >= 0) anchorResolution = "instance";
  }

  if (anchorIndex < 0 && anchor.anchorFingerprint) {
    anchorIndex = videos.findIndex(
      (video) => normalizeFingerprint(video?.fingerprint) === anchor.anchorFingerprint
    );
    if (anchorIndex >= 0) anchorResolution = "fingerprint";
  }

  const context = {
    anchorIndex,
    anchorResolution,
    wrapped: false,
    reason: "complete",
  };

  if (anchorIndex >= 0 && isUnreviewedCandidate(videos[anchorIndex])) {
    return candidateResult(videos[anchorIndex], anchorIndex, {
      ...context,
      reason: "anchor",
    });
  }

  const searchStart = anchorIndex >= 0 ? anchorIndex + 1 : 0;
  for (let index = searchStart; index < videos.length; index += 1) {
    if (!isUnreviewedCandidate(videos[index])) continue;
    return candidateResult(videos[index], index, {
      ...context,
      reason: anchorIndex >= 0 ? "after-anchor" : "start",
    });
  }

  if (anchorIndex >= 0) {
    for (let index = 0; index < anchorIndex; index += 1) {
      if (!isUnreviewedCandidate(videos[index])) continue;
      return candidateResult(videos[index], index, {
        ...context,
        wrapped: true,
        reason: "wrapped",
      });
    }
  }

  return emptyCandidateResult(context);
}

export function requiresRecursiveReviewCoverage(location, recursive) {
  if (recursive) return false;
  const scope = normalizeFolderScope(location?.scope);
  const directory = scope === FolderScope.ALL_DESCENDANTS
    ? ""
    : normalizeRelativePath(location?.directory);
  return !(scope === FolderScope.CURRENT_FOLDER && directory === "");
}
