const { LocalApiError } = require("./server");

// The local read API's endpoints (docs/architecture/local-read-api.md):
// describe, clips, tags and changes. They only read. `withStore(work)` runs
// `work(store)` against the active profile and adds `profile` and `revision`
// to the answer, so a caller can tell a profile switch and keep its place.

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

function createLocalApiHandlers({ appVersion, withStore }) {
  return {
    async describe() {
      return withStore(async () => ({
        protocol: LOCAL_API_PROTOCOL,
        app: "Video Swarm",
        version: appVersion,
        limits: { clipsPerRequest: MAX_CLIP_KEYS, changesPerRequest: 10_000 },
      }));
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
