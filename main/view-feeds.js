const crypto = require("crypto");
const { compileClipFilter } = require("./shared/clipFilter.mjs");
const { buildTagHierarchy } = require("./shared/tagHierarchy.mjs");
const { buildGenerationVersionIndex } = require("./shared/generationVersions.mjs");
const { normalizeMightBe, normalizePromptQuery, workflowFilterQuery } = require("./shared/filterValues.mjs");

// View feeds (docs/architecture/view-feeds.md): another app follows a saved
// view and receives the clips it matches across the whole library, applied
// here with the grid's own test (main/shared/clipFilter.mjs). The answer is
// paged; every page of one answer comes from one snapshot named by its etag.

const FEED_LIMITS = Object.freeze({
  pageSize: 5_000,
  catalogChunk: 5_000,
  snapshots: 4,
  snapshotTtlMs: 5 * 60 * 1000,
  // Prompt reading stops here; the rest counts as pending.
  promptBudgetMs: 15_000,
  workflowChunk: 100_000,
});

class ViewFeedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ViewFeedError";
    this.code = code;
  }
}

const viewRevision = (view) => `r${view.updatedAt}-${view.shared ? 1 : 0}`;
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

// Parts of a definition only the window can apply: left out, and named.
function splitIgnored(filters) {
  const kept = { ...filters };
  const ignored = [];
  const nonEmpty = (value) =>
    Array.isArray(value) ? value.length > 0 : value && typeof value === "object" && Object.keys(value).length > 0;
  for (const key of ["companionFilters", "companionHideSent", "companionTags"]) {
    if (nonEmpty(kept[key])) ignored.push(key);
    delete kept[key];
  }
  if (normalizeMightBe(kept.mightBe)) ignored.push("mightBe");
  kept.mightBe = "";
  return { filters: kept, ignored };
}

const encodeCursor = (etag, offset) => Buffer.from(`${etag}:${offset}`, "utf8").toString("base64url");
function decodeCursor(value) {
  if (typeof value !== "string" || value.length > 128) return null;
  const match = /^([0-9a-f]{32}):(\d{1,9})$/u.exec(Buffer.from(value, "base64url").toString("utf8"));
  return match ? { etag: match[1], offset: Number(match[2]) } : null;
}

class ViewFeedService {
  constructor({ promptService = null, now = Date.now, limits = {} } = {}) {
    this.promptService = promptService;
    this.now = now;
    this.limits = { ...FEED_LIMITS, ...limits };
    this.snapshots = new Map();
  }

  /** The shared saved views: `[{ id, name, updatedAt, revision }]`. */
  views(store) {
    return store
      .listSavedViews()
      .filter((view) => view.shared !== false)
      .map((view) => ({ id: view.id, name: view.name, updatedAt: view.updatedAt, revision: viewRevision(view) }));
  }

  _view(store, viewId) {
    let view = null;
    try {
      view = store.getSavedView(viewId);
    } catch {
      view = null;
    }
    if (!view) throw new ViewFeedError("VIEW_NOT_FOUND", "No saved view with that id in this profile");
    if (view.shared === false) throw new ViewFeedError("VIEW_NOT_SHARED", "That saved view is not shared with apps");
    return view;
  }

  /**
   * One page of the clips view `viewId` matches. `scope` names the profile,
   * so a snapshot is never served across a switch. Returns the answer
   * without `profile`/`revision`, which the API adds.
   */
  async clips({ store, scope, viewId, unless = null, after = null, limit, unavailableRootPaths = [], assertActive }) {
    const pageSize = limit === undefined || limit === null ? this.limits.pageSize : limit;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > this.limits.pageSize) {
      throw new ViewFeedError("BAD_REQUEST", `limit must be from 1 to ${this.limits.pageSize}`);
    }
    const view = this._view(store, viewId);
    this._forgetOld();

