import { createRequire } from "module";
import http from "http";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
// Loaded through require, as main loads them: the shared filter modules are
// ES modules that the CommonJS main process requires.
const { ViewFeedService, splitIgnored } = require("../view-feeds");
const { compileClipFilter } = require("../shared/clipFilter.mjs");
const { createLocalApiHandlers } = require("../local-api/handlers");
const { createLocalApiServer } = require("../local-api/server");

const pk = (letter) => `pk3-${letter.repeat(32)}`;
const gk = (letter) => `gk4-${letter.repeat(32)}`;

// A made-up library: `rows` as listFeedPoolChunk returns them.
function fakeStore({ rows, tags = {}, views, tagTree = [], workflow = null }) {
  const sorted = [...rows].sort((a, b) => a.instanceId - b.instanceId);
  return {
    listSavedViews: () => views,
    getSavedView: (id) => views.find((view) => view.id === Number(id)) || null,
    listFeedPoolChunk: vi.fn(({ afterId = 0, limit }) => {
      const clips = sorted.filter((row) => row.instanceId > afterId).slice(0, limit).map((row) => ({ ...row }));
      return { lastId: clips.length ? clips[clips.length - 1].instanceId : afterId, clips };
    }),
    listFeedTagNames: () => new Map(Object.entries(tags)),
    listTags: () => tagTree,
    matchWorkflowFacts: vi.fn((fingerprints) => ({
      matches: fingerprints.filter((fingerprint) => workflow?.has(fingerprint)),
      unread: 0,
    })),
  };
}

const row = (instanceId, fingerprint, extra = {}) => ({
  instanceId,
  fingerprint,
  absolutePath: `/a1/${fingerprint}.mp4`,
  relativePath: `${fingerprint}.mp4`,
  rootPath: "/a1",
  lastSeenAt: 100,
  rating: null,
  reviewState: "unreviewed",
  dimensions: { width: 1280, height: 720, durationMs: 5000 },
  ...extra,
});

const view = (id, filters, extra = {}) => ({
  id,
  name: `View ${id}`,
  updatedAt: 1000 + id,
  shared: true,
  definition: { filters },
  ...extra,
});

