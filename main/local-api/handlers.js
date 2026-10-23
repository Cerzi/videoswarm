const { LocalApiError } = require("./server");

// The local read API's endpoints (docs/architecture/local-read-api.md):
// describe, clips, tags and changes, and the view feeds (view-feeds.md):
// views and views/clips. They only read. `withStore(work)` runs
// `work(store, { profile })` against the active profile and adds `profile`
// and `revision` to the answer, so a caller can tell a profile switch and
// keep its place.

const LOCAL_API_PROTOCOL = 1;
const MAX_CLIP_KEYS = 5_000;
const MAX_KEY_CHARS = 4_096;

function badRequest(message) {
  return new LocalApiError(400, "LOCAL_API_BAD_REQUEST", message);
}

function stringList(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest(`${name} must be a list`);
  return value.map((entry) => {
    if (typeof entry !== "string" || !entry || entry.length > MAX_KEY_CHARS) {
      throw badRequest(`Every entry of ${name} must be a non-empty string`);
    }
    return entry;
  });
}

const FEED_ERRORS = {
  VIEW_NOT_FOUND: [404, "LOCAL_API_VIEW_NOT_FOUND"],
  VIEW_NOT_SHARED: [403, "LOCAL_API_VIEW_NOT_SHARED"],
  FEED_CHANGED: [409, "LOCAL_API_FEED_CHANGED"],
  BAD_REQUEST: [400, "LOCAL_API_BAD_REQUEST"],
};

function feedError(error) {
  const known = FEED_ERRORS[error?.code];
  return known ? new LocalApiError(known[0], known[1], error.message) : error;
}

/**
 * `feeds` (view-feeds.md): `{ enabled(), service, unavailableRootPaths() }`.
 * Without it, or switched off, the feed endpoints answer 403.
 */
function createLocalApiHandlers({ appVersion, withStore, feeds = null }) {
  const feedsOn = () => Boolean(feeds?.enabled?.());
  function requireFeeds() {
    if (!feedsOn()) {
      throw new LocalApiError(
        403,
        "LOCAL_API_FEEDS_OFF",
        "Following saved views is off in Video Swarm › Preferences › Local API"
      );
    }
  }
  function expectedProfile(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || !value || value.length > 64) throw badRequest("profile must be a profile id");
    return value;
  }
  // A caller following a view under one profile is never answered from another.
  function checkProfile(expected, info) {
    if (expected && expected !== info.profile) {
      throw new LocalApiError(409, "LOCAL_API_PROFILE_CHANGED", "Video Swarm switched profiles since then");
    }
  }

  return {
    async describe() {
      return withStore(async () => ({
        protocol: LOCAL_API_PROTOCOL,
        app: "Video Swarm",
        version: appVersion,
        feeds: feedsOn(),
        limits: {
          clipsPerRequest: MAX_CLIP_KEYS,
          changesPerRequest: 10_000,
          feedPage: feeds?.service?.limits?.pageSize ?? null,
        },
      }));
    },

    async views(body) {
      requireFeeds();
      const expected = expectedProfile(body.profile);
      return withStore(async (store, info) => {
        checkProfile(expected, info);
        return { views: feeds.service.views(store) };
      });
    },

    async "views/clips"(body) {
      requireFeeds();
      const expected = expectedProfile(body.profile);
      if (!Number.isSafeInteger(body.view) || body.view < 1) throw badRequest("view must be a saved view id");
      if (body.unless !== undefined && body.unless !== null && typeof body.unless !== "string") {
        throw badRequest("unless must be an etag");
      }
      if (body.after !== undefined && body.after !== null && typeof body.after !== "string") {
        throw badRequest("after must be a cursor");
      }
      if (body.limit !== undefined && body.limit !== null && !Number.isSafeInteger(body.limit)) {
        throw badRequest("limit must be a whole number");
      }
      const unavailableRootPaths = await feeds.unavailableRootPaths();
      return withStore(async (store, info) => {
        checkProfile(expected, info);
        try {
          return await feeds.service.clips({
            store,
            scope: info.profile,
            viewId: body.view,
            unless: body.unless ?? null,
            after: body.after ?? null,
            limit: body.limit ?? null,
            unavailableRootPaths,
            assertActive: info.assertActive,
          });
        } catch (error) {
          throw feedError(error);
        }
      });
    },

    async clips(body) {
      const paths = stringList(body.paths, "paths");
      const contentIds = stringList(body.contentIds, "contentIds");
      if (paths.length + contentIds.length > MAX_CLIP_KEYS) {
        throw badRequest(`At most ${MAX_CLIP_KEYS} paths and content ids at once`);
      }
      return withStore(async (store) => {
        const found = store.getLocalApiClips({ paths, contentIds });
        // Every key asked about is answered; a clip Video Swarm does not
        // know is null, so nothing is said about anything not asked.
        const clips = {};
        for (const key of [...paths, ...contentIds]) clips[key] = found.get(key) || null;
        return { clips };
      });
    },

    async tags() {
      return withStore(async (store) => ({
        tags: store.listTags().map(({ name, parent }) => ({ name, parent: parent || null })),
      }));
    },

    async changes(body) {
      const since = body.since;
      if (!Number.isSafeInteger(since) || since < 0) {
        throw badRequest("since must be a revision: a whole number from 0");
      }
      return withStore(async (store) => store.listMetadataChangesSince(since));
    },
  };
}

module.exports = { LOCAL_API_PROTOCOL, MAX_CLIP_KEYS, createLocalApiHandlers };
