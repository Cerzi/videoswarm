const fs = require("fs");
const path = require("path");
const { createEmbeddedMetadataProbe } = require("./embedded-metadata-probe");
const {
  DEFAULT_LIMITS: SIDECAR_LIMITS,
  openSidecarCandidate,
  parseSidecarText,
  readFileHandleBounded,
} = require("./sidecar-metadata");
const {
  parseComfyGenerationPayload,
} = require("./comfy-generation-parser");

const GENERATION_METADATA_PARSER_VERSION = 2;
const GENERATION_METADATA_SERVICE_LIMITS = Object.freeze({
  concurrency: 2,
  maxPending: 64,
  timeoutMs: 12_000,
  drainTimeoutMs: 2_000,
  maxBytes: 2 * 1024 * 1024,
  maxDiagnostics: 32,
});
const GENERATION_PERSISTENCE_LIMITS = Object.freeze({
  listEntries: 32,
  promptBytes: 32 * 1024,
  promptFragmentBytes: 8 * 1024,
  jsonBytes: 32 * 1024,
});

class GenerationMetadataServiceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GenerationMetadataServiceError";
    this.code = code;
    Object.assign(this, details);
  }
}

function finiteInteger(value, fallback, minimum = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.floor(numeric));
}

function defaultClock() {
  return {
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
  };
}

function cancellationError(code, message) {
  return new GenerationMetadataServiceError(code, message, { cancelled: true });
}

function normalizeOwner(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function mediaSignature(stats) {
  return {
    size: Math.max(0, Math.round(Number(stats?.size) || 0)),
    mtimeMs: Math.max(0, Number(stats?.mtimeMs) || 0),
  };
}

function sameNumber(left, right) {
  return Number(left || 0) === Number(right || 0);
}

function sameMediaSignature(left, right) {
  return sameNumber(left?.size, right?.size) &&
    sameNumber(left?.mtimeMs, right?.mtimeMs);
}

function extensionLabel(filePath, pathImpl = path) {
  return pathImpl.extname(filePath).replace(/^\./u, "").toLowerCase() || "media";
}

function crossPlatformBasename(value, pathImpl = path) {
  if (typeof value !== "string" || !value.trim()) return null;
  const source = value.trim();
  return pathImpl.win32.basename(pathImpl.posix.basename(source));
}

function safeSourceName(value, pathImpl = path) {
  if (typeof value !== "string" || !value.trim()) return null;
  const source = value.trim();
  if (pathImpl.isAbsolute(source) || pathImpl.win32.isAbsolute(source)) {
    return crossPlatformBasename(source, pathImpl);
  }
  return source.slice(0, 2048);
}

function embeddedSourceLabel(metadataKey) {
  const rawKey = String(metadataKey || "metadata")
    .replace(/[_-]+/gu, " ")
    .trim()
    .slice(0, 80);
  const key = rawKey
    ? `${rawKey.charAt(0).toUpperCase()}${rawKey.slice(1).toLowerCase()}`
    : "Metadata";
  return `Embedded · ${key}`;
}

function cleanDiagnostic(value) {
  if (typeof value === "string") {
    return { message: value.slice(0, 2048) };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const key of ["code", "message", "nodeId", "classType", "role", "field"]) {
    const entry = value[key];
    if (typeof entry === "string" || typeof entry === "number") {
      result[key] = String(entry).slice(0, 2048);
    }
  }
  return Object.keys(result).length ? result : null;
}

function cleanDiagnostics(values, limit) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const diagnostic = cleanDiagnostic(value);
    if (diagnostic) result.push(diagnostic);
    if (result.length >= limit) break;
  }
  return result;
}

function diagnostic(code, message) {
  return { code, message };
}

function compactSampling(analysis) {
  const stages = Array.isArray(analysis?.samplerStages)
    ? analysis.samplerStages
    : [];
  const stage = [...stages].reverse().find((entry) => entry?.role === "final") ||
    [...stages].reverse().find(Boolean) || null;
  if (!stage) return {};
  const result = {};
  for (const key of [
    "sampler",
    "scheduler",
    "steps",
    "cfg",
    "denoise",
    "startStep",
    "endStep",
  ]) {
    const value = stage[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      result[key] = value;
    }
  }
  return result;
}

function assetNames(analysis, key) {
  const direct = Array.isArray(analysis?.[key]) ? analysis[key] : [];
  if (direct.length) return direct;
  const assets = Array.isArray(analysis?.assets?.[key])
    ? analysis.assets[key]
    : [];
  return assets
    .map((entry) => (typeof entry === "string" ? entry : entry?.name))
    .filter(Boolean);
}

