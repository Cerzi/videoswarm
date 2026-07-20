const { createChildProcessRunner } = require("./child-process-runner");

const EMBEDDED_METADATA_PROBE_LIMITS = Object.freeze({
  concurrency: 1,
  maxPending: 16,
  timeoutMs: 5_000,
  maxStdoutBytes: 2 * 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  killGraceMs: 500,
  maxContainers: 64,
  maxTagKeys: 256,
  maxEnvelopeKeys: 64,
});

const EMBEDDED_METADATA_FIELDS = new Set(["prompt", "workflow"]);
const EMBEDDED_METADATA_ENVELOPES = new Set(["comment", "description"]);
const MISSING_EXECUTABLE_CODES = new Set(["ENOENT"]);

class EmbeddedMetadataProbeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EmbeddedMetadataProbeError";
    this.code = code;
  }
}

function createFfprobeMetadataArgs(filePath) {
  return [
    "-v",
    "error",
    "-show_entries",
    "format_tags:stream_tags",
    "-of",
    "json=compact=1",
    "-i",
    filePath,
  ];
}

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function plainError(error, fallbackCode = "EMBEDDED_METADATA_PROBE_ERROR") {
  return {
    code: error?.code || fallbackCode,
    message: error?.message || "Could not inspect embedded metadata",
  };
}

function resultFor(status, options = {}) {
  return {
    status,
    available: options.available !== false,
    found: status === "found",
    payload: options.payload || null,
    sources: options.sources || null,
    issues: Array.isArray(options.issues) ? options.issues : [],
    error: options.error || null,
  };
}

