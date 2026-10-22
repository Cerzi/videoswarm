import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  CompanionConnectionError,
  normalizeCompanionConnection,
  normalizeCompanionConnections,
  parseCompanionUrl,
  validateCompanionConnection,
  validateCompanionConnections,
} = require("../companion-connection");
const {
  createCompanionClient,
  normalizeDescription,
  normalizeLookup,
  normalizeSendResults,
} = require("../companion-client");
const { createFakeCompanion, TARGET_DESCRIPTION } = require("./helpers/fakeCompanion.cjs");

const CLIP_A = "/library/run/clip-a.mp4";
const CLIP_B = "/library/run/clip-b.mp4";

describe("companion connection setting", () => {
  it("accepts loopback addresses only, as an origin", () => {
    expect(parseCompanionUrl("http://127.0.0.1:8000/")).toBe("http://127.0.0.1:8000");
    expect(parseCompanionUrl(" http://localhost:9 ")).toBe("http://localhost:9");
    expect(parseCompanionUrl("http://[::1]:8000")).toBe("http://[::1]:8000");
    expect(() => parseCompanionUrl("http://192.168.1.4:8000")).toThrow(CompanionConnectionError);
    expect(() => parseCompanionUrl("http://example.com")).toThrow(/this computer/u);
    expect(() => parseCompanionUrl("ftp://127.0.0.1")).toThrow(/http/u);
    expect(() => parseCompanionUrl("http://127.0.0.1:8000/api")).toThrow(/host and port/u);
    expect(() => parseCompanionUrl("http://u:p@127.0.0.1:8000")).toThrow(/host and port/u);
  });

  it("is off by default and needs an address to switch on", () => {
    expect(normalizeCompanionConnection(undefined)).toEqual({ enabled: false, url: null });
    expect(normalizeCompanionConnection({ enabled: true, url: "http://example.com" })).toEqual({
      enabled: false,
      url: null,
    });
    expect(normalizeCompanionConnection({ enabled: true, url: "http://127.0.0.1:1" })).toEqual({
      enabled: true,
      url: "http://127.0.0.1:1",
    });
    expect(validateCompanionConnection({ enabled: false, url: "" })).toEqual({
      enabled: false,
      url: null,
    });
    expect(() => validateCompanionConnection({ enabled: true, url: "" })).toThrow(/address/u);
  });
});

describe("companion connection list", () => {
  it("keeps up to four companions with unique ids and addresses", () => {
    expect(normalizeCompanionConnections(undefined)).toEqual([]);
    expect(
      normalizeCompanionConnections([
        { id: "c2", enabled: true, url: "http://127.0.0.1:1/" },
        { id: "c2", enabled: false, url: "http://localhost:2" },
        { id: "zz", enabled: true, url: "http://127.0.0.1:1" },
        { id: "c4", enabled: true, url: "http://example.com:3" },
        "junk",
      ])
    ).toEqual([
      { id: "c2", enabled: true, url: "http://127.0.0.1:1" },
      { id: "c1", enabled: false, url: "http://localhost:2" },
    ]);
    const many = Array.from({ length: 6 }, (_, index) => ({ enabled: true, url: `http://127.0.0.1:${index + 1}` }));
    expect(normalizeCompanionConnections(many)).toHaveLength(4);
  });

  it("makes a profile's single connection from before the list its first entry", () => {
    expect(normalizeCompanionConnections(undefined, { enabled: true, url: "http://127.0.0.1:8000" })).toEqual([
      { id: "c1", enabled: true, url: "http://127.0.0.1:8000" },
    ]);
    expect(normalizeCompanionConnections(undefined, { enabled: false, url: null })).toEqual([]);
    // Once a list is saved, the old setting is ignored.
    expect(normalizeCompanionConnections([], { enabled: true, url: "http://127.0.0.1:8000" })).toEqual([]);
  });

  it("refuses a list it cannot keep, and numbers new entries", () => {
    expect(
      validateCompanionConnections([
        { id: "c2", enabled: true, url: "http://127.0.0.1:1" },
        { enabled: false, url: "http://localhost:2" },
      ])
    ).toEqual([
      { id: "c2", enabled: true, url: "http://127.0.0.1:1" },
      { id: "c1", enabled: false, url: "http://localhost:2" },
    ]);
    expect(() => validateCompanionConnections("x")).toThrow(/list/u);
    expect(() => validateCompanionConnections([{ enabled: false, url: "" }])).toThrow(/address/u);
    expect(() =>
      validateCompanionConnections([
        { enabled: true, url: "http://127.0.0.1:1" },
        { enabled: true, url: "http://127.0.0.1:1/" },
      ])
    ).toThrow(/twice/u);
    expect(() =>
      validateCompanionConnections([
        { id: "c1", enabled: true, url: "http://127.0.0.1:1" },
        { id: "c1", enabled: true, url: "http://127.0.0.1:2" },
      ])
    ).toThrow(/share an id/u);
    expect(() =>
      validateCompanionConnections(
        Array.from({ length: 5 }, (_, index) => ({ enabled: true, url: `http://127.0.0.1:${index + 1}` }))
      )
    ).toThrow(/Up to 4/u);
    expect(() => validateCompanionConnections([{ enabled: true, url: "http://example.com" }])).toThrow(
      /this computer/u
    );
  });
});

