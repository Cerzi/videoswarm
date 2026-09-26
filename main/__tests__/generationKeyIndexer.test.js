import { createRequire } from "module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  GenerationKeyIndexerCancelled,
  createGenerationKeyIndexer,
} = require("../generation-key-indexer");

const KEY_A = `gk1-${"a".repeat(32)}`;
const KEY_B = `gk1-${"b".repeat(32)}`;

function candidate(instanceId, fingerprint, name = `${fingerprint}.mp4`, extra = {}) {
  return {
    instanceId,
    fingerprint,
    absolutePath: `/library/${name}`,
    rootPath: "/library",
    size: 100,
    mtimeMs: 1000,
    ...extra,
  };
}

function createStore(candidates) {
  const evaluated = new Map();
  return {
    evaluated,
    writes: [],
    countGenerationKeyCandidates: vi.fn(({ instanceIds }) =>
      new Set(
        candidates
          .filter((row) => !instanceIds || instanceIds.includes(row.instanceId))
          .map((row) => row.fingerprint)
      ).size
    ),
    listGenerationKeyCandidates: vi.fn(({ instanceIds, afterInstanceId, limit }) =>
      candidates
        .filter(
          (row) =>
            row.instanceId > afterInstanceId &&
            !evaluated.has(row.fingerprint) &&
            (!instanceIds || instanceIds.includes(row.instanceId))
        )
        .slice(0, limit)
    ),
    listEvaluatedGenerationKeys: vi.fn((instanceIds) =>
      candidates
        .filter((row) => instanceIds.includes(row.instanceId) && evaluated.has(row.fingerprint))
        .map((row) => ({ fingerprint: row.fingerprint, generationKey: evaluated.get(row.fingerprint) }))
    ),
    setGenerationKeys: vi.fn(function setGenerationKeys(entries, { assertActive }) {
      assertActive();
      entries.forEach((entry) => evaluated.set(entry.fingerprint, entry.generationKey));
      this.writes.push(entries);
    }),
  };
}

function createFs(overrides = {}) {
  return {
    realpath: vi.fn(async (target) => target),
    lstat: vi.fn(async () => ({ isFile: () => true, size: 100, mtimeMs: 1000 })),
    ...overrides,
  };
}

function setup({ candidates, results = {}, probe, fsPromises, limits, active = () => true } = {}) {
  const store = createStore(candidates);
  const readIsoPayload = vi.fn(async (filePath) => results[filePath] || { status: "not-found" });
  const indexer = createGenerationKeyIndexer({
    readIsoPayload,
    computeKey: (prompt) => (prompt === "prompt-a" ? KEY_A : prompt === "prompt-b" ? KEY_B : null),
    fsPromises: fsPromises || createFs(),
    probeFactory: () => probe,
    yieldToEventLoop: () => Promise.resolve(),
    limits,
  });
  const published = [];
  const context = {
    metadataStore: store,
    assertActive: vi.fn(() => {
      if (!active()) throw new Error("profile changed");
    }),
  };
  const start = (scope = { instanceIds: candidates.map((row) => row.instanceId) }, owner = 1) =>
    indexer.start(owner, { context, scope, publish: (payload) => published.push(payload) });
  return { store, indexer, published, start, readIsoPayload, context };
}

const found = (prompt) => ({ status: "found", payload: { prompt } });

