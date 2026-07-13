import { FolderScope, normalizeFolderScope, normalizeRelativePath } from "./folderModel";
import { createDefaultFilters, normalizeTagList } from "../app/filters/filtersUtils";
import { normalizeReviewFilter } from "../review/reviewState";

export const DEFAULT_FOLDER_VIEW_CACHE_LIMIT = 128;
export const MAX_RESTORED_SELECTION_IDS = 500;

const normalizeRootPath = (value) =>
  typeof value === "string" ? value.trim() : "";

export const makeFolderViewKey = (rootPath, directory, scope) =>
  JSON.stringify([
    normalizeRootPath(rootPath),
    normalizeRelativePath(directory),
    normalizeFolderScope(scope),
  ]);

const normalizeFilters = (filters) => ({
  ...createDefaultFilters(),
  includeTags: normalizeTagList(filters?.includeTags).slice(0, 100),
  excludeTags: normalizeTagList(filters?.excludeTags).slice(0, 100),
  minRating:
    filters?.minRating == null ? null : Math.max(1, Math.min(5, Math.round(Number(filters.minRating)) || 1)),
  exactRating:
    filters?.exactRating == null ? null : Math.max(0, Math.min(5, Math.round(Number(filters.exactRating)) || 0)),
  reviewFilter: normalizeReviewFilter(filters?.reviewFilter),
});

const normalizeSnapshot = (snapshot = {}) => ({
  scrollTop: Math.max(0, Number(snapshot.scrollTop) || 0),
  selectedIds: Array.from(snapshot.selectedIds || [])
    .filter((id) => typeof id === "string" || typeof id === "number")
    .slice(0, MAX_RESTORED_SELECTION_IDS),
  sortKey: typeof snapshot.sortKey === "string" ? snapshot.sortKey : "name",
  sortDir: snapshot.sortDir === "desc" ? "desc" : "asc",
  groupByFolders: Boolean(snapshot.groupByFolders),
  randomSeed: Number.isFinite(snapshot.randomSeed) ? snapshot.randomSeed : null,
  filters: normalizeFilters(snapshot.filters),
});

export class FolderViewStateCache {
  constructor(limit = DEFAULT_FOLDER_VIEW_CACHE_LIMIT) {
    this.limit = Math.max(1, Math.floor(Number(limit) || DEFAULT_FOLDER_VIEW_CACHE_LIMIT));
    this.views = new Map();
    this.locations = new Map();
  }

  set(rootPath, directory, scope, snapshot) {
    const root = normalizeRootPath(rootPath);
    if (!root) return null;
    const key = makeFolderViewKey(root, directory, scope);
    const normalized = normalizeSnapshot(snapshot);
    this.views.delete(key);
    this.views.set(key, normalized);
    this.setLocation(root, directory, scope);
    while (this.views.size > this.limit) {
      this.views.delete(this.views.keys().next().value);
    }
    return { ...normalized, selectedIds: [...normalized.selectedIds] };
  }

  get(rootPath, directory, scope) {
    const key = makeFolderViewKey(rootPath, directory, scope);
    const snapshot = this.views.get(key);
    if (!snapshot) return null;
    this.views.delete(key);
    this.views.set(key, snapshot);
    return {
      ...snapshot,
      selectedIds: [...snapshot.selectedIds],
      filters: {
        ...snapshot.filters,
        includeTags: [...snapshot.filters.includeTags],
        excludeTags: [...snapshot.filters.excludeTags],
      },
    };
  }

  setLocation(rootPath, directory, scope = FolderScope.ALL_DESCENDANTS) {
    const root = normalizeRootPath(rootPath);
    if (!root) return;
    this.locations.delete(root);
    this.locations.set(root, {
      directory: normalizeRelativePath(directory),
      scope: normalizeFolderScope(scope),
    });
    while (this.locations.size > this.limit) {
      this.locations.delete(this.locations.keys().next().value);
    }
  }

  getLocation(rootPath) {
    const root = normalizeRootPath(rootPath);
    const location = this.locations.get(root);
    return location ? { ...location } : null;
  }

  clear() {
    this.views.clear();
    this.locations.clear();
  }
}
