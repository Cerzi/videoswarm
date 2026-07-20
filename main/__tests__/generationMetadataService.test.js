import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  GENERATION_METADATA_PARSER_VERSION,
  buildPersistenceInput,
  createGenerationMetadataService,
  hasSupportedFields,
  toWireMetadata,
} = require("../generation-metadata-service");
const {
  createWanVideoWrapperGraph: wanVideoWrapperGraph,
} = require("./fixtures/wanVideoWrapperGraph.cjs");

function comfyGraph({ prefix = "clip", prompt = "a fox in snowfall" } = {}) {
  return {
    1: {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "wan2.2.safetensors" },
    },
    2: {
      class_type: "LoraLoader",
      inputs: {
        model: ["1", 0],
        clip: ["1", 1],
        lora_name: "motion.safetensors",
        strength_model: 0.8,
        strength_clip: 0.6,
      },
    },
    3: {
      class_type: "CLIPTextEncode",
      inputs: { text: prompt, clip: ["2", 1] },
    },
    4: {
      class_type: "CLIPTextEncode",
      inputs: { text: "blurry", clip: ["2", 1] },
    },
    5: {
      class_type: "KSampler",
      inputs: {
        model: ["2", 0],
        positive: ["3", 0],
        negative: ["4", 0],
        seed: "90071992547409931234",
        steps: 20,
        cfg: 4,
        sampler_name: "euler",
        scheduler: "normal",
      },
    },
    6: {
      class_type: "VAEDecode",
      inputs: { samples: ["5", 0], vae: ["1", 2] },
    },
    7: {
      class_type: "VHS_VideoCombine",
      inputs: { images: ["6", 0], filename_prefix: prefix },
    },
  };
}

function probeResult(overrides = {}) {
  return {
    status: "found",
    available: true,
    found: true,
    payload: { prompt: JSON.stringify(comfyGraph()) },
    sources: {
      prompt: { scope: "format", streamIndex: null, key: "PROMPT" },
    },
    issues: [],
    error: null,
    ...overrides,
  };
}

function createProbe(overrides = {}) {
  return {
    probe: vi.fn(async () => probeResult()),
    cancelOwner: vi.fn(() => 0),
    cancelAll: vi.fn(() => 0),
    shutdown: vi.fn(async () => ({ closed: true })),
    getSnapshot: vi.fn(() => ({ availability: "available" })),
    ...overrides,
  };
}

function mapStoredMetadata(id, input) {
  const sourceKind = input.sourceKind || "sidecar";
  return {
    instanceId: id,
    ...input,
    prompt: input.positivePrompt ?? input.prompt ?? null,
    positivePrompt: input.positivePrompt ?? input.prompt ?? null,
    model: input.model ?? input.models?.[0] ?? null,
    sampler: input.sampler ?? input.samplers?.[0] ?? null,
    sourceImage: input.sourceImage ?? input.sourceImages?.[0] ?? null,
    sampling: input.samplingParameters || {},
    status: input.extractionStatus,
    sourcePath: sourceKind === "sidecar" ? input.sidecarPath : null,
    sourceSize: sourceKind === "sidecar" ? input.sidecarSize : input.mediaSize,
    sourceMtimeMs:
      sourceKind === "sidecar" ? input.sidecarMtimeMs : input.mediaMtimeMs,
  };
}

function createStore(mediaPath) {
  const storedById = new Map();
  const store = {
    getFileInstanceById: vi.fn((id) => ({
      id,
      absolutePath: mediaPath,
      present: true,
    })),
    getGenerationMetadata: vi.fn((id) => storedById.get(id) || null),
    setGenerationMetadata: vi.fn((id, input) => {
      const stored = mapStoredMetadata(id, input);
      storedById.set(id, stored);
      return stored;
    }),
    clearGenerationMetadata: vi.fn((id) => {
      return storedById.delete(id);
    }),
    setStored(id, value) {
      storedById.set(id, value);
    },
    getStored(id) {
      return storedById.get(id) || null;
    },
  };
  return store;
}