function compactAssets(analysis, pathImpl = path) {
  const groups = [
    ["models", "model"],
    ["vaes", "vae"],
    ["textEncoders", "text-encoder"],
  ];
  const result = [];
  const append = (entry, fallbackCategory = null) => {
    if (result.length >= 32) return;
    const source = typeof entry === "string" ? { name: entry } : entry;
    const name = safeSourceName(source?.name, pathImpl);
    if (!name) return;
    const type = String(source?.type || source?.kind || fallbackCategory || "other")
      .slice(0, 64);
    const inferredCategory = ["vae"].includes(type)
      ? "vae"
      : ["text-encoder", "textencoder", "clip"].includes(type)
        ? "text-encoder"
        : ["model", "checkpoint", "unet", "diffusion-model"].includes(type)
          ? "model"
          : null;
    const category = String(
      source?.category || fallbackCategory || inferredCategory || "other"
    ).slice(0, 64);
    result.push({
      type,
      category,
      name,
      ...(source?.nodeId !== null && source?.nodeId !== undefined
        ? { nodeId: String(source.nodeId).slice(0, 256) }
        : {}),
    });
  };
  if (Array.isArray(analysis?.assets)) {
    for (const entry of analysis.assets) append(entry);
    return result;
  }
  for (const [key, category] of groups) {
    const entries = Array.isArray(analysis?.assets?.[key])
      ? analysis.assets[key]
      : [];
    for (const entry of entries) {
      append(entry, category);
    }
  }
  return result;
}

function compactSamplerStages(analysis) {
  const result = [];
  for (const stage of Array.isArray(analysis?.samplerStages)
    ? analysis.samplerStages
    : []) {
    if (!stage || typeof stage !== "object" || result.length >= 32) continue;
    const compact = {};
    for (const key of [
      "role",
      "nodeId",
      "classType",
      "seed",
      "sampler",
      "scheduler",
      "steps",
      "cfg",
      "denoise",
      "startStep",
      "endStep",
    ]) {
      const value = stage[key];
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        compact[key] = typeof value === "string" ? value.slice(0, 2048) : value;
      }
    }
    if (Object.keys(compact).length) result.push(compact);
  }
  return result;
}