    let cursor = null;
    if (after !== null && after !== undefined) {
      cursor = decodeCursor(after);
      if (!cursor) throw new ViewFeedError("BAD_REQUEST", "after is not a cursor from this API");
    }
    let snapshot = cursor ? this.snapshots.get(cursor.etag) : null;
    if (snapshot && (snapshot.scope !== scope || snapshot.viewId !== view.id)) snapshot = null;
    if (!snapshot) {
      snapshot = await this._compute({ store, scope, view, unavailableRootPaths, assertActive });
      if (cursor && snapshot.etag !== cursor.etag) {
        throw new ViewFeedError("FEED_CHANGED", "The view's clips changed between pages; start again");
      }
    }
    const head = { view: { id: view.id, name: view.name, revision: viewRevision(view) } };
    if (!cursor && typeof unless === "string" && unless === snapshot.etag) {
      return { ...head, etag: snapshot.etag, unchanged: true, clips: [], total: snapshot.clips.length, next: null, ignored: snapshot.ignored, pending: snapshot.pending };
    }
    const offset = cursor ? cursor.offset : 0;
    const page = snapshot.clips.slice(offset, offset + pageSize);
    const end = offset + page.length;
    return {
      ...head,
      etag: snapshot.etag,
      unchanged: false,
      clips: page,
      total: snapshot.clips.length,
      next: end < snapshot.clips.length ? encodeCursor(snapshot.etag, end) : null,
      ignored: snapshot.ignored,
      pending: snapshot.pending,
    };
  }

  _forgetOld() {
    const oldest = this.now() - this.limits.snapshotTtlMs;
    for (const [etag, snapshot] of this.snapshots) {
      if (snapshot.at < oldest) this.snapshots.delete(etag);
    }
  }

  async _catalog(store, unavailableRootPaths, assertActive) {
    const unavailable = new Set(unavailableRootPaths);
    // One entry per path (a folder indexed inside another lists it twice).
    const byPath = new Map();
    let afterId = 0;
    for (;;) {
      const chunk = store.listFeedPoolChunk({ afterId, limit: this.limits.catalogChunk, assertActive });
      for (const clip of chunk.clips) {
        const held = byPath.get(clip.absolutePath);
        if (
          !held ||
          clip.lastSeenAt > held.lastSeenAt ||
          (clip.lastSeenAt === held.lastSeenAt && clip.rootPath.length > held.rootPath.length)
        ) {
          byPath.set(clip.absolutePath, clip);
        }
      }
      if (chunk.clips.length < this.limits.catalogChunk) break;
      afterId = chunk.lastId;
      await yieldToEventLoop();
      assertActive?.();
    }
    // Each content once: a copy that can be opened, else the one seen last.
    const byContent = new Map();
    for (const clip of byPath.values()) {
      clip.available = !unavailable.has(clip.rootPath);
      const held = byContent.get(clip.fingerprint);
      if (
        !held ||
        (clip.available && !held.available) ||
        (clip.available === held.available &&
          (clip.lastSeenAt > held.lastSeenAt ||
            (clip.lastSeenAt === held.lastSeenAt && clip.instanceId < held.instanceId)))
      ) {
        byContent.set(clip.fingerprint, clip);
      }
    }
    const tagNames = store.listFeedTagNames();
    const clips = [...byContent.values()];
    for (const clip of clips) {
      clip.id = clip.instanceId;
      clip.tags = tagNames.get(clip.fingerprint) || [];
    }
    return clips;
  }

  async _promptMatches(store, clips, query, assertActive) {
    const keys = [...new Set(clips.map((clip) => clip.promptKey).filter(Boolean))];
    const matches = new Set();
    let unread = 0;
    if (!this.promptService || keys.length === 0) return { matches, unread: this.promptService ? 0 : keys.length };
    const deadline = this.now() + this.limits.promptBudgetMs;
    const step = this.promptService.limits?.maxKeys || 20_000;
    for (let index = 0; index < keys.length; index += step) {
      const found = await this.promptService.searchPrompts({
        store,
        promptKeys: keys.slice(index, index + step),
        query,
        assertActive,
        supersede: false,
        deadline,
      });
      for (const key of found?.matches || []) matches.add(key);
      unread += Number(found?.unread || 0);
    }
    return { matches, unread };
  }

  _workflowMatches(store, clips, query, assertActive) {
    const fingerprints = clips.map((clip) => clip.fingerprint);
    const matches = new Set();
    let unread = 0;
    for (let index = 0; index < fingerprints.length; index += this.limits.workflowChunk) {
      const found = store.matchWorkflowFacts(fingerprints.slice(index, index + this.limits.workflowChunk), {
        ...query,
        assertActive,
      });
      for (const fingerprint of found.matches) matches.add(fingerprint);
      unread += Number(found.unread || 0);
    }
    return { matches, unread };
  }

  async _compute({ store, scope, view, unavailableRootPaths, assertActive }) {
    const { filters, ignored } = splitIgnored(view.definition?.filters || {});
    const pool = await this._catalog(store, unavailableRootPaths, assertActive);
    const pending = { prompts: 0, workflows: 0 };

    let promptMatches = null;
    const promptQuery = normalizePromptQuery(filters.promptQuery).trim();
    if (promptQuery) {
      const found = await this._promptMatches(store, pool, promptQuery, assertActive);
      promptMatches = found.matches;
      pending.prompts = found.unread;
    }
    let workflowMatches = null;
    const workflowQuery = workflowFilterQuery(filters);
    if (workflowQuery) {
      const found = this._workflowMatches(store, pool, workflowQuery, assertActive);
      workflowMatches = found.matches;
      pending.workflows = found.unread;
    }
    assertActive?.();

    const hierarchy = buildTagHierarchy(store.listTags());
    const versions = buildGenerationVersionIndex(pool);
    const clipFilter = compileClipFilter(filters, {
      tagHierarchy: hierarchy,
      versionOf: (clip) => versions.get(clip.id),
      promptMatches,
      workflowMatches,
    });
    const clips = pool
      .filter((clip) => clipFilter.test(clip))
      .sort((a, b) => (a.absolutePath < b.absolutePath ? -1 : a.absolutePath > b.absolutePath ? 1 : 0))
      .map((clip) => ({
        path: clip.absolutePath,
        contentId: clip.fingerprint,
        available: clip.available,
        rating: Number.isInteger(clip.rating) && clip.rating >= 1 && clip.rating <= 5 ? clip.rating : null,
        review: clip.reviewState,
        tags: clip.tags.map((name) => ({ name, path: hierarchy.pathOf(name) })),
        generationKey: clip.generationKey || null,
        promptKey: clip.promptKey || null,
        width: clip.dimensions?.width ?? null,
        height: clip.dimensions?.height ?? null,
        durationMs: clip.dimensions?.durationMs ?? null,
      }));
    const etag = crypto
      .createHash("sha256")
      .update(JSON.stringify([viewRevision(view), ignored, pending, clips]))
      .digest("hex")
      .slice(0, 32);
    const snapshot = { etag, scope, viewId: view.id, clips, ignored, pending, at: this.now() };
    this.snapshots.delete(etag);
    this.snapshots.set(etag, snapshot);
    while (this.snapshots.size > this.limits.snapshots) {
      this.snapshots.delete(this.snapshots.keys().next().value);
    }
    return snapshot;
  }

  // Profile switches forget every snapshot.
  clear() {
    this.snapshots.clear();
  }
}

module.exports = { FEED_LIMITS, ViewFeedError, ViewFeedService, decodeCursor, encodeCursor, splitIgnored };