function normalizePayloadValue(value) {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || null;
  }
  if (!value || typeof value !== "object") return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseEnvelope(value, maxEnvelopeKeys) {
  let parsed = value;
  for (let depth = 0; depth < 2 && typeof parsed === "string"; depth += 1) {
    const source = parsed.trim();
    if (!source) return null;
    try {
      parsed = JSON.parse(source);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const fields = {};
  let inspected = 0;
  for (const key in parsed) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
    inspected += 1;
    if (inspected > maxEnvelopeKeys) break;
    const normalizedKey = String(key).toLowerCase();
    if (!EMBEDDED_METADATA_FIELDS.has(normalizedKey)) continue;
    const normalizedValue = normalizePayloadValue(parsed[key]);
    if (normalizedValue) fields[normalizedKey] = normalizedValue;
  }
  return Object.keys(fields).length ? fields : null;
}

function collectTagContainers(parsed, limits) {
  const containers = [];
  const add = (tags, scope, streamIndex = null) => {
    if (
      containers.length >= limits.maxContainers ||
      !tags ||
      typeof tags !== "object" ||
      Array.isArray(tags)
    ) {
      return;
    }
    containers.push({ tags, scope, streamIndex });
  };

  add(parsed?.format?.tags, "format");
  if (Array.isArray(parsed?.streams)) {
    const streamLimit = Math.min(
      parsed.streams.length,
      Math.max(0, limits.maxContainers - containers.length)
    );
    for (let index = 0; index < streamLimit; index += 1) {
      add(parsed.streams[index]?.tags, "stream", index);
    }
  }
  return containers;
}

function collectRecognizedTags(containers, limits) {
  const direct = [];
  const envelopes = [];
  for (const container of containers) {
    let inspected = 0;
    for (const key in container.tags) {
      if (!Object.prototype.hasOwnProperty.call(container.tags, key)) continue;
      inspected += 1;
      if (inspected > limits.maxTagKeys) break;
      const normalizedKey = String(key).toLowerCase();
      const entry = {
        ...container,
        key: String(key),
        normalizedKey,
        value: container.tags[key],
      };
      if (EMBEDDED_METADATA_FIELDS.has(normalizedKey)) direct.push(entry);
      if (EMBEDDED_METADATA_ENVELOPES.has(normalizedKey)) envelopes.push(entry);
    }
  }
  return { direct, envelopes };
}

function parseFfprobeMetadataOutput(output, options = {}) {
  const limits = { ...EMBEDDED_METADATA_PROBE_LIMITS, ...options };
  const source = Buffer.isBuffer(output)
    ? output.toString("utf8")
    : String(output ?? "");
  if (byteLength(source) > limits.maxStdoutBytes) {
    throw new EmbeddedMetadataProbeError(
      "FFPROBE_OUTPUT_TOO_LARGE",
      `ffprobe output exceeds ${limits.maxStdoutBytes} bytes`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new EmbeddedMetadataProbeError(
      "FFPROBE_INVALID_JSON",
      `ffprobe did not return valid JSON: ${error?.message || error}`
    );
  }

  const containers = collectTagContainers(parsed, limits);
  const { direct, envelopes } = collectRecognizedTags(containers, limits);
  const payload = {};
  const sources = {};
  const issues = [];
  let recognizedCandidate = direct.length > 0;
  let usedBytes = 0;

  const addField = (field, value, sourceEntry) => {
    if (payload[field]) return;
    const normalized = normalizePayloadValue(value);
    if (!normalized) {
      issues.push({ code: "EMPTY_FIELD", field });
      return;
    }
    const valueBytes = byteLength(normalized);
    if (usedBytes + valueBytes > limits.maxStdoutBytes) {
      issues.push({ code: "PAYLOAD_LIMIT", field });
      return;
    }
    usedBytes += valueBytes;
    payload[field] = normalized;
    sources[field] = {
      scope: sourceEntry.scope,
      streamIndex: sourceEntry.streamIndex,
      key: sourceEntry.key,
    };
  };

  // Explicit tags are authoritative even when an envelope appears earlier in
  // ffprobe's output. Container-level tags retain priority over stream tags.
  for (const entry of direct) {
    addField(entry.normalizedKey, entry.value, entry);
  }
  for (const entry of envelopes) {
    const fields = parseEnvelope(entry.value, limits.maxEnvelopeKeys);
    if (!fields) continue;
    recognizedCandidate = true;
    for (const field of EMBEDDED_METADATA_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(fields, field)) {
        addField(field, fields[field], entry);
      }
    }
  }

  if (Object.keys(payload).length > 0) {
    return resultFor("found", { payload, sources, issues });
  }
  return resultFor(recognizedCandidate ? "unrecognized" : "not-found", {
    issues,
  });
}

function isMissingExecutableError(error) {
  if (error?.code !== "SPAWN_ERROR") return false;
  return MISSING_EXECUTABLE_CODES.has(error?.cause?.code);
}

class EmbeddedMetadataProbe {
  constructor(options = {}) {
    this.command = options.command || "ffprobe";
    this.limits = {
      ...EMBEDDED_METADATA_PROBE_LIMITS,
      ...(options.limits || {}),
    };
    const runnerFactory = options.runnerFactory || createChildProcessRunner;
    this.runner =
      options.runner ||
      runnerFactory({
        concurrency: this.limits.concurrency,
        maxPending: this.limits.maxPending,
        timeoutMs: this.limits.timeoutMs,
        maxStdoutBytes: this.limits.maxStdoutBytes,
        maxStderrBytes: this.limits.maxStderrBytes,
        killGraceMs: this.limits.killGraceMs,
        ...(options.spawn ? { spawn: options.spawn } : {}),
        ...(options.clock ? { clock: options.clock } : {}),
      });
    this.executableAvailable = null;
    this.closed = false;
  }

  async probe(filePath, { ownerId = null, force = false } = {}) {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      return resultFor("error", {
        error: {
          code: "INVALID_PATH",
          message: "A non-empty media path is required",
        },
      });
    }
    if (this.closed) {
      return resultFor("shutdown", {
        available: this.executableAvailable !== false,
        error: {
          code: "EMBEDDED_METADATA_PROBE_SHUTDOWN",
          message: "Embedded metadata probe is shut down",
        },
      });
    }
    if (this.executableAvailable === false && force !== true) {
      return resultFor("unavailable", {
        available: false,
        error: {
          code: "FFPROBE_UNAVAILABLE",
          message: "ffprobe is not available",
        },
      });
    }

    try {
      const processResult = await this.runner.run(
        this.command,
        createFfprobeMetadataArgs(filePath),
        {
          ownerId,
          timeoutMs: this.limits.timeoutMs,
          maxStdoutBytes: this.limits.maxStdoutBytes,
          maxStderrBytes: this.limits.maxStderrBytes,
          spawnOptions: {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          },
        }
      );
      this.executableAvailable = true;
      return parseFfprobeMetadataOutput(processResult.stdout, this.limits);
    } catch (error) {
      if (isMissingExecutableError(error)) {
        this.executableAvailable = false;
        return resultFor("unavailable", {
          available: false,
          error: {
            code: "FFPROBE_UNAVAILABLE",
            message: "ffprobe is not available",
          },
        });
      }
      if (error?.code === "OWNER_CANCELLED" || error?.code === "RUNNER_CANCELLED") {
        return resultFor("cancelled", { error: plainError(error) });
      }
      if (error?.code === "RUNNER_SHUTDOWN") {
        return resultFor("shutdown", { error: plainError(error) });
      }
      if (error?.code === "PROCESS_TIMEOUT") {
        return resultFor("timeout", { error: plainError(error) });
      }
      if (error?.code === "STDOUT_LIMIT" || error?.code === "STDERR_LIMIT") {
        return resultFor("output-limit", { error: plainError(error) });
      }
      return resultFor("error", { error: plainError(error) });
    }
  }

  cancelOwner(ownerId) {
    return this.runner.cancelOwner(
      ownerId,
      "Embedded metadata probe owner was cancelled"
    );
  }

  cancelAll(reason = "Embedded metadata probing was cancelled") {
    return this.runner.cancelAll(reason);
  }

  shutdown() {
    this.closed = true;
    return this.runner.shutdown("Embedded metadata probe is shutting down");
  }

  getSnapshot() {
    return {
      closed: this.closed,
      availability:
        this.executableAvailable === null
          ? "unknown"
          : this.executableAvailable
            ? "available"
            : "unavailable",
      runner: this.runner.getSnapshot(),
    };
  }
}

function createEmbeddedMetadataProbe(options) {
  return new EmbeddedMetadataProbe(options);
}

module.exports = {
  EMBEDDED_METADATA_PROBE_LIMITS,
  EmbeddedMetadataProbe,
  EmbeddedMetadataProbeError,
  createEmbeddedMetadataProbe,
  createFfprobeMetadataArgs,
  parseFfprobeMetadataOutput,
};