describe("companion answers", () => {
  it("keeps a described action only when it is well formed", () => {
    const description = normalizeDescription({
      protocol: 1,
      name: "  A helper\napp ",
      actions: [
        { id: "polish", label: "Polish", quick: true },
        { id: "polish", label: "Again" },
        { id: "Bad Id", label: "Nope" },
        { id: "enlarge", label: "" },
        { id: "trim", label: "Trim", send: "Trim it", hint: "x".repeat(400), quick: "yes" },
      ],
    });
    expect(description.name).toBe("A helper app");
    expect(description.actions.map((action) => action.id)).toEqual(["polish", "trim"]);
    expect(description.actions[0].send).toBe("Send to Polish");
    expect(description.actions[1].hint).toHaveLength(200);
    // A one-click card button only when the app says so, in so many words.
    expect(description.actions.map((action) => action.quick)).toEqual([true, false]);
    // No targets or withdraw unless declared.
    expect(description.actions[0]).not.toHaveProperty("targets");
    expect(description.actions[0].withdraw).toBe(false);
    expect(() => normalizeDescription({ protocol: 2, actions: [] })).toThrow(/protocol 2/u);
  });

  it("reads an action that sends into targets, with its picker wording", () => {
    const [add] = normalizeDescription(TARGET_DESCRIPTION).actions;
    expect(add).toEqual({
      id: "add",
      label: "Add to project",
      send: "Add to",
      hint: "",
      quick: false,
      withdraw: true,
      targets: { label: "Project", new: "New project…" },
      pick: "Add to project…",
    });
    const [plain] = normalizeDescription({
      protocol: 1,
      actions: [{ id: "add", label: "Add", send: "Add to", targets: { label: "" } }],
    }).actions;
    // Without wording of its own: the send words, and no making new ones.
    expect(plain.pick).toBe("Add to…");
    expect(plain.targets).toEqual({ label: "Target", new: "" });
  });

  it("reads what a companion's tags are called, and each clip's tags", () => {
    const described = normalizeDescription({
      protocol: 1,
      actions: [],
      tags: { label: " Characters\n", hint: "From the references a render was cast with" },
    });
    expect(described.tags).toEqual({ label: "Characters", hint: "From the references a render was cast with" });
    expect(normalizeDescription({ protocol: 1, actions: [], tags: { label: "" } })).not.toHaveProperty("tags");

    const result = normalizeLookup(
      {
        clips: {
          [CLIP_A]: {
            kind: "render",
            chip: null,
            actions: {},
            tags: ["Alba", "Alba", " Bram\t", "", 7, "x".repeat(80), ...Array.from({ length: 70 }, (_, i) => `t${i}`)],
          },
          [CLIP_B]: { kind: "render", chip: null, actions: {}, tags: [] },
        },
      },
      [CLIP_A, CLIP_B],
      []
    );
    const tags = result.get(CLIP_A).tags;
    expect(tags.slice(0, 3)).toEqual(["Alba", "Bram", `${"x".repeat(63)}…`]);
    expect(tags).toHaveLength(64);
    // None: no field at all.
    expect(result.get(CLIP_B)).not.toHaveProperty("tags");
  });

  it("reads lookups for asked-for paths and known actions only", () => {
    const result = normalizeLookup(
      {
        clips: {
          [CLIP_A]: {
            kind: "render",
            chip: { label: "Waiting #3", tone: "neon" },
            actions: {
              polish: { phase: "under-way", why: "In line", position: 3 },
              enlarge: { phase: "sideways" },
              other: { phase: "done" },
            },
          },
          "/elsewhere/unasked.mp4": { kind: "render", chip: { label: "x" } },
        },
      },
      [CLIP_A, CLIP_B],
      ["polish", "enlarge"]
    );
    expect([...result.keys()]).toEqual([CLIP_A]);
    expect(result.get(CLIP_A)).toEqual({
      kind: "render",
      chip: { label: "Waiting #3", tone: "info" },
      actions: { polish: { phase: "under-way", why: "In line", position: 3 } },
    });
  });

  it("reads send outcomes, marking unanswered and unknown ones", () => {
    const outcome = normalizeSendResults(
      {
        results: {
          [CLIP_A]: { result: "sent", why: "", estimate: 90 },
          [CLIP_B]: { result: "queued", why: "odd" },
        },
      },
      [CLIP_A, CLIP_B, "/library/run/clip-c.mp4"]
    );
    expect(outcome.get(CLIP_A)).toEqual({ result: "sent", why: "", estimate: 90 });
    expect(outcome.get(CLIP_B).result).toBe("unknown");
    expect(outcome.get("/library/run/clip-c.mp4").result).toBe("unknown");
  });
});

