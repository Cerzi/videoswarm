const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");

const MEDIA_PROTOCOL_SCHEME = "videoswarm-media";
const MEDIA_PROTOCOL_HOST = "instance";
const MEDIA_PROTOCOL_PROXY_HOST = "proxy";

const MEDIA_MIME_TYPES = Object.freeze({
  ".3gp": "video/3gpp",
  ".avi": "video/x-msvideo",
  ".flv": "video/x-flv",
  ".m4v": "video/x-m4v",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".ogv": "video/ogg",
  ".webm": "video/webm",
  ".wmv": "video/x-ms-wmv",
});

class MediaProtocolError extends Error {
  constructor(message, { code = "MEDIA_PROTOCOL_ERROR", status = 500 } = {}) {
    super(message);
    this.name = "MediaProtocolError";
    this.code = code;
    this.status = status;
  }
}

function normalizeInstanceId(value) {
  const instanceId = Number(value);
  if (!Number.isSafeInteger(instanceId) || instanceId <= 0) {
    throw new MediaProtocolError("A positive media instance id is required", {
      code: "INVALID_INSTANCE_ID",
      status: 400,
    });
  }
  return instanceId;
}

function createMediaInstanceUrl(instanceId, options = {}) {
  const normalizedId = normalizeInstanceId(instanceId);
  const scheme = options.scheme || MEDIA_PROTOCOL_SCHEME;
  const url = new URL(`${scheme}://${MEDIA_PROTOCOL_HOST}/${normalizedId}`);
  if (options.version !== undefined && options.version !== null) {
    const version = String(options.version);
    if (version.length > 128 || version.includes("\0")) {
      throw new MediaProtocolError("Invalid media source version", {
        code: "INVALID_MEDIA_VERSION",
        status: 400,
      });
    }
    url.searchParams.set("v", version);
  }
  if (options.generation !== undefined && options.generation !== null) {
    const generation = Number(options.generation);
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new MediaProtocolError("Invalid media profile generation", {
        code: "INVALID_MEDIA_GENERATION",
        status: 400,
      });
    }
    url.searchParams.set("g", String(generation));
  }
  return url.href;
}

function normalizeProxySignature(value) {
  const signature = String(value || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(signature)) {
    throw new MediaProtocolError("A valid proxy signature is required", {
      code: "INVALID_PROXY_SIGNATURE",
      status: 400,
    });
  }
  return signature;
}

function createMediaProxyUrl(signature, options = {}) {
  const normalizedSignature = normalizeProxySignature(signature);
  const scheme = options.scheme || MEDIA_PROTOCOL_SCHEME;
  const url = new URL(
    `${scheme}://${MEDIA_PROTOCOL_PROXY_HOST}/${normalizedSignature}`
  );
  if (options.generation !== undefined && options.generation !== null) {
    const generation = Number(options.generation);
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new MediaProtocolError("Invalid media profile generation", {
        code: "INVALID_MEDIA_GENERATION",
        status: 400,
      });
    }
    url.searchParams.set("g", String(generation));
  }
  return url.href;
}