describe("generation key indexer", () => {
  it("keys candidates, persists definitive outcomes and publishes them", async () => {
    const { store, indexer, published, start } = setup({
      candidates: [
        candidate(1, "fa"),
        candidate(2, "fb"),
        candidate(3, "fa", "copy-of-a.mp4"),
        candidate(4, "fc"),
        candidate(5, "fd"),
      ],
      results: {
        "/library/fa.mp4": found("prompt-a"),
        "/library/fb.mp4": found("unkeyable"),
        "/library/fc.mp4": { status: "not-found" },
        "/library/fd.mp4": { status: "changed" },
      },
    });
    const started = start();
    expect(started).toMatchObject({ scope: "collection", pending: 4 });
    await indexer.drain();

    expect(Object.fromEntries(store.evaluated)).toEqual({ fa: KEY_A, fb: null, fc: null });
    const last = published.at(-1);
    expect(last).toMatchObject({ jobId: started.jobId, done: true, processed: 4, keyed: 1 });
    const updates = published.flatMap((payload) => payload.updates);
    expect(updates).toEqual([
      { fingerprint: "fa", generationKey: KEY_A, checked: true },
      { fingerprint: "fb", generationKey: null, checked: true },
      { fingerprint: "fc", generationKey: null, checked: true },
      { fingerprint: "fd", generationKey: null, checked: false },
    ]);
  });

  it("first republishes keys that are already evaluated for the requested instances", async () => {
    const { store, indexer, published, start, readIsoPayload } = setup({
      candidates: [candidate(1, "fa"), candidate(2, "fb")],
    });
    store.evaluated.set("fa", KEY_A);
    start();
    await indexer.drain();
    expect(readIsoPayload).toHaveBeenCalledTimes(1);
    expect(published[0].updates[0]).toEqual({ fingerprint: "fa", generationKey: KEY_A, checked: true });
  });

  it("publishes and writes in bounded batches", async () => {
    const candidates = Array.from({ length: 5 }, (_, index) => candidate(index + 1, `f${index}`));
    const { store, indexer, published, start } = setup({
      candidates,
      limits: { writeBatch: 2, pageSize: 2 },
    });
    start();
    await indexer.drain();
    expect(store.writes.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(published.map((payload) => payload.done)).toEqual([false, false, true]);
  });

  it("never keys a file whose real path escapes its root", async () => {
    const { store, indexer, readIsoPayload, start } = setup({
      candidates: [candidate(1, "fa")],
      results: { "/library/fa.mp4": found("prompt-a") },
      fsPromises: createFs({ realpath: vi.fn(async (target) => (target === "/library" ? "/library" : "/elsewhere/fa.mp4")) }),
    });
    start();
    await indexer.drain();
    expect(readIsoPayload).not.toHaveBeenCalled();
    expect(store.evaluated.size).toBe(0);
  });

  it("uses the probe for non-ISO containers and checks the signature around it", async () => {
    const probe = {
      probe: vi.fn(async (filePath) =>
        filePath.endsWith("a.webm")
          ? found("prompt-b")
          : filePath.endsWith("b.webm")
            ? { status: "unavailable" }
            : { status: "not-found" }
      ),
      cancelOwner: vi.fn(),
      shutdown: vi.fn(),
    };
    const calls = new Map();
    const fsPromises = createFs({
      lstat: vi.fn(async (filePath) => {
        calls.set(filePath, (calls.get(filePath) || 0) + 1);
        const changed = filePath.endsWith("c.webm") && calls.get(filePath) > 1;
        return { isFile: () => true, size: changed ? 999 : 100, mtimeMs: 1000 };
      }),
    });
    const { store, indexer, start } = setup({
      candidates: [
        candidate(1, "fa", "a.webm"),
        candidate(2, "fb", "b.webm"),
        candidate(3, "fc", "c.webm"),
      ],
      probe,
      fsPromises,
    });
    start();
    await indexer.drain();
    expect(Object.fromEntries(store.evaluated)).toEqual({ fa: KEY_B });
    expect(probe.probe).toHaveBeenCalledTimes(3);
  });

  it("lets a newer request supersede the owner's running job", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { store, indexer, published, start, readIsoPayload } = setup({
      candidates: [candidate(1, "fa"), candidate(2, "fb")],
    });
    readIsoPayload.mockImplementationOnce(async () => {
      await gate;
      return found("prompt-a");
    });
    const first = start({ instanceIds: [1] });
    const second = start({ instanceIds: [2] });
    expect(second.jobId).not.toBe(first.jobId);
    release();
    await indexer.drain();
    expect(store.evaluated.has("fa")).toBe(false);
    expect(published.every((payload) => payload.jobId === second.jobId)).toBe(true);
    expect(store.evaluated.has("fb")).toBe(true);
  });

  it("stops without writing when the profile generation changes", async () => {
    let active = true;
    const { store, indexer, start, readIsoPayload } = setup({
      candidates: [candidate(1, "fa")],
      active: () => active,
    });
    readIsoPayload.mockImplementationOnce(async () => {
      active = false;
      return found("prompt-a");
    });
    start();
    await indexer.drain();
    expect(store.setGenerationKeys).not.toHaveBeenCalled();
  });

  it("cancels, drains and shuts down", async () => {
    const probe = { probe: vi.fn(), cancelOwner: vi.fn(), shutdown: vi.fn(async () => {}) };
    const { indexer, start, published } = setup({
      candidates: [candidate(1, "fa", "a.webm")],
      probe,
      limits: { drainTimeoutMs: 10 },
    });
    probe.probe.mockImplementation(() => new Promise(() => {}));
    start();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(indexer.cancelOwner(1)).toBe(1);
    expect(probe.cancelOwner).toHaveBeenCalled();
    const drained = await indexer.drain({ timeoutMs: 10 });
    expect(drained.drainTimedOut).toBe(true);
    expect(published).toEqual([]);
    await indexer.shutdown();
    expect(probe.shutdown).toHaveBeenCalled();
    expect(() => start()).toThrow(GenerationKeyIndexerCancelled);
  });

  it("validates its inputs", () => {
    const { indexer, context } = setup({ candidates: [] });
    expect(() => indexer.start(1, { context, scope: {}, publish: () => {} })).toThrow(TypeError);
    expect(() => indexer.start(1, { context: {}, scope: { library: true }, publish: () => {} })).toThrow(
      TypeError
    );
    expect(indexer.start(1, { context, scope: { library: true }, publish: () => {} })).toMatchObject({
      scope: "library",
      pending: 0,
    });
  });
});