describe("createCompanionClient against a fake companion", () => {
  let fake;
  afterEach(async () => {
    await fake?.stop();
    fake = null;
  });

  it("describes, looks up and sends as JSON to a local host", async () => {
    fake = createFakeCompanion();
    const url = await fake.start();
    const client = createCompanionClient({ url });

    const description = await client.describe();
    expect(description.actions.map((action) => action.id)).toEqual(["polish", "enlarge"]);

    const before = await client.lookup([CLIP_A], ["polish", "enlarge"]);
    expect(before.get(CLIP_A).actions.polish.phase).toBe("not-sent");

    const dry = await client.send({ action: "polish", paths: [CLIP_A], dryRun: true });
    expect(dry.results.get(CLIP_A)).toMatchObject({ result: "sent", estimate: 60 });
    expect(dry.target).toBeNull();
    expect((await client.lookup([CLIP_A], ["polish"])).get(CLIP_A).actions.polish.phase).toBe(
      "not-sent"
    );

    await client.send({ action: "polish", paths: [CLIP_A] });
    const after = await client.lookup([CLIP_A], ["polish"]);
    expect(after.get(CLIP_A).actions.polish.phase).toBe("under-way");
    expect(after.get(CLIP_A).chip.tone).toBe("progress");

    for (const request of fake.state.requests) {
      expect(request).toMatchObject({ method: "POST", type: "application/json" });
      expect(request.host).toMatch(/^127\.0\.0\.1:\d+$/u);
    }
    // Every send names Video Swarm, so a companion knows what it sent.
    expect(fake.state.requests.at(-2).body).toEqual({
      action: "polish",
      paths: [CLIP_A],
      dry_run: false,
      again: false,
      client: "videoswarm",
    });
  });

  it("lists targets, sends into one or a new one, and takes back only its own adds", async () => {
    fake = createFakeCompanion({ description: TARGET_DESCRIPTION });
    fake.state.targets = [
      { id: "/projects/one", label: "One", detail: "3 clips", current: false },
      { id: "/projects/two", label: "Two", detail: "x".repeat(300), current: true },
      { id: "/projects/three", label: "Three", detail: "", current: true },
      { id: "/projects/one", label: "Duplicate", detail: "", current: false },
      { id: "", label: "No id" },
    ];
    const url = await fake.start();
    const client = createCompanionClient({ url });

    const targets = await client.targets("add");
    expect(targets.map((target) => [target.label, target.current])).toEqual([
      ["One", false],
      ["Two", true],
      ["Three", false],
    ]);
    expect(targets[1].detail).toHaveLength(120);

    // No target: refused, as the protocol asks.
    const none = await client.send({ action: "add", paths: [CLIP_A], dryRun: true });
    expect(none.results.get(CLIP_A)).toMatchObject({ result: "refused", why: "Choose a project" });

    const sent = await client.send({ action: "add", paths: [CLIP_A], target: "/projects/one" });
    expect(sent.results.get(CLIP_A).result).toBe("sent");
    expect(sent.target).toEqual({ id: "/projects/one", label: "One" });
    expect(fake.state.requests.at(-1).body).toMatchObject({ target: "/projects/one", client: "videoswarm" });

    // A new target is made by a real send only, and answered with its id.
    const dryNew = await client.send({ action: "add", paths: [CLIP_B], target: { new: "Fresh" }, dryRun: true });
    expect(dryNew.results.get(CLIP_B).result).toBe("sent");
    expect(fake.state.targets.some((target) => target.label === "Fresh")).toBe(false);
    const made = await client.send({ action: "add", paths: [CLIP_B], target: { new: "Fresh" } });
    expect(made.target).toEqual({ id: "/projects/Fresh", label: "Fresh" });

    const back = await client.withdraw({ action: "add", paths: [CLIP_A, CLIP_B], target: "/projects/one" });
    expect(back.results.get(CLIP_A)).toEqual({ result: "withdrawn", why: "" });
    expect(back.results.get(CLIP_B)).toEqual({ result: "skipped", why: "Not added by this app" });
    expect(fake.state.requests.at(-1).body).toEqual({
      action: "add",
      paths: [CLIP_A, CLIP_B],
      target: "/projects/one",
      client: "videoswarm",
    });

    await expect(
      client.send({ action: "add", paths: [CLIP_A], target: { new: "x".repeat(81) } })
    ).rejects.toMatchObject({ code: "COMPANION_REQUEST_INVALID" });
  });

  it("sends rated clips' stars with every chunk, dry runs included, and leaves unrated ones out", async () => {
    fake = createFakeCompanion();
    const url = await fake.start();
    const client = createCompanionClient({ url });
    const CLIP_B = "/library/b.mp4";
    const ratings = { [CLIP_A]: 4, [CLIP_B]: 0, "/library/not-sent.mp4": 5 };
    await client.send({ action: "polish", paths: [CLIP_A, CLIP_B], ratings, dryRun: true });
    expect(fake.state.requests.at(-1).body).toMatchObject({
      ratings: { [CLIP_A]: 4, [CLIP_B]: 0 },
      dry_run: true,
    });
    // Not whole stars from 0 to 5: left out rather than refused.
    await client.send({ action: "polish", paths: [CLIP_A, CLIP_B], ratings: { [CLIP_A]: 2.5, [CLIP_B]: true } });
    expect(fake.state.requests.at(-1).body).not.toHaveProperty("ratings");
  });

  it("reports a companion that is down or refuses", async () => {
    fake = createFakeCompanion();
    const url = await fake.start();
    const client = createCompanionClient({ url });
    fake.state.refuse = { status: 400, body: { error: "Too many\npaths" } };
    await expect(client.lookup([CLIP_A], [])).rejects.toMatchObject({
      code: "COMPANION_REFUSED",
      message: "Too many paths",
    });
    fake.state.refuse = null;
    fake.state.down = true;
    await expect(client.describe()).rejects.toMatchObject({ code: "COMPANION_UNAVAILABLE" });
  });

  it("refuses oversized requests and bad actions before sending", async () => {
    const client = createCompanionClient({ url: "http://127.0.0.1:9" });
    await expect(
      client.lookup(Array.from({ length: 501 }, (_, index) => `/c/${index}.mp4`), [])
    ).rejects.toMatchObject({ code: "COMPANION_REQUEST_INVALID" });
    await expect(client.send({ action: "../x", paths: [CLIP_A] })).rejects.toMatchObject({
      code: "COMPANION_REQUEST_INVALID",
    });
    await expect(client.lookup([], [])).resolves.toEqual(new Map());
  });
});