function parseMediaRequestUrl(value, options = {}) {
  const scheme = options.scheme || MEDIA_PROTOCOL_SCHEME;
  const rawUrl = String(value || "");
  if (!rawUrl || rawUrl.length > 2048 || rawUrl.includes("\0")) {
    throw new MediaProtocolError("Malformed media URL", {
      code: "INVALID_MEDIA_URL",
      status: 400,
    });
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new MediaProtocolError("Malformed media URL", {
      code: "INVALID_MEDIA_URL",
      status: 400,
    });
  }

  if (
    parsed.protocol !== `${scheme}:` ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hash
  ) {
    throw new MediaProtocolError("Unsupported media URL", {
      code: "INVALID_MEDIA_URL",
      status: 400,
    });
  }

  if (parsed.hostname === MEDIA_PROTOCOL_HOST) {
    const match = /^\/(\d+)$/.exec(parsed.pathname);
    const versionValues = parsed.searchParams.getAll("v");
    const generationValues = parsed.searchParams.getAll("g");
    const hasUnknownParameter = [...parsed.searchParams.keys()].some(
      (key) => key !== "v" && key !== "g"
    );
    const version = versionValues[0] ?? null;
    const generationValue = generationValues[0] ?? null;
    const generation = generationValue === null
      ? null
      : Number(generationValue);
    if (
      !match ||
      hasUnknownParameter ||
      versionValues.length > 1 ||
      generationValues.length > 1 ||
      (generationValue !== null &&
        (!/^\d+$/.test(generationValue) ||
          !Number.isSafeInteger(generation) ||
          generation < 0)) ||
      (version !== null && (version.length > 128 || version.includes("\0")))
    ) {
      throw new MediaProtocolError("Malformed media instance URL", {
        code: "INVALID_MEDIA_URL",
        status: 400,
      });
    }
    return {
      kind: "instance",
      instanceId: normalizeInstanceId(match[1]),
      version,
      generation,
    };
  }

  if (parsed.hostname === MEDIA_PROTOCOL_PROXY_HOST) {
    const match = /^\/([a-fA-F0-9]{64})$/.exec(parsed.pathname);
    const generationValues = parsed.searchParams.getAll("g");
    const generationValue = generationValues[0] ?? null;
    const generation = generationValue === null
      ? null
      : Number(generationValue);
    if (
      !match ||
      [...parsed.searchParams.keys()].some((key) => key !== "g") ||
      generationValues.length > 1 ||
      (generationValue !== null &&
        (!/^\d+$/.test(generationValue) ||
          !Number.isSafeInteger(generation) ||
          generation < 0))
    ) {
      throw new MediaProtocolError("Malformed media proxy URL", {
        code: "INVALID_MEDIA_URL",
        status: 400,
      });
    }
    return {
      kind: "proxy",
      signature: normalizeProxySignature(match[1]),
      generation,
    };
  }

  throw new MediaProtocolError("Unsupported media URL", {
    code: "INVALID_MEDIA_URL",
    status: 400,
  });
}

function parseMediaInstanceUrl(value, options = {}) {
  const parsed = parseMediaRequestUrl(value, options);
  if (parsed.kind !== "instance") {
    throw new MediaProtocolError("A media instance URL is required", {
      code: "INVALID_MEDIA_URL",
      status: 400,
    });
  }
  return {
    instanceId: parsed.instanceId,
    version: parsed.version,
    generation: parsed.generation,
  };
}

function rangeNotSatisfiable(message = "Requested range is not satisfiable") {
  return new MediaProtocolError(message, {
    code: "RANGE_NOT_SATISFIABLE",
    status: 416,
  });
}

/**
 * Parse one RFC 7233 byte range. Multiple ranges are deliberately rejected:
 * Chromium media requests do not require multipart responses and accepting
 * them would make the protocol significantly more complex and easier to
 * abuse.
 */
function parseSingleByteRange(headerValue, size) {
  if (headerValue === null || headerValue === undefined || headerValue === "") {
    return null;
  }
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TypeError("Media size must be a non-negative safe integer");
  }

  const header = String(headerValue).trim();
  const match = /^bytes\s*=\s*([^,]+)$/i.exec(header);
  if (!match || match[1].includes(",")) {
    throw rangeNotSatisfiable("Only one byte range is supported");
  }
  if (size === 0) throw rangeNotSatisfiable();

  const range = match[1].trim();
  const parts = /^(\d*)-(\d*)$/.exec(range);
  if (!parts || (!parts[1] && !parts[2])) throw rangeNotSatisfiable();

  let start;
  let end;
  if (!parts[1]) {
    const suffixLength = Number(parts[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw rangeNotSatisfiable();
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(parts[1]);
    if (!Number.isSafeInteger(start) || start < 0 || start >= size) {
      throw rangeNotSatisfiable();
    }
    if (parts[2]) {
      end = Number(parts[2]);
      if (!Number.isSafeInteger(end) || end < start) {
        throw rangeNotSatisfiable();
      }
      end = Math.min(end, size - 1);
    } else {
      end = size - 1;
    }
  }

  return { start, end, length: end - start + 1 };
}

function responseHeaders(mimeType) {
  return new Headers({
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Type": mimeType,
    "Cross-Origin-Resource-Policy": "cross-origin",
  });
}

function errorResponse(ResponseImpl, error, size = null) {
  const status = Number(error?.status) || 500;
  const headers = responseHeaders("text/plain; charset=utf-8");
  headers.set("Allow", "GET, HEAD");
  if (status === 416 && Number.isSafeInteger(size) && size >= 0) {
    headers.set("Content-Range", `bytes */${size}`);
  }
  const publicMessage = status >= 500 ? "Unable to read media" : error.message;
  return new ResponseImpl(publicMessage, { status, headers });
}

function attachAbortCleanup(stream, signal) {
  if (!stream || !signal || typeof signal.addEventListener !== "function") {
    return () => {};
  }

  let cleaned = false;
  const abort = () => {
    if (typeof stream.destroy === "function" && !stream.destroyed) {
      // Do not pass an Error here. A destroyed response body already reports
      // cancellation to Chromium; injecting an error risks an unhandled stream
      // error when the request was abandoned before the body was consumed.
      stream.destroy();
    }
  };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    signal.removeEventListener?.("abort", abort);
  };

  signal.addEventListener("abort", abort, { once: true });
  stream.once?.("close", cleanup);
  stream.once?.("end", cleanup);
  stream.once?.("error", cleanup);
  if (signal.aborted) abort();
  return cleanup;
}