describe("generation metadata coordinator", () => {
  let tempDir;
  let mediaPath;
  const services = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-generation-"));
    mediaPath = path.join(tempDir, "clip.mp4");
    fs.writeFileSync(mediaPath, "video bytes");
  });

  afterEach(async () => {
    await Promise.allSettled(services.splice(0).map((service) => service.shutdown()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function service(options = {}) {
    const value = createGenerationMetadataService(options);
    services.push(value);
    return value;
  }

  it("retains valid zero-valued and asset-only generation evidence", () => {
    expect(hasSupportedFields({ seed: 0 })).toBe(true);
    expect(hasSupportedFields({ sourceInputs: [{ name: "input.png" }] })).toBe(true);
    expect(hasSupportedFields({
      assets: [{ type: "vae", name: "vae.safetensors" }],
    })).toBe(true);
    expect(hasSupportedFields({ seed: null, assets: [] })).toBe(false);
  });

  it("marks evidence partial when compact persistence must truncate it", () => {
    const input = buildPersistenceInput({
      analysis: {
        provider: "comfyui",
        origin: { resolution: "traced" },
        positivePrompt: "prompt",
        promptFragments: Array.from({ length: 33 }, (_, index) => ({
          text: `fragment ${index}`,
          role: "positive",
        })),
      },
      sourceKind: "embedded",
      sourceFormat: "mp4",
      sourceLabel: "Embedded · Prompt",
      signature: { size: 10, mtimeMs: 20 },
      readerAvailable: true,
      readerStatus: "found",
      fallbackDiagnostics: [],
      limits: { maxDiagnostics: 32 },
    });

    expect(input).toMatchObject({
      extractionStatus: "partial",
      quality: "partial",
      diagnostics: [expect.objectContaining({ code: "PERSISTENCE_TRUNCATED" })],
    });
  });

  it("labels a deterministic graph-derived prompt without marking it partial", () => {
    const input = buildPersistenceInput({
      analysis: {
        provider: "comfyui",
        origin: { resolution: "traced" },
        positivePrompt: "assembled prompt",
        promptFragments: [{
          role: "positive",
          text: "assembled prompt",
          confidence: "derived",
        }],
      },
      sourceKind: "embedded",
      sourceFormat: "mp4",
      sourceLabel: "Embedded · Prompt",
      signature: { size: 10, mtimeMs: 20 },
      readerAvailable: true,
      readerStatus: "found",
      fallbackDiagnostics: [],
      limits: { maxDiagnostics: 32 },
    });

    expect(input).toMatchObject({
      extractionStatus: "found",
      quality: "derived",
    });
  });

  it("prefers a traced embedded graph and never opens an adjacent sidecar", async () => {
    const sidecarPath = `${mediaPath}.json`;
    fs.writeFileSync(sidecarPath, JSON.stringify({ prompt: "stale sidecar" }));
    const probe = createProbe();
    const openSidecarCandidate = vi.fn(() => {
      throw new Error("sidecar must not be opened for usable embedded metadata");
    });
    const store = createStore(mediaPath);
    const result = await service({ probe, openSidecarCandidate }).getMetadata({
      instanceId: 1,
      ownerId: "request-a",
      scopeId: "profile-a",
      rendererId: 7,
      metadataStore: store,
      authorizePath: vi.fn(),
    });

    expect(result).toMatchObject({
      found: true,
      cached: false,
      status: "found",
      sourceKind: "embedded",
      sourceLabel: "Embedded · Prompt",
      fallbackUsed: false,
      quality: "exact",
      metadata: {
        prompt: "a fox in snowfall",
        negativePrompt: "blurry",
        seed: "90071992547409931234",
        models: ["wan2.2.safetensors"],
        loras: [
          expect.objectContaining({
            name: "motion.safetensors",
            strengthModel: 0.8,
            strengthClip: 0.6,
          }),
        ],
        samplerStages: [expect.objectContaining({ steps: 20, cfg: 4 })],
      },
    });
    expect(openSidecarCandidate).not.toHaveBeenCalled();
    expect(store.setGenerationMetadata).toHaveBeenCalledOnce();
    expect(store.setGenerationMetadata.mock.calls[0][1]).toMatchObject({
      sourceKind: "embedded",
      sourceLabel: "Embedded · Prompt",
      assets: expect.arrayContaining([
        expect.objectContaining({ name: "wan2.2.safetensors" }),
      ]),
      samplerStages: [expect.objectContaining({ nodeId: "5" })],
    });
    expect(JSON.stringify(result)).not.toContain(mediaPath);
    expect(JSON.stringify(result)).not.toContain(sidecarPath);
  });

  it("persists and returns embedded WanVideoWrapper prompt evidence", async () => {
    const probe = createProbe({
      probe: vi.fn(async () => probeResult({
        payload: { prompt: JSON.stringify(wanVideoWrapperGraph()) },
      })),
    });
    const store = createStore(mediaPath);
    const result = await service({ probe }).getMetadata({
      instanceId: 20,
      ownerId: "wan-request",
      scopeId: "profile-a",
      metadataStore: store,
    });

    expect(result).toMatchObject({
      found: true,
      sourceKind: "embedded",
      quality: "exact",
      metadata: {
        positivePrompt: "fixture positive prompt",
        negativePrompt: "fixture negative prompt",
        seed: "424242424242",
        model: "fixture-low.safetensors",
        sampler: "WanVideoSampler",
        models: ["fixture-low.safetensors", "fixture-high.safetensors"],
        vaes: ["fixture-vae.safetensors"],
        textEncoders: ["fixture-t5.safetensors"],
        promptFragments: [
          expect.objectContaining({ role: "positive", nodeId: "3" }),
          expect.objectContaining({ role: "negative", nodeId: "2" }),
        ],
        loras: [
          expect.objectContaining({ name: "fixture-low-base.safetensors", strengthModel: 0.41 }),
          expect.objectContaining({ name: "fixture-low-detail.safetensors", strengthModel: 0.63 }),
          expect.objectContaining({ name: "fixture-high-base.safetensors", strengthModel: 0.37 }),
          expect.objectContaining({ name: "fixture-high-detail.safetensors", strengthModel: 0.72 }),
          expect.objectContaining({ name: "fixture-loader.safetensors", strengthModel: 0.54 }),
        ],
        samplingParameters: expect.objectContaining({
          steps: 11,
          cfg: 1.35,
          denoise: 0.84,
        }),
        samplerStages: [
          expect.objectContaining({ nodeId: "19", role: "contributor" }),
          expect.objectContaining({ nodeId: "20", role: "final" }),
        ],
        sourceInputs: [{ name: "fixture-input.png", kind: "image" }],
      },
    });
    expect(store.setGenerationMetadata.mock.calls[0][1]).toMatchObject({
      parserVersion: GENERATION_METADATA_PARSER_VERSION,
      positivePrompt: "fixture positive prompt",
      samplerStages: [
        expect.objectContaining({ nodeId: "19", classType: "WanVideoSampler" }),
        expect.objectContaining({ nodeId: "20", classType: "WanVideoSampler" }),
      ],
      sourceInputs: [{ name: "fixture-input.png", kind: "image" }],
    });
    expect(JSON.stringify(result)).not.toContain("fixture-disabled");
    expect(JSON.stringify(result)).not.toContain("fixture-disconnected");
  });

  it("falls back to one exact sidecar when the embedded reader is unavailable", async () => {
    const sidecarPath = `${mediaPath}.json`;
    fs.writeFileSync(sidecarPath, JSON.stringify({
      prompt: JSON.stringify(comfyGraph({ prompt: "sidecar prompt" })),
    }));
    const probe = createProbe({
      probe: vi.fn(async () => probeResult({
        status: "unavailable",
        available: false,
        found: false,
        payload: null,
        sources: null,
        error: { code: "FFPROBE_UNAVAILABLE" },
      })),
    });
    const store = createStore(mediaPath);
    const result = await service({ probe }).getMetadata({
      instanceId: 2,
      ownerId: "request-b",
      metadataStore: store,
    });

    expect(result).toMatchObject({
      found: true,
      sourceKind: "sidecar",
      sourceLabel: "Adjacent sidecar",
      fallbackUsed: true,
      readerAvailable: false,
      readerStatus: "unavailable",
      metadata: { prompt: "sidecar prompt" },
    });
    const persisted = store.setGenerationMetadata.mock.calls[0][1];
    expect(persisted.sidecarPath).toBe(path.resolve(sidecarPath));
    expect(result.metadata).not.toHaveProperty("sidecarPath");
    expect(result.metadata).not.toHaveProperty("sourcePath");
    expect(JSON.stringify(result)).not.toContain(path.resolve(sidecarPath));
  });

  it("reuses a matching embedded signature and force bypasses that cache", async () => {
    const probe = createProbe();
    const store = createStore(mediaPath);
    const coordinator = service({ probe });
    const request = { instanceId: 3, scopeId: "profile-a", metadataStore: store };

    const first = await coordinator.getMetadata(request);
    const cached = await coordinator.getMetadata(request);
    expect(first.cached).toBe(false);
    expect(cached).toMatchObject({ cached: true, sourceKind: "embedded" });
    expect(probe.probe).toHaveBeenCalledOnce();

    const forced = await coordinator.getMetadata({ ...request, force: true });
    expect(forced.cached).toBe(false);
    expect(probe.probe).toHaveBeenCalledTimes(2);
    expect(store.setGenerationMetadata).toHaveBeenCalledTimes(2);
  });

  it("deduplicates identical in-flight work and bounds the outer queue", async () => {
    let releaseProbe;
    const probe = createProbe({
      probe: vi.fn(() => new Promise((resolve) => {
        releaseProbe = resolve;
      })),
    });
    const store = createStore(mediaPath);
    const coordinator = service({
      probe,
      limits: { concurrency: 1, maxPending: 1, timeoutMs: 1_000 },
    });
    const first = coordinator.getMetadata({
      instanceId: 10,
      scopeId: "scope",
      metadataStore: store,
    });
    const duplicate = coordinator.getMetadata({
      instanceId: 10,
      scopeId: "scope",
      metadataStore: store,
    });
    expect(duplicate).toBe(first);
    const queued = coordinator.getMetadata({
      instanceId: 11,
      scopeId: "scope",
      metadataStore: store,
    });
    await expect(coordinator.getMetadata({
      instanceId: 12,
      scopeId: "scope",
      metadataStore: store,
    })).rejects.toMatchObject({ code: "GENERATION_METADATA_QUEUE_FULL" });

    await vi.waitFor(() => expect(probe.probe).toHaveBeenCalledOnce());
    releaseProbe(probeResult());
    await expect(first).resolves.toMatchObject({ found: true });
    await vi.waitFor(() => expect(probe.probe).toHaveBeenCalledTimes(2));
    releaseProbe(probeResult());
    await expect(queued).resolves.toMatchObject({ found: true });
  });

  it("cancels renderer-owned probe work and drains every outer slot", async () => {
    let resolveProbe;
    const probe = createProbe({
      probe: vi.fn(() => new Promise((resolve) => {
        resolveProbe = resolve;
      })),
      cancelOwner: vi.fn(() => {
        resolveProbe?.(probeResult({
          status: "cancelled",
          found: false,
          payload: null,
        }));
        return 1;
      }),
    });
    const store = createStore(mediaPath);
    const coordinator = service({ probe });
    const request = coordinator.getMetadata({
      instanceId: 20,
      ownerId: "selection",
      rendererId: 77,
      metadataStore: store,
    });
    const rejection = request.catch((error) => error);
    await vi.waitFor(() => expect(probe.probe).toHaveBeenCalledOnce());

    expect(coordinator.cancelRenderer(77)).toBe(1);
    await expect(rejection).resolves.toMatchObject({
      code: "GENERATION_METADATA_CANCELLED",
    });
    await expect(coordinator.drain()).resolves.toMatchObject({
      active: 0,
      pending: 0,
      inFlight: 0,
    });
    expect(store.setGenerationMetadata).not.toHaveBeenCalled();
    expect(probe.cancelOwner).toHaveBeenCalledWith(
      expect.stringContaining("generation-probe")
    );
  });

  it("publishes only the newest overlapping request for one profile instance", async () => {
    const pending = [];
    const probe = createProbe({
      probe: vi.fn(() => new Promise((resolve) => pending.push(resolve))),
    });
    const store = createStore(mediaPath);
    const coordinator = service({ probe, limits: { concurrency: 2 } });
    const older = coordinator.getMetadata({
      instanceId: 21,
      scopeId: "profile-a",
      metadataStore: store,
    });
    const olderOutcome = older.catch((error) => error);
    await vi.waitFor(() => expect(probe.probe).toHaveBeenCalledOnce());
    const newer = coordinator.getMetadata({
      instanceId: 21,
      scopeId: "profile-a",
      force: true,
      metadataStore: store,
    });
    await vi.waitFor(() => expect(probe.probe).toHaveBeenCalledTimes(2));

    pending[1](probeResult({
      payload: {
        prompt: JSON.stringify(comfyGraph({ prompt: "newer prompt" })),
      },
    }));
    await expect(newer).resolves.toMatchObject({
      metadata: { prompt: "newer prompt" },
    });
    pending[0](probeResult({
      status: "not-found",
      found: false,
      payload: null,
      sources: null,
    }));
    await expect(olderOutcome).resolves.toMatchObject({
      code: "GENERATION_METADATA_SUPERSEDED",
    });

    expect(store.setGenerationMetadata).toHaveBeenCalledOnce();
    expect(store.clearGenerationMetadata).not.toHaveBeenCalled();
    await expect(coordinator.drain()).resolves.toMatchObject({
      active: 0,
      instanceGenerations: 0,
    });
  });

  it("bounds cancellation drain time around an unabortable filesystem call", async () => {
    let releaseStat;
    const realStats = fs.statSync(mediaPath);
    const fsPromises = {
      stat: vi.fn(() => new Promise((resolve) => {
        releaseStat = () => resolve(realStats);
      })),
    };
    const store = createStore(mediaPath);
    const coordinator = service({
      fsPromises,
      probe: createProbe(),
      limits: { drainTimeoutMs: 10 },
    });
    const request = coordinator.getMetadata({
      instanceId: 22,
      metadataStore: store,
    });
    const outcome = request.catch((error) => error);
    await vi.waitFor(() => expect(fsPromises.stat).toHaveBeenCalledOnce());

    await expect(coordinator.cancelAllAndDrain("profile changed")).resolves.toMatchObject({
      active: 1,
      drainTimedOut: true,
    });
    releaseStat();
    await expect(outcome).resolves.toMatchObject({
      code: "GENERATION_METADATA_CANCELLED",
    });
    await expect(coordinator.drain()).resolves.toMatchObject({ active: 0 });
    expect(store.setGenerationMetadata).not.toHaveBeenCalled();
  });

  it("suppresses a completion whose profile ownership becomes stale", async () => {
    let resolveProbe;
    let active = true;
    const probe = createProbe({
      probe: vi.fn(() => new Promise((resolve) => {
        resolveProbe = resolve;
      })),
    });
    const store = createStore(mediaPath);
    const coordinator = service({ probe });
    const request = coordinator.getMetadata({
      instanceId: 30,
      metadataStore: store,
      assertActive: () => {
        if (!active) {
          throw Object.assign(new Error("profile changed"), {
            code: "METADATA_PROFILE_INVALIDATED",
          });
        }
      },
    });
    await vi.waitFor(() => expect(probe.probe).toHaveBeenCalledOnce());
    active = false;
    resolveProbe(probeResult());

    await expect(request).rejects.toMatchObject({
      code: "METADATA_PROFILE_INVALIDATED",
    });
    expect(store.setGenerationMetadata).not.toHaveBeenCalled();
    await expect(coordinator.drain()).resolves.toMatchObject({ active: 0 });
  });

  it("returns unrecognized for workflow-like text without guessing a prompt", async () => {
    fs.writeFileSync(`${mediaPath}.json`, JSON.stringify({
      workflow: {
        nodes: [{ type: "Note", inputs: { text: "not the prompt" } }],
      },
    }));
    const probe = createProbe({
      probe: vi.fn(async () => probeResult({
        status: "not-found",
        found: false,
        payload: null,
        sources: null,
      })),
    });
    const store = createStore(mediaPath);
    const result = await service({ probe }).getMetadata({
      instanceId: 40,
      metadataStore: store,
    });

    expect(result).toMatchObject({
      found: false,
      status: "unrecognized",
      metadata: null,
    });
    expect(JSON.stringify(result)).not.toContain("not the prompt");
    expect(store.setGenerationMetadata).not.toHaveBeenCalled();
    expect(store.clearGenerationMetadata).toHaveBeenCalledWith(40);
  });

  it("preserves bounded generic sidecars whose prompt is plain text", async () => {
    fs.writeFileSync(`${mediaPath}.json`, JSON.stringify({
      prompt: "generic prompt",
      seed: 0,
      sampler: "euler",
    }));
    const probe = createProbe({
      probe: vi.fn(async () => probeResult({
        status: "not-found",
        found: false,
        payload: null,
        sources: null,
      })),
    });
    const store = createStore(mediaPath);
    const result = await service({ probe }).getMetadata({
      instanceId: 41,
      metadataStore: store,
    });

    expect(result).toMatchObject({
      found: true,
      sourceKind: "sidecar",
      status: "partial",
      metadata: {
        prompt: "generic prompt",
        seed: "0",
        sampler: "euler",
      },
    });
  });

  it("sanitizes flat DB assets and every internal source path from the wire", () => {
    const metadata = toWireMetadata({
      sourceKind: "sidecar",
      sourceFormat: "json",
      sourceLabel: "/private/run/clip.mp4.json",
      sourcePath: "/private/run/clip.mp4.json",
      sidecarPath: "/private/run/clip.mp4.json",
      prompt: "safe prompt",
      models: ["/models/wan.safetensors"],
      assets: [
        { type: "checkpoint", name: "/models/wan.safetensors", nodeId: "1" },
        { type: "vae", name: "vae.safetensors", nodeId: "2" },
      ],
      sourceImages: ["/private/input/source.png"],
      samplerStages: [{ nodeId: "3", sampler: "euler", modelRef: { secret: true } }],
      extractionStatus: "found",
      quality: "exact",
    });

    expect(metadata.sourceLabel).toBe("clip.mp4.json");
    expect(metadata.sourceImages).toEqual(["source.png"]);
    expect(metadata.assets).toEqual([
      expect.objectContaining({ type: "checkpoint", name: "wan.safetensors" }),
      expect.objectContaining({ type: "vae", name: "vae.safetensors" }),
    ]);
    expect(metadata.samplerStages).toEqual([
      { nodeId: "3", sampler: "euler" },
    ]);
    expect(metadata).not.toHaveProperty("sourcePath");
    expect(metadata).not.toHaveProperty("sidecarPath");
    expect(JSON.stringify(metadata)).not.toContain("/private/");
    expect(JSON.stringify(metadata)).not.toContain("/models/");
  });

  it("uses the versioned media signature for cached rows", async () => {
    const stats = fs.statSync(mediaPath);
    const store = createStore(mediaPath);
    store.setStored(50, {
      parserVersion: GENERATION_METADATA_PARSER_VERSION,
      sourceKind: "embedded",
      sourceFormat: "mp4",
      sourceLabel: "Embedded · Prompt",
      mediaSize: stats.size,
      mediaMtimeMs: stats.mtimeMs,
      prompt: "cached prompt",
      positivePrompt: "cached prompt",
      extractionStatus: "found",
      quality: "exact",
      provenance: { readerAvailable: true, readerStatus: "found" },
    });
    const probe = createProbe();
    const result = await service({ probe }).getMetadata({
      instanceId: 50,
      metadataStore: store,
    });
    expect(result).toMatchObject({ cached: true, metadata: { prompt: "cached prompt" } });
    expect(probe.probe).not.toHaveBeenCalled();
  });

  it("re-probes metadata cached by an older parser version", async () => {
    const stats = fs.statSync(mediaPath);
    const store = createStore(mediaPath);
    store.setStored(52, {
      parserVersion: GENERATION_METADATA_PARSER_VERSION - 1,
      sourceKind: "embedded",
      sourceFormat: "mp4",
      sourceLabel: "Embedded · Prompt",
      mediaSize: stats.size,
      mediaMtimeMs: stats.mtimeMs,
      extractionStatus: "partial",
      quality: "partial",
      provenance: { readerAvailable: true, readerStatus: "found" },
    });
    const probe = createProbe({
      probe: vi.fn(async () => probeResult({
        payload: { prompt: JSON.stringify(wanVideoWrapperGraph()) },
      })),
    });

    const result = await service({ probe }).getMetadata({
      instanceId: 52,
      metadataStore: store,
    });

    expect(result).toMatchObject({
      cached: false,
      metadata: { positivePrompt: "fixture positive prompt" },
    });
    expect(probe.probe).toHaveBeenCalledOnce();
  });

  it("retries embedded probing after a transient cached sidecar fallback", async () => {
    const stats = fs.statSync(mediaPath);
    const sidecarPath = `${mediaPath}.json`;
    fs.writeFileSync(sidecarPath, JSON.stringify({ prompt: "old fallback" }));
    const store = createStore(mediaPath);
    store.setStored(51, {
      parserVersion: GENERATION_METADATA_PARSER_VERSION,
      sourceKind: "sidecar",
      sourceFormat: "json",
      sourceLabel: "Adjacent sidecar",
      sourcePath: sidecarPath,
      sidecarPath,
      sourceSize: fs.statSync(sidecarPath).size,
      sourceMtimeMs: fs.statSync(sidecarPath).mtimeMs,
      mediaSize: stats.size,
      mediaMtimeMs: stats.mtimeMs,
      prompt: "old fallback",
      positivePrompt: "old fallback",
      extractionStatus: "partial",
      quality: "partial",
      provenance: { readerAvailable: false, readerStatus: "unavailable" },
    });
    const probe = createProbe();
    const result = await service({ probe }).getMetadata({
      instanceId: 51,
      metadataStore: store,
    });

    expect(result).toMatchObject({
      cached: false,
      sourceKind: "embedded",
      metadata: { prompt: "a fox in snowfall" },
    });
    expect(probe.probe).toHaveBeenCalledOnce();
  });
});