describe("view feeds", () => {
  it("answers a view's clips once per content, with tag paths, and marks clips it cannot open", async () => {
    const store = fakeStore({
      rows: [
        row(1, "fa", { rating: 5, reviewState: "pick" }),
        row(2, "fb", { rating: 4 }),
        row(3, "fc", { rating: 3 }),
        // The same content twice: the copy that can be opened answers.
        row(4, "fb", { absolutePath: "/b1/fb.mp4", rootPath: "/b1", lastSeenAt: 200, rating: 4 }),
        row(5, "fd", { absolutePath: "/b1/fd.mp4", rootPath: "/b1", rating: 5 }),
        row(6, "fe", { rating: 5, reviewState: "reject" }),
      ],
      tags: { fa: ["bellydance"] },
      tagTree: [{ name: "dance", parent: null }, { name: "bellydance", parent: "dance" }],
      views: [view(1, { minRating: 4, reviewFilter: "any" })],
    });
    const feeds = new ViewFeedService();
    const answer = await feeds.clips({ store, scope: "p-1", viewId: 1, unavailableRootPaths: ["/b1"] });
    expect(answer.view).toMatchObject({ id: 1, name: "View 1" });
    expect(answer.clips.map((clip) => [clip.path, clip.available])).toEqual([
      ["/a1/fa.mp4", true],
      ["/a1/fb.mp4", true],
      ["/a1/fe.mp4", true],
      ["/b1/fd.mp4", false],
    ]);
    expect(answer.clips[0]).toMatchObject({
      contentId: "fa",
      rating: 5,
      review: "pick",
      tags: [{ name: "bellydance", path: ["dance", "bellydance"] }],
      width: 1280,
      height: 720,
      durationMs: 5000,
    });
    expect(answer).toMatchObject({ total: 4, next: null, unchanged: false, ignored: [] });
  });

  it("pages one snapshot, answers unchanged for the same etag, and says when the set moved", async () => {
    const rows = [1, 2, 3, 4, 5].map((id) => row(id, `f${id}`, { rating: 4 }));
    const store = fakeStore({ rows, views: [view(1, { minRating: 4 })] });
    const feeds = new ViewFeedService();
    const first = await feeds.clips({ store, scope: "p-1", viewId: 1, limit: 2 });
    expect(first.clips).toHaveLength(2);
    expect(first.total).toBe(5);
    const second = await feeds.clips({ store, scope: "p-1", viewId: 1, limit: 2, after: first.next });
    const third = await feeds.clips({ store, scope: "p-1", viewId: 1, limit: 2, after: second.next });
    expect([...first.clips, ...second.clips, ...third.clips].map((clip) => clip.contentId)).toEqual([
      "f1", "f2", "f3", "f4", "f5",
    ]);
    expect(third.next).toBeNull();

    const again = await feeds.clips({ store, scope: "p-1", viewId: 1, unless: first.etag });
    expect(again).toMatchObject({ unchanged: true, clips: [], etag: first.etag });

    // The snapshot is gone and the set changed: the next page refuses.
    rows[0].rating = 2;
    feeds.clear();
    await expect(feeds.clips({ store, scope: "p-1", viewId: 1, limit: 2, after: first.next })).rejects.toMatchObject({
      code: "FEED_CHANGED",
    });
    const fresh = await feeds.clips({ store, scope: "p-1", viewId: 1, unless: first.etag });
    expect(fresh.unchanged).toBe(false);
    expect(fresh.total).toBe(4);
    // A snapshot is never served to another profile.
    await expect(
      feeds.clips({ store, scope: "p-2", viewId: 1, limit: 2, after: (await feeds.clips({ store, scope: "p-1", viewId: 1, limit: 2 })).next })
    ).resolves.toMatchObject({ total: 4 });
  });

  it("refuses views that are gone or not shared, and lists only shared ones", async () => {
    const store = fakeStore({
      rows: [],
      views: [view(1, {}), view(2, {}, { shared: false })],
    });
    const feeds = new ViewFeedService();
    expect(feeds.views(store).map((entry) => entry.id)).toEqual([1]);
    await expect(feeds.clips({ store, scope: "p", viewId: 2 })).rejects.toMatchObject({ code: "VIEW_NOT_SHARED" });
    await expect(feeds.clips({ store, scope: "p", viewId: 9 })).rejects.toMatchObject({ code: "VIEW_NOT_FOUND" });
    await expect(feeds.clips({ store, scope: "p", viewId: 1, limit: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("applies prompt words and workflow facts in main, and names the parts it cannot apply", async () => {
    const promptService = {
      limits: { maxKeys: 20_000 },
      searchPrompts: vi.fn(async ({ promptKeys, supersede }) => ({
        matches: promptKeys.filter((key) => key === pk("a")),
        unread: supersede === false ? 1 : 0,
      })),
    };
    const store = fakeStore({
      rows: [
        row(1, "fa", { promptKey: pk("a") }),
        row(2, "fb", { promptKey: pk("b") }),
        row(3, "fc", { promptKey: pk("a") }),
      ],
      workflow: new Set(["fa", "fb"]),
      views: [
        view(1, {
          promptQuery: "running",
          workflowInclude: "acme",
          mightBe: "dance",
          companionFilters: { c1: "sent" },
        }),
      ],
    });
    const feeds = new ViewFeedService({ promptService });
    const answer = await feeds.clips({ store, scope: "p", viewId: 1 });
    expect(answer.clips.map((clip) => clip.contentId)).toEqual(["fa"]);
    expect(answer.ignored).toEqual(["companionFilters", "mightBe"]);
    expect(answer.pending).toEqual({ prompts: 1, workflows: 0 });
    // Never cancels the grid's own prompt searches.
    expect(promptService.searchPrompts).toHaveBeenCalledWith(expect.objectContaining({ supersede: false }));
  });

  it("keeps the best version only when the view asks, as the grid does", async () => {
    const store = fakeStore({
      rows: [
        row(1, "small", { generationKey: gk("a"), dimensions: { width: 640, height: 360 } }),
        row(2, "large", { generationKey: gk("a"), dimensions: { width: 1920, height: 1080 } }),
        row(3, "alone", {}),
      ],
      views: [view(1, { versionFilter: "best" })],
    });
    const answer = await new ViewFeedService().clips({ store, scope: "p", viewId: 1 });
    expect(answer.clips.map((clip) => clip.contentId)).toEqual(["alone", "large"]);
  });

  it("splits off what only the window can apply", () => {
    expect(splitIgnored({ minRating: 3, companionHideSent: ["c1"], companionTags: {} }).ignored).toEqual([
      "companionHideSent",
    ]);
    expect(compileClipFilter({}, {}).active).toBe(false);
  });
});

describe("view feed endpoints", () => {
  const store = fakeStore({ rows: [row(1, "fa", { rating: 5 })], views: [view(1, { minRating: 4 })] });
  const makeHandlers = (enabled) =>
    createLocalApiHandlers({
      appVersion: "1.0.0",
      feeds: { enabled: () => enabled, service: new ViewFeedService(), unavailableRootPaths: async () => [] },
      withStore: async (work) => ({
        profile: "p-1",
        revision: 3,
        ...(await work(store, { profile: "p-1", assertActive: () => {} })),
      }),
    });

  it("answers 403 while following views is off, and says so in describe", async () => {
    const handlers = makeHandlers(false);
    expect(await handlers.describe({})).toMatchObject({ feeds: false });
    await expect(handlers.views({})).rejects.toMatchObject({ status: 403, code: "LOCAL_API_FEEDS_OFF" });
    await expect(handlers["views/clips"]({ view: 1 })).rejects.toMatchObject({ status: 403 });
  });

  it("lists views, answers clips with profile, and maps each refusal to its code", async () => {
    const handlers = makeHandlers(true);
    expect(await handlers.views({})).toMatchObject({ profile: "p-1", views: [{ id: 1, name: "View 1" }] });
    expect(await handlers["views/clips"]({ view: 1, profile: "p-1" })).toMatchObject({
      profile: "p-1",
      total: 1,
      clips: [{ contentId: "fa" }],
    });
    await expect(handlers["views/clips"]({ view: 1, profile: "p-other" })).rejects.toMatchObject({
      status: 409,
      code: "LOCAL_API_PROFILE_CHANGED",
    });
    await expect(handlers["views/clips"]({ view: 7 })).rejects.toMatchObject({ status: 404, code: "LOCAL_API_VIEW_NOT_FOUND" });
    await expect(handlers["views/clips"]({ view: "1" })).rejects.toMatchObject({ status: 400 });
    await expect(handlers["views/clips"]({ view: 1, after: "nonsense" })).rejects.toMatchObject({ status: 400 });
  });

  let server;
  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it("routes /api/v1/views/clips through the server", async () => {
    server = createLocalApiServer({ handlers: makeHandlers(true), getToken: () => "t".repeat(43) });
    const port = await server.start(0);
    const body = JSON.stringify({ view: 1 });
    const answer = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/api/v1/views/clips",
          headers: {
            host: `127.0.0.1:${port}`,
            authorization: `Bearer ${"t".repeat(43)}`,
            "content-type": "application/json",
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
        }
      );
      req.on("error", reject);
      req.end(body);
    });
    expect(answer.status).toBe(200);
    expect(answer.body.clips[0].path).toBe("/a1/fa.mp4");
  });
});