function toWebResponseBody(stream) {
  if (!stream) return null;
  if (typeof Readable.toWeb === "function" && stream instanceof Readable) {
    return Readable.toWeb(stream);
  }
  return stream;
}

function registerMediaScheme(protocolApi, options = {}) {
  if (!protocolApi || typeof protocolApi.registerSchemesAsPrivileged !== "function") {
    throw new TypeError("Electron protocol.registerSchemesAsPrivileged is required");
  }
  protocolApi.registerSchemesAsPrivileged([
    {
      scheme: options.scheme || MEDIA_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

function createMediaProtocolService(options = {}) {
  const {
    resolveInstance,
    resolveProxy = null,
    authorizePath = null,
    fsApi = fs.promises,
    createReadStream = fs.createReadStream,
    ResponseImpl = globalThis.Response,
    scheme = MEDIA_PROTOCOL_SCHEME,
    logger = console,
  } = options;

  if (typeof resolveInstance !== "function") {
    throw new TypeError("createMediaProtocolService requires resolveInstance");
  }
  if (typeof createReadStream !== "function") {
    throw new TypeError("createMediaProtocolService requires createReadStream");
  }
  if (typeof ResponseImpl !== "function") {
    throw new TypeError("A WHATWG Response implementation is required");
  }

  let registeredProtocol = null;
  let disposed = false;
  let serviceEpoch = 0;
  const activeStreams = new Set();

  function assertRequestCurrent(epoch) {
    if (disposed || epoch !== serviceEpoch) {
      throw new MediaProtocolError("Media request ownership changed", {
        code: "STALE_MEDIA_REQUEST",
        status: 410,
      });
    }
  }

  async function handle(request) {
    if (disposed) {
      return errorResponse(
        ResponseImpl,
        new MediaProtocolError("Media protocol is unavailable", {
          code: "MEDIA_PROTOCOL_DISPOSED",
          status: 503,
        })
      );
    }

    let mediaSize = null;
    const requestEpoch = serviceEpoch;
    try {
      assertRequestCurrent(requestEpoch);
      const method = String(request?.method || "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") {
        throw new MediaProtocolError("Method not allowed", {
          code: "METHOD_NOT_ALLOWED",
          status: 405,
        });
      }

      const target = parseMediaRequestUrl(request?.url, { scheme });
      const resolved = target.kind === "instance"
        ? await resolveInstance(target.instanceId, { request, target })
        : typeof resolveProxy === "function"
          ? await resolveProxy(target.signature, { request, target })
          : null;
      assertRequestCurrent(requestEpoch);
      if (!resolved || resolved.present === false) {
        throw new MediaProtocolError("Media source was not found", {
          code: "MEDIA_NOT_FOUND",
          status: 404,
        });
      }
      const candidatePath =
        typeof resolved === "string" ? resolved : resolved.path || resolved.absolutePath;
      if (
        typeof candidatePath !== "string" ||
        !candidatePath ||
        candidatePath.includes("\0") ||
        !path.isAbsolute(candidatePath)
      ) {
        throw new MediaProtocolError("Media instance has no valid path", {
          code: "INVALID_MEDIA_PATH",
          status: 404,
        });
      }

      const extension = path.extname(candidatePath).toLowerCase();
      const mimeType = MEDIA_MIME_TYPES[extension];
      if (!mimeType) {
        throw new MediaProtocolError("Unsupported media type", {
          code: "UNSUPPORTED_MEDIA_TYPE",
          status: 415,
        });
      }

      const canonicalPath = await fsApi.realpath(candidatePath);
      assertRequestCurrent(requestEpoch);
      if (typeof authorizePath === "function") {
        await authorizePath(canonicalPath, { ...target, resolved, request });
        assertRequestCurrent(requestEpoch);
      }
      const stats = await fsApi.stat(canonicalPath);
      assertRequestCurrent(requestEpoch);
      if (!stats?.isFile?.()) {
        throw new MediaProtocolError("Media instance is not a file", {
          code: "MEDIA_NOT_FOUND",
          status: 404,
        });
      }
      mediaSize = Number(stats.size);
      if (!Number.isSafeInteger(mediaSize) || mediaSize < 0) {
        throw new MediaProtocolError("Media file has an invalid size", {
          code: "INVALID_MEDIA_SIZE",
          status: 500,
        });
      }

      const requestedRange = request?.headers?.get?.("range") || null;
      const range = parseSingleByteRange(requestedRange, mediaSize);
      const headers = responseHeaders(mimeType);
      const status = range ? 206 : 200;
      const contentLength = range?.length ?? mediaSize;
      headers.set("Content-Length", String(contentLength));
      if (range) {
        headers.set(
          "Content-Range",
          `bytes ${range.start}-${range.end}/${mediaSize}`
        );
      }

      if (method === "HEAD" || contentLength === 0) {
        assertRequestCurrent(requestEpoch);
        return new ResponseImpl(null, { status, headers });
      }

      assertRequestCurrent(requestEpoch);
      const stream = createReadStream(canonicalPath, {
        ...(range ? { start: range.start, end: range.end } : {}),
      });
      activeStreams.add(stream);
      const detachAbort = attachAbortCleanup(stream, request?.signal);
      let released = false;
      const releaseStream = () => {
        if (released) return;
        released = true;
        activeStreams.delete(stream);
        detachAbort();
      };
      stream.once?.("close", releaseStream);
      stream.once?.("end", releaseStream);
      stream.once?.("error", releaseStream);
      try {
        return new ResponseImpl(toWebResponseBody(stream), { status, headers });
      } catch (error) {
        releaseStream();
        stream.destroy?.();
        throw error;
      }
    } catch (error) {
      if (!error?.status) {
        logger?.warn?.("[media-protocol] Request failed", {
          code: error?.code || "MEDIA_READ_FAILED",
          message: error?.message || String(error),
        });
      }
      return errorResponse(ResponseImpl, error, mediaSize);
    }
  }

  function register(protocolApi) {
    if (disposed) throw new Error("Media protocol service is disposed");
    if (!protocolApi || typeof protocolApi.handle !== "function") {
      throw new TypeError("Electron protocol.handle is required");
    }
    if (registeredProtocol) return false;
    if (protocolApi.isProtocolHandled?.(scheme)) {
      throw new Error(`Protocol '${scheme}' already has a handler`);
    }
    protocolApi.handle(scheme, handle);
    registeredProtocol = protocolApi;
    return true;
  }

  function cancelActiveStreams() {
    serviceEpoch += 1;
    let cancelled = 0;
    for (const stream of activeStreams) {
      try {
        if (!stream.destroyed) {
          stream.destroy?.();
          cancelled += 1;
        }
      } catch {
        // Stream cleanup is best effort during profile/window transitions.
      }
    }
    activeStreams.clear();
    return cancelled;
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    cancelActiveStreams();
    if (registeredProtocol?.unhandle) {
      try {
        registeredProtocol.unhandle(scheme);
      } catch (error) {
        logger?.warn?.("[media-protocol] Failed to remove handler", error);
      }
    }
    registeredProtocol = null;
    return true;
  }

  return {
    scheme,
    handle,
    register,
    cancelActiveStreams,
    dispose,
    isDisposed: () => disposed,
    getSnapshot: () => ({ disposed, activeStreams: activeStreams.size }),
  };
}

module.exports = {
  MEDIA_MIME_TYPES,
  MEDIA_PROTOCOL_HOST,
  MEDIA_PROTOCOL_PROXY_HOST,
  MEDIA_PROTOCOL_SCHEME,
  MediaProtocolError,
  attachAbortCleanup,
  createMediaInstanceUrl,
  createMediaProxyUrl,
  createMediaProtocolService,
  parseMediaInstanceUrl,
  parseMediaRequestUrl,
  parseSingleByteRange,
  registerMediaScheme,
};