function compactSourceInputs(analysis, pathImpl = path) {
  const result = [];
  const seen = new Set();
  const add = (entry, fallbackKind) => {
    if (result.length >= 32) return;
    const source = typeof entry === "string" ? { name: entry } : entry;
    const name = safeSourceName(source?.name, pathImpl);
    if (!name) return;
    const kind = String(source?.kind || fallbackKind || "source").slice(0, 64);
    const identity = `${kind}\u0000${name}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    result.push({ name, kind });
  };
  for (const entry of Array.isArray(analysis?.sourceInputs)
    ? analysis.sourceInputs
    : []) {
    add(entry, "source");
  }
  for (const entry of Array.isArray(analysis?.sourceImages)
    ? analysis.sourceImages
    : []) {
    add(entry, "image");
  }
  return result;
}

function hasSupportedFields(value) {
  if (!value || typeof value !== "object") return false;
  const scalarFields = [
    value.positivePrompt,
    value.negativePrompt,
    value.prompt,
    value.seed,
    value.model,
    value.sampler,
    value.generationRun,
  ];
  if (scalarFields.some((entry) => (
    entry !== null && entry !== undefined && entry !== ""
  ))) {
    return true;
  }
  const arrays = [
    value.promptFragments,
    value.samplerStages,
    value.models,
    value.samplers,
    value.sourceImages,
    value.sourceInputs,
    value.vaes,
    value.textEncoders,
    value.loras,
    value.assets?.models,
    value.assets?.vaes,
    value.assets?.textEncoders,
    value.assets?.loras,
  ];
  if (arrays.some((entries) => Array.isArray(entries) && entries.length > 0)) {
    return true;
  }
  return Array.isArray(value.assets) && value.assets.length > 0;
}

function persistenceWouldTruncate(analysis, fallbackDiagnostics = []) {
  const overListLimit = (value) => Array.isArray(value) &&
    value.length > GENERATION_PERSISTENCE_LIMITS.listEntries;
  const prompt = analysis?.positivePrompt ?? analysis?.prompt;
  if (
    typeof prompt === "string" &&
    Buffer.byteLength(prompt, "utf8") > GENERATION_PERSISTENCE_LIMITS.promptBytes
  ) {
    return true;
  }
  const fragments = Array.isArray(analysis?.promptFragments)
    ? analysis.promptFragments
    : [];
  if (overListLimit(fragments)) return true;
  if (fragments.some((entry) => {
    const text = typeof entry === "string" ? entry : entry?.text;
    return typeof text === "string" &&
      Buffer.byteLength(text, "utf8") >
        GENERATION_PERSISTENCE_LIMITS.promptFragmentBytes;
  })) {
    return true;
  }
  try {
    if (
      Buffer.byteLength(JSON.stringify(fragments), "utf8") >
      GENERATION_PERSISTENCE_LIMITS.jsonBytes
    ) {
      return true;
    }
  } catch {
    return true;
  }
  const assetCount = Array.isArray(analysis?.assets)
    ? analysis.assets.length
    : ["models", "vaes", "textEncoders"]
      .reduce((total, key) => (
        total + (Array.isArray(analysis?.assets?.[key])
          ? analysis.assets[key].length
          : 0)
      ), 0);
  if (assetCount > GENERATION_PERSISTENCE_LIMITS.listEntries) return true;
  return [
    analysis?.models,
    analysis?.samplers,
    analysis?.assets?.loras,
    analysis?.loras,
    analysis?.samplerStages,
    analysis?.sourceInputs,
    analysis?.sourceImages,
    analysis?.diagnostics,
    fallbackDiagnostics,
  ].some(overListLimit);
}

function extractionQuality(analysis, generic = false, truncated = false) {
  if (generic || truncated) return { status: "partial", quality: "partial" };
  const exact = analysis?.origin?.resolution === "traced";
  return {
    status: exact ? "found" : "partial",
    quality: exact ? "exact" : "partial",
  };
}

function genericAnalysis(metadata) {
  return {
    provider: "generic-json",
    origin: { resolution: "partial", metadataKey: "generic" },
    positivePrompt: metadata.prompt || null,
    negativePrompt: null,
    promptFragments: [],
    samplerStages: [],
    assets: { models: [], vaes: [], textEncoders: [], loras: [] },
    sourceInputs: [],
    diagnostics: [],
    prompt: metadata.prompt || null,
    seed: metadata.seed ?? null,
    model: metadata.model ?? null,
    models: Array.isArray(metadata.models) ? metadata.models : [],
    sampler: metadata.sampler ?? null,
    samplers: Array.isArray(metadata.samplers) ? metadata.samplers : [],
    sourceImage: metadata.sourceImage ?? null,
    sourceImages: Array.isArray(metadata.sourceImages)
      ? metadata.sourceImages
      : [],
    generationRun: metadata.generationRun ?? null,
  };
}

function buildPersistenceInput({
  analysis,
  sourceKind,
  sourceFormat,
  sourceLabel,
  sourcePath = null,
  sourceSize = 0,
  sourceMtimeMs = 0,
  signature,
  readerAvailable,
  readerStatus,
  fallbackDiagnostics,
  generic = false,
  limits,
  pathImpl = path,
}) {
  const truncated = persistenceWouldTruncate(analysis, fallbackDiagnostics);
  const quality = extractionQuality(analysis, generic, truncated);
  const diagnostics = cleanDiagnostics(
    [
      ...(fallbackDiagnostics || []),
      ...(analysis?.diagnostics || []),
      ...(truncated
        ? [diagnostic(
            "PERSISTENCE_TRUNCATED",
            "Some generation evidence exceeded the compact cache limit"
          )]
        : []),
    ],
    limits.maxDiagnostics
  );
  const safeAssetNames = (key) => assetNames(analysis, key)
    .map((entry) => safeSourceName(entry, pathImpl))
    .filter(Boolean);
  const models = safeAssetNames("models");
  const vaes = safeAssetNames("vaes");
  const textEncoders = safeAssetNames("textEncoders");
  const samplers = Array.isArray(analysis?.samplers) ? analysis.samplers : [];
  const sourceInputs = compactSourceInputs(analysis, pathImpl);
  // The storage schema keeps source names in one bounded list. Include video
  // inputs as well as images so useful workflow ancestry is not discarded.
  const sourceImages = sourceInputs.map((entry) => entry.name);
  const rawLoras = Array.isArray(analysis?.assets?.loras)
    ? analysis.assets.loras
    : Array.isArray(analysis?.loras)
      ? analysis.loras
      : [];
  const loras = rawLoras
    .map((entry) => {
      const source = typeof entry === "string" ? { name: entry } : entry;
      const name = safeSourceName(source?.name, pathImpl);
      return name && source && typeof source === "object"
        ? { ...source, name }
        : null;
    })
    .filter(Boolean)
    .slice(0, 32);
  const origin = analysis?.origin || {};
  return {
    parserVersion: GENERATION_METADATA_PARSER_VERSION,
    sourceKind,
    sourceFormat,
    sourceLabel,
    mediaSize: signature.size,
    mediaMtimeMs: signature.mtimeMs,
    ...(sourceKind === "sidecar"
      ? {
          sidecarPath: sourcePath,
          sidecarSize: sourceSize,
          sidecarMtimeMs: sourceMtimeMs,
        }
      : {}),
    provenance: {
      provider: analysis?.provider || "unknown",
      carrier: origin.carrier || sourceFormat,
      metadataKey: origin.metadataKey || null,
      resolution: origin.resolution || (generic ? "partial" : "unknown"),
      readerAvailable: Boolean(readerAvailable),
      readerStatus,
    },
    positivePrompt: analysis?.positivePrompt ?? analysis?.prompt ?? null,
    negativePrompt: analysis?.negativePrompt ?? null,
    promptFragments: Array.isArray(analysis?.promptFragments)
      ? analysis.promptFragments
      : [],
    seed: analysis?.seed ?? null,
    model: analysis?.model ?? models[0] ?? null,
    models,
    assets: compactAssets(analysis, pathImpl),
    vaes,
    textEncoders,
    sampler: analysis?.sampler ?? samplers[0] ?? null,
    samplers,
    loras,
    samplingParameters: compactSampling(analysis),
    samplerStages: compactSamplerStages(analysis),
    sourceImage: sourceImages[0] ?? null,
    sourceImages,
    sourceInputs,
    generationRun: analysis?.generationRun ?? null,
    diagnostics,
    extractionStatus: quality.status,
    quality: quality.quality,
  };
}

function safeProvenance(value) {
  const source = value && typeof value === "object" ? value : {};
  const result = {};
  for (const key of [
    "provider",
    "carrier",
    "metadataKey",
    "resolution",
    "readerStatus",
  ]) {
    const entry = source[key];
    if (typeof entry === "string" && entry) result[key] = entry.slice(0, 1024);
  }
  if (typeof source.readerAvailable === "boolean") {
    result.readerAvailable = source.readerAvailable;
  }
  return result;
}

function toWireMetadata(metadata, pathImpl = path, maxDiagnostics = 32) {
  if (!metadata || typeof metadata !== "object") return null;
  const sourceKind = ["embedded", "sidecar"].includes(metadata.sourceKind)
    ? metadata.sourceKind
    : "unknown";
  const sourceLabel = crossPlatformBasename(metadata.sourceLabel, pathImpl);
  const sourceImages = (Array.isArray(metadata.sourceImages)
    ? metadata.sourceImages
    : [])
    .map((entry) => safeSourceName(entry, pathImpl))
    .filter(Boolean)
    .slice(0, 32);
  const sourceInputs = compactSourceInputs(
    {
      sourceInputs: Array.isArray(metadata.sourceInputs)
        ? metadata.sourceInputs
        : sourceImages.map((name) => ({ name, kind: "source" })),
    },
    pathImpl
  );
  const diagnostics = cleanDiagnostics(metadata.diagnostics, maxDiagnostics);
  const sampling = metadata.samplingParameters || metadata.sampling || {};
  const models = (Array.isArray(metadata.models) ? metadata.models : [])
    .map((entry) => safeSourceName(entry, pathImpl))
    .filter(Boolean)
    .slice(0, 32);
  const loras = (Array.isArray(metadata.loras) ? metadata.loras : [])
    .map((entry) => {
      const source = typeof entry === "string" ? { name: entry } : entry;
      const name = safeSourceName(source?.name, pathImpl);
      if (!name || !source || typeof source !== "object") return null;
      return {
        name,
        ...(Number.isFinite(Number(source.strengthModel)) &&
        source.strengthModel !== null && source.strengthModel !== ""
          ? { strengthModel: Number(source.strengthModel) }
          : {}),
        ...(Number.isFinite(Number(source.strengthClip)) &&
        source.strengthClip !== null && source.strengthClip !== ""
          ? { strengthClip: Number(source.strengthClip) }
          : {}),
        ...(source.nodeId !== null && source.nodeId !== undefined
          ? { nodeId: String(source.nodeId).slice(0, 256) }
          : {}),
        ...(Array.isArray(source.appliedTo)
          ? {
              appliedTo: source.appliedTo
                .filter((value) => typeof value === "string")
                .slice(0, 8),
            }
          : {}),
      };
    })
    .filter(Boolean)
    .slice(0, 32);
  const result = {
    sourceKind,
    sourceFormat: typeof metadata.sourceFormat === "string"
      ? metadata.sourceFormat.slice(0, 128)
      : null,
    sourceLabel,
    provenance: safeProvenance(metadata.provenance),
    prompt: metadata.positivePrompt ?? metadata.prompt ?? null,
    positivePrompt: metadata.positivePrompt ?? metadata.prompt ?? null,
    negativePrompt: metadata.negativePrompt ?? null,
    promptFragments: Array.isArray(metadata.promptFragments)
      ? metadata.promptFragments.slice(0, 32)
      : [],
    seed: metadata.seed ?? null,
    model: models[0] ?? safeSourceName(metadata.model, pathImpl),
    models,
    assets: compactAssets(metadata, pathImpl),
    vaes: (Array.isArray(metadata.vaes) ? metadata.vaes : [])
      .map((entry) => safeSourceName(entry, pathImpl))
      .filter(Boolean)
      .slice(0, 32),
    textEncoders: (Array.isArray(metadata.textEncoders)
      ? metadata.textEncoders
      : [])
      .map((entry) => safeSourceName(entry, pathImpl))
      .filter(Boolean)
      .slice(0, 32),
    sampler: metadata.sampler ?? null,
    samplers: Array.isArray(metadata.samplers) ? metadata.samplers.slice(0, 32) : [],
    loras,
    samplingParameters: sampling && typeof sampling === "object" ? sampling : {},
    samplerStages: compactSamplerStages(metadata),
    scheduler: metadata.scheduler ?? sampling?.scheduler ?? null,
    steps: metadata.steps ?? sampling?.steps ?? null,
    cfg: metadata.cfg ?? sampling?.cfg ?? null,
    denoise: metadata.denoise ?? sampling?.denoise ?? null,
    sourceImage: sourceImages[0] ?? null,
    sourceImages,
    sourceInputs,
    generationRun: metadata.generationRun ?? null,
    diagnostics,
    extractionStatus: metadata.extractionStatus || metadata.status || "found",
    quality: metadata.quality || metadata.confidence || "partial",
  };
  return result;
}

function serviceResult({
  instanceId,
  stored = null,
  cached = false,
  readerAvailable = true,
  readerStatus = "unknown",
  status = null,
  quality = null,
  diagnostics = null,
  pathImpl = path,
  limits = GENERATION_METADATA_SERVICE_LIMITS,
}) {
  const metadata = toWireMetadata(stored, pathImpl, limits.maxDiagnostics);
  const finalStatus = status || metadata?.extractionStatus || "none";
  const finalQuality = quality || metadata?.quality || "unknown";
  const safeDiagnostics = diagnostics
    ? cleanDiagnostics(diagnostics, limits.maxDiagnostics)
    : metadata?.diagnostics || [];
  const found = Boolean(metadata && (finalStatus === "found" || finalStatus === "partial"));
  const sourceKind = metadata?.sourceKind || null;
  const sourceFormat = metadata?.sourceFormat || null;
  const sourceLabel = metadata?.sourceLabel || null;
  return {
    instanceId,
    found,
    cached: Boolean(cached),
    readerAvailable: Boolean(readerAvailable),
    readerStatus,
    status: finalStatus,
    sourceKind,
    sourceFormat,
    sourceLabel,
    fallbackUsed: sourceKind === "sidecar",
    source: metadata
      ? {
          kind: sourceKind,
          format: sourceFormat,
          label: sourceLabel,
        }
      : null,
    quality: finalQuality,
    diagnostics: safeDiagnostics,
    metadata: found ? metadata : null,
    generationMetadata: found ? metadata : null,
  };
}

class GenerationMetadataService {
  constructor(options = {}) {
    this.fs = options.fsPromises || fs.promises;
    this.path = options.pathImpl || path;
    this.clock = options.clock || defaultClock();
    this.limits = {
      ...GENERATION_METADATA_SERVICE_LIMITS,
      ...(options.limits || {}),
    };
    this.concurrency = Math.min(
      2,
      finiteInteger(this.limits.concurrency, 2, 1)
    );
    this.maxPending = finiteInteger(this.limits.maxPending, 64, 0);
    this.timeoutMs = finiteInteger(this.limits.timeoutMs, 12_000, 1);
    this.openSidecarCandidate =
      options.openSidecarCandidate || openSidecarCandidate;
    this.readFileHandleBounded =
      options.readFileHandleBounded || readFileHandleBounded;
    this.parseSidecarText = options.parseSidecarText || parseSidecarText;
    this.parseComfyGenerationPayload =
      options.parseComfyGenerationPayload || parseComfyGenerationPayload;
    this.probe = options.probe || createEmbeddedMetadataProbe(options.probeOptions);
    this.queue = [];
    this.active = new Set();
    this.jobs = new Set();
    this.inFlight = new Map();
    this.latestInstanceGeneration = new Map();
    this.drainWaiters = new Set();
    this.sequence = 0;
    this.closed = false;
    this.shutdownPromise = null;
  }

  getMetadata(request = {}) {
    if (this.closed) {
      return Promise.reject(
        cancellationError(
          "GENERATION_METADATA_SHUTDOWN",
          "Generation metadata service is shut down"
        )
      );
    }
    const instanceId = Number(request.instanceId);
    if (!Number.isSafeInteger(instanceId) || instanceId <= 0) {
      return Promise.reject(new TypeError("A positive file instance id is required"));
    }
    if (
      !request.metadataStore?.getFileInstanceById ||
      !request.metadataStore?.getGenerationMetadata ||
      !request.metadataStore?.setGenerationMetadata
    ) {
      return Promise.reject(new TypeError("A generation metadata store is required"));
    }
    if (request.authorizePath !== undefined && typeof request.authorizePath !== "function") {
      return Promise.reject(new TypeError("authorizePath must be a function"));
    }
    if (request.assertActive !== undefined && typeof request.assertActive !== "function") {
      return Promise.reject(new TypeError("assertActive must be a function"));
    }

    const ownerId = normalizeOwner(request.ownerId, "default");
    const scopeId = normalizeOwner(request.scopeId, ownerId);
    const rendererId = normalizeOwner(request.rendererId, null);
    const force = request.force === true;
    const key = `${scopeId}:${instanceId}:${force ? "force" : "normal"}`;
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    if (this.active.size >= this.concurrency && this.queue.length >= this.maxPending) {
      return Promise.reject(
        new GenerationMetadataServiceError(
          "GENERATION_METADATA_QUEUE_FULL",
          "Generation metadata queue is full"
        )
      );
    }
    const instanceGenerationKey = `${scopeId}\u0000${instanceId}`;
    const instanceGeneration =
      (this.latestInstanceGeneration.get(instanceGenerationKey) || 0) + 1;
    this.latestInstanceGeneration.set(instanceGenerationKey, instanceGeneration);

    let resolvePromise;
    let rejectPromise;
    const basePromise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const job = {
      id: ++this.sequence,
      key,
      ownerId,
      scopeId,
      rendererId,
      instanceId,
      instanceGenerationKey,
      instanceGeneration,
      force,
      metadataStore: request.metadataStore,
      assertActive: request.assertActive,
      authorizePath: request.authorizePath,
      controller: new AbortController(),
      probeOwnerId: `${ownerId}:generation-probe:${this.sequence}`,
      timer: null,
      settled: false,
      active: false,
      resolve(value) {
        if (job.settled) return false;
        job.settled = true;
        resolvePromise(value);
        return true;
      },
      reject(error) {
        if (job.settled) return false;
        job.settled = true;
        rejectPromise(error);
        return true;
      },
    };
    const promise = basePromise.finally(() => {
      if (job.timer) this.clock.clearTimeout(job.timer);
      job.timer = null;
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    this.jobs.add(job);
    this.queue.push(job);
    job.timer = this.clock.setTimeout(() => {
      this._cancelJob(
        job,
        cancellationError(
          "GENERATION_METADATA_TIMEOUT",
          `Generation metadata request exceeded ${this.timeoutMs}ms`
        )
      );
    }, this.timeoutMs);
    job.timer?.unref?.();
    this._pump();
    return promise;
  }

  cancelOwner(ownerId, reason = "Generation metadata request was cancelled") {
    const normalized = normalizeOwner(ownerId, null);
    if (normalized === null) return 0;
    return this._cancelMatching(
      (job) => job.ownerId === normalized,
      () => cancellationError("GENERATION_METADATA_CANCELLED", reason)
    );
  }

  cancelRenderer(rendererId, reason = "Generation metadata renderer was cancelled") {
    const normalized = normalizeOwner(rendererId, null);
    if (normalized === null) return 0;
    return this._cancelMatching(
      (job) => job.rendererId === normalized,
      () => cancellationError("GENERATION_METADATA_CANCELLED", reason)
    );
  }

  cancelAll(reason = "Generation metadata work was cancelled") {
    return this._cancelMatching(
      () => true,
      () => cancellationError("GENERATION_METADATA_CANCELLED", reason)
    );
  }

  async drain({ timeoutMs = null } = {}) {
    if (this.active.size === 0 && this.queue.length === 0) {
      return this.getSnapshot();
    }
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (snapshot) => {
        if (settled) return;
        settled = true;
        if (timer) this.clock.clearTimeout(timer);
        this.drainWaiters.delete(finish);
        resolve(snapshot);
      };
      this.drainWaiters.add(finish);
      const boundedTimeout = Number(timeoutMs);
      if (Number.isFinite(boundedTimeout) && boundedTimeout >= 0) {
        timer = this.clock.setTimeout(() => {
          finish({ ...this.getSnapshot(), drainTimedOut: true });
        }, boundedTimeout);
        timer?.unref?.();
      }
    });
  }

  async cancelAllAndDrain(
    reason = "Generation metadata work was cancelled",
    { timeoutMs = this.limits.drainTimeoutMs } = {}
  ) {
    this.cancelAll(reason);
    return this.drain({ timeoutMs });
  }

  shutdown(reason = "Generation metadata service is shutting down") {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.cancelAll(reason);
    const probeShutdown = Promise.resolve(this.probe.shutdown());
    this.shutdownPromise = Promise.allSettled([
      this.drain({ timeoutMs: this.limits.drainTimeoutMs }),
      probeShutdown,
    ])
      .then(() => this.getSnapshot());
    return this.shutdownPromise;
  }

  getSnapshot() {
    return {
      closed: this.closed,
      active: this.active.size,
      pending: this.queue.length,
      inFlight: this.inFlight.size,
      instanceGenerations: this.latestInstanceGeneration.size,
      concurrency: this.concurrency,
      maxPending: this.maxPending,
      probe: this.probe.getSnapshot?.() || null,
    };
  }

  _assertJobActive(job) {
    if (job.controller.signal.aborted) {
      throw job.controller.signal.reason ||
        cancellationError(
          "GENERATION_METADATA_CANCELLED",
          "Generation metadata request was cancelled"
        );
    }
    if (
      this.latestInstanceGeneration.get(job.instanceGenerationKey) !==
      job.instanceGeneration
    ) {
      throw cancellationError(
        "GENERATION_METADATA_SUPERSEDED",
        "A newer generation metadata request superseded this result"
      );
    }
    job.assertActive?.();
  }

  _releaseInstanceGeneration(job) {
    if (!job?.instanceGenerationKey) return;
    for (const candidate of this.jobs) {
      if (candidate.instanceGenerationKey === job.instanceGenerationKey) return;
    }
    this.latestInstanceGeneration.delete(job.instanceGenerationKey);
  }

  _pump() {
    while (!this.closed && this.active.size < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      if (!job || job.settled || job.controller.signal.aborted) {
        if (job) this.jobs.delete(job);
        continue;
      }
      job.active = true;
      this.active.add(job);
      this._processJob(job)
        .then((value) => job.resolve(value), (error) => job.reject(error))
        .finally(() => {
          job.active = false;
          this.active.delete(job);
          this.jobs.delete(job);
          this._releaseInstanceGeneration(job);
          this._notifyDrained();
          this._pump();
        });
    }
    this._notifyDrained();
  }

  _cancelJob(job, error) {
    if (!job || job.controller.signal.aborted) return false;
    job.controller.abort(error);
    this.probe.cancelOwner(job.probeOwnerId);
    job.reject(error);
    if (!job.active) {
      const index = this.queue.indexOf(job);
      if (index >= 0) this.queue.splice(index, 1);
      this.jobs.delete(job);
      this._releaseInstanceGeneration(job);
    }
    this._notifyDrained();
    this._pump();
    return true;
  }

  _cancelMatching(predicate, errorFactory) {
    let cancelled = 0;
    for (const job of [...this.jobs]) {
      if (job.controller.signal.aborted || !predicate(job)) continue;
      if (this._cancelJob(job, errorFactory(job))) cancelled += 1;
    }
    return cancelled;
  }

  _notifyDrained() {
    if (this.active.size > 0 || this.queue.length > 0) return;
    const snapshot = this.getSnapshot();
    for (const resolve of this.drainWaiters) resolve(snapshot);
    this.drainWaiters.clear();
  }

  async _statMedia(filePath) {
    const stats = await this.fs.stat(filePath);
    if (!stats?.isFile?.()) {
      throw new GenerationMetadataServiceError(
        "GENERATION_MEDIA_NOT_FILE",
        "Generation metadata source is not a regular file"
      );
    }
    return stats;
  }

  async _openSidecar(job, mediaPath) {
    if (typeof this.openSidecarCandidate !== "function") {
      throw new GenerationMetadataServiceError(
        "SIDECAR_HELPER_UNAVAILABLE",
        "Sidecar reader is unavailable"
      );
    }
    return this.openSidecarCandidate(mediaPath, {
      fsPromises: this.fs,
      pathImpl: this.path,
      maxBytes: this.limits.maxBytes,
      authorizePath: job.authorizePath,
    });
  }

  async _tryCached(job, mediaPath, signature) {
    if (job.force) return null;
    const cached = job.metadataStore.getGenerationMetadata(job.instanceId);
    if (
      !cached ||
      Number(cached.parserVersion) !== GENERATION_METADATA_PARSER_VERSION ||
      !sameMediaSignature(
        { size: cached.mediaSize, mtimeMs: cached.mediaMtimeMs },
        signature
      ) ||
      !hasSupportedFields(cached)
    ) {
      return null;
    }
    if (cached.sourceKind === "embedded") return cached;
    if (cached.sourceKind !== "sidecar") return null;
    const previousReaderStatus = cached.provenance?.readerStatus;
    if (
      cached.provenance?.readerAvailable === false ||
      ["error", "timeout", "output-limit", "shutdown", "cancelled"].includes(
        previousReaderStatus
      )
    ) {
      return null;
    }

    const candidate = await this._openSidecar(job, mediaPath);
    if (!candidate) return null;
    try {
      this._assertJobActive(job);
      const cachedPath = cached.sourcePath || cached.sidecarPath;
      return (
        cachedPath &&
        this.path.resolve(cachedPath) === this.path.resolve(candidate.path) &&
        sameNumber(cached.sourceSize ?? cached.sidecarSize, candidate.size) &&
        sameNumber(cached.sourceMtimeMs ?? cached.sidecarMtimeMs, candidate.mtimeMs)
      )
        ? cached
        : null;
    } finally {
      await candidate.handle.close().catch(() => {});
    }
  }

  _cachedResult(job, cached) {
    const provenance = cached.provenance || {};
    return serviceResult({
      instanceId: job.instanceId,
      stored: cached,
      cached: true,
      readerAvailable: provenance.readerAvailable !== false,
      readerStatus: provenance.readerStatus ||
        (cached.sourceKind === "embedded" ? "found" : "not-found"),
      pathImpl: this.path,
      limits: this.limits,
    });
  }

  _parseComfy(payload, mediaPath, origin) {
    return this.parseComfyGenerationPayload(payload, {
      fileName: this.path.basename(mediaPath),
      origin,
    });
  }

  async _readSidecar(job, mediaPath, signature, context) {
    const candidate = await this._openSidecar(job, mediaPath);
    if (!candidate) return { found: false, candidate: false, analysis: null };
    try {
      this._assertJobActive(job);
      const text = await this.readFileHandleBounded(candidate.handle, {
        maxBytes: this.limits.maxBytes,
        signal: job.controller.signal,
      });
      this._assertJobActive(job);
      let analysis = null;
      let generic = false;
      let comfyParseFailed = false;
      try {
        analysis = this._parseComfy(text, mediaPath, {
          kind: "sidecar",
          carrier: "json",
          metadataKey: "prompt",
        });
      } catch (error) {
        comfyParseFailed = true;
        context.diagnostics.push(
          diagnostic(
            error?.code || "SIDECAR_COMFY_PARSE_ERROR",
            "Adjacent JSON contains an unreadable ComfyUI graph"
          )
        );
      }
      if (!comfyParseFailed && !hasSupportedFields(analysis)) {
        analysis = null;
        try {
          const extracted = this.parseSidecarText(text, {
            ...SIDECAR_LIMITS,
            maxBytes: this.limits.maxBytes,
          });
          if (hasSupportedFields(extracted)) {
            analysis = genericAnalysis(extracted);
            generic = true;
          }
        } catch (error) {
          context.diagnostics.push(
            diagnostic(
              error?.code || "SIDECAR_PARSE_ERROR",
              "Adjacent JSON could not be interpreted"
            )
          );
        }
      }
      this._assertJobActive(job);
      const afterStats = await candidate.handle.stat();
      this._assertJobActive(job);
      if (!sameMediaSignature(mediaSignature(afterStats), {
        size: candidate.size,
        mtimeMs: candidate.mtimeMs,
      })) {
        throw new GenerationMetadataServiceError(
          "GENERATION_SOURCE_CHANGED",
          "Generation metadata source changed while it was being read"
        );
      }
      return {
        found: hasSupportedFields(analysis),
        candidate: true,
        analysis,
        generic,
        path: candidate.path,
        size: candidate.size,
        mtimeMs: candidate.mtimeMs,
        signature,
      };
    } finally {
      await candidate.handle.close().catch(() => {});
    }
  }

  async _persist(job, input) {
    this._assertJobActive(job);
    const stored = job.metadataStore.setGenerationMetadata(job.instanceId, input);
    this._assertJobActive(job);
    return stored;
  }

  async _assertMediaStable(job, mediaPath, signature) {
    const latest = mediaSignature(await this._statMedia(mediaPath));
    this._assertJobActive(job);
    if (!sameMediaSignature(latest, signature)) {
      throw new GenerationMetadataServiceError(
        "GENERATION_SOURCE_CHANGED",
        "Media changed while generation metadata was being read"
      );
    }
  }

  async _processJob(job) {
    this._assertJobActive(job);
    const instance = job.metadataStore.getFileInstanceById(job.instanceId);
    if (!instance?.absolutePath || instance.present === false) {
      throw new GenerationMetadataServiceError(
        "INSTANCE_NOT_FOUND",
        `File instance does not exist: ${job.instanceId}`
      );
    }
    const mediaPath = this.path.resolve(instance.absolutePath);
    await job.authorizePath?.(mediaPath);
    this._assertJobActive(job);
    const signature = mediaSignature(await this._statMedia(mediaPath));
    this._assertJobActive(job);

    const cached = await this._tryCached(job, mediaPath, signature);
    this._assertJobActive(job);
    if (cached) return this._cachedResult(job, cached);

    const context = { diagnostics: [], readerAvailable: true, readerStatus: "unknown" };
    let probeResult;
    try {
      probeResult = await this.probe.probe(mediaPath, {
        ownerId: job.probeOwnerId,
        force: job.force,
      });
    } catch (error) {
      probeResult = {
        status: "error",
        available: true,
        found: false,
        payload: null,
        error: { code: error?.code || "EMBEDDED_PROBE_ERROR" },
      };
    }
    this._assertJobActive(job);
    context.readerAvailable = probeResult?.available !== false;
    context.readerStatus = probeResult?.status || "error";
    let analysis = null;
    if (probeResult?.status === "found" && probeResult.payload) {
      try {
        analysis = this._parseComfy(probeResult.payload, mediaPath, {
          kind: "embedded",
          carrier: extensionLabel(mediaPath, this.path),
          metadataKey:
            probeResult.sources?.prompt?.key ||
            probeResult.sources?.workflow?.key ||
            "prompt",
        });
      } catch (error) {
        context.diagnostics.push(
          diagnostic(
            error?.code || "EMBEDDED_COMFY_PARSE_ERROR",
            "Embedded ComfyUI metadata could not be interpreted"
          )
        );
      }
      if (!hasSupportedFields(analysis)) {
        analysis = null;
        context.diagnostics.push(
          diagnostic(
            "EMBEDDED_UNRECOGNIZED",
            "Embedded metadata contains no supported generation fields"
          )
        );
      }
    } else if (["error", "timeout", "output-limit", "unrecognized"].includes(
      context.readerStatus
    )) {
      context.diagnostics.push(
        diagnostic(
          probeResult?.error?.code || "EMBEDDED_METADATA_UNAVAILABLE",
          "Embedded metadata could not be used"
        )
      );
    }

    if (analysis) {
      await this._assertMediaStable(job, mediaPath, signature);
      const input = buildPersistenceInput({
        analysis,
        sourceKind: "embedded",
        sourceFormat: extensionLabel(mediaPath, this.path),
        sourceLabel: embeddedSourceLabel(
          probeResult.sources?.prompt?.key ||
          probeResult.sources?.workflow?.key ||
          "metadata"
        ),
        signature,
        readerAvailable: context.readerAvailable,
        readerStatus: context.readerStatus,
        fallbackDiagnostics: context.diagnostics,
        limits: this.limits,
        pathImpl: this.path,
      });
      const stored = await this._persist(job, input);
      return serviceResult({
        instanceId: job.instanceId,
        stored,
        readerAvailable: context.readerAvailable,
        readerStatus: context.readerStatus,
        pathImpl: this.path,
        limits: this.limits,
      });
    }

    const sidecar = await this._readSidecar(job, mediaPath, signature, context);
    this._assertJobActive(job);
    if (sidecar.found) {
      await this._assertMediaStable(job, mediaPath, signature);
      const input = buildPersistenceInput({
        analysis: sidecar.analysis,
        sourceKind: "sidecar",
        sourceFormat: "json",
        sourceLabel: "Adjacent sidecar",
        sourcePath: sidecar.path,
        sourceSize: sidecar.size,
        sourceMtimeMs: sidecar.mtimeMs,
        signature,
        readerAvailable: context.readerAvailable,
        readerStatus: context.readerStatus,
        fallbackDiagnostics: context.diagnostics,
        generic: sidecar.generic,
        limits: this.limits,
        pathImpl: this.path,
      });
      const stored = await this._persist(job, input);
      return serviceResult({
        instanceId: job.instanceId,
        stored,
        readerAvailable: context.readerAvailable,
        readerStatus: context.readerStatus,
        pathImpl: this.path,
        limits: this.limits,
      });
    }

    await this._assertMediaStable(job, mediaPath, signature);
    this._assertJobActive(job);
    job.metadataStore.clearGenerationMetadata?.(job.instanceId);
    this._assertJobActive(job);
    const status = sidecar.candidate || context.diagnostics.some(
      (entry) => entry.code === "EMBEDDED_UNRECOGNIZED"
    )
      ? "unrecognized"
      : "none";
    return serviceResult({
      instanceId: job.instanceId,
      readerAvailable: context.readerAvailable,
      readerStatus: context.readerStatus,
      status,
      quality: "unknown",
      diagnostics: context.diagnostics,
      pathImpl: this.path,
      limits: this.limits,
    });
  }
}

function createGenerationMetadataService(options) {
  return new GenerationMetadataService(options);
}

module.exports = {
  GENERATION_METADATA_PARSER_VERSION,
  GENERATION_METADATA_SERVICE_LIMITS,
  GenerationMetadataService,
  GenerationMetadataServiceError,
  buildPersistenceInput,
  createGenerationMetadataService,
  hasSupportedFields,
  toWireMetadata,
};
