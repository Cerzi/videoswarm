const crypto = require("crypto");
const http = require("http");

// The local read API's HTTP server (docs/architecture/local-read-api.md).
// Loopback only, for other apps on this computer, never for web pages: every
// request must come with the token, as JSON, to a local Host, and without an
// Origin header, before any handler runs. Handlers only read.

const LOCAL_API_LIMITS = Object.freeze({
  maxBodyBytes: 1024 * 1024,
  maxInFlight: 4,
  requestTimeoutMs: 30_000,
});
const LOCAL_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
const ROUTE = /^\/api\/v1\/([a-z][a-z-]{0,31})$/u;

class LocalApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "LocalApiError";
    this.status = status;
    this.code = code;
  }
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text, "utf8"),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

const fail = (res, error) =>
  send(res, error.status || 500, {
    error: {
      code: error.code || "LOCAL_API_ERROR",
      message: error.status ? error.message : "The request could not be answered",
    },
  });

function tokenMatches(header, token) {
  if (typeof header !== "string" || !header.startsWith("Bearer ") || !token) return false;
  const given = Buffer.from(header.slice(7).trim(), "utf8");
  const expected = Buffer.from(token, "utf8");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Answer, then let the rest of the body drain unread.
        reject(new LocalApiError(413, "LOCAL_API_TOO_LARGE", "The request is too large"));
        req.removeAllListeners("data");
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * `handlers` maps endpoint names to `async (body) => answer`; `getToken()`
 * returns the current token; `onRead({ endpoint, userAgent })` hears about
 * every request that got through.
 */
function createLocalApiServer({ handlers, getToken, onRead = () => {}, limits = {} }) {
  const bounds = { ...LOCAL_API_LIMITS, ...limits };
  let server = null;
  let listeningPort = null;
  let inFlight = 0;

  async function handle(req) {
    // Checked before the body is read, in this order.
    if (req.headers.origin !== undefined) {
      throw new LocalApiError(403, "LOCAL_API_FORBIDDEN", "Web pages cannot use this API");
    }
    const host = String(req.headers.host || "").toLowerCase();
    if (!LOCAL_HOSTS.some((name) => host === `${name}:${listeningPort}`)) {
      throw new LocalApiError(403, "LOCAL_API_FORBIDDEN", "Only local requests are answered");
    }
    if (req.method !== "POST") {
      throw new LocalApiError(405, "LOCAL_API_METHOD", "Use POST");
    }
    const route = ROUTE.exec(String(req.url || "").split("?")[0]);
    if (!tokenMatches(req.headers.authorization, getToken())) {
      throw new LocalApiError(401, "LOCAL_API_UNAUTHORIZED", "A valid token is required");
    }
    if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      throw new LocalApiError(415, "LOCAL_API_MEDIA_TYPE", "Send JSON");
    }
    const handler = route && Object.prototype.hasOwnProperty.call(handlers, route[1]) ? handlers[route[1]] : null;
    if (!handler) throw new LocalApiError(404, "LOCAL_API_NOT_FOUND", "No such endpoint");
    const text = await readBody(req, bounds.maxBodyBytes);
    let body;
    try {
      body = text.trim() ? JSON.parse(text) : {};
    } catch {
      throw new LocalApiError(400, "LOCAL_API_BAD_JSON", "The body is not valid JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new LocalApiError(400, "LOCAL_API_BAD_REQUEST", "The body must be a JSON object");
    }
    onRead({ endpoint: route[1], userAgent: String(req.headers["user-agent"] || "").slice(0, 120) });
    return handler(body);
  }

  function onRequest(req, res) {
    if (inFlight >= bounds.maxInFlight) {
      fail(res, new LocalApiError(503, "LOCAL_API_BUSY", "Too many requests at once"));
      req.resume();
      return;
    }
    inFlight += 1;
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        inFlight -= 1;
      }
    };
    res.on("close", finish);
    const timer = setTimeout(() => {
      if (!res.headersSent) fail(res, new LocalApiError(503, "LOCAL_API_TIMEOUT", "The request took too long"));
    }, bounds.requestTimeoutMs);
    handle(req)
      .then((answer) => {
        if (!res.headersSent) send(res, 200, answer);
      })
      .catch((error) => {
        if (!res.headersSent) fail(res, error);
      })
      .finally(() => {
        clearTimeout(timer);
        finish();
      });
  }

  return {
    /** Listens on 127.0.0.1:`port`; resolves to the port, or rejects (say, in use). */
    start(port) {
      if (server) return Promise.resolve(listeningPort);
      return new Promise((resolve, reject) => {
        const candidate = http.createServer(onRequest);
        candidate.headersTimeout = bounds.requestTimeoutMs;
        candidate.requestTimeout = bounds.requestTimeoutMs;
        candidate.once("error", reject);
        candidate.listen(port, "127.0.0.1", () => {
          candidate.off("error", reject);
          server = candidate;
          listeningPort = candidate.address().port;
          resolve(listeningPort);
        });
      });
    },
    stop() {
      if (!server) return Promise.resolve();
      const closing = server;
      server = null;
      listeningPort = null;
      return new Promise((resolve) => {
        closing.close(() => resolve());
        closing.closeAllConnections?.();
      });
    },
    get port() {
      return listeningPort;
    },
  };
}

module.exports = { LOCAL_API_LIMITS, LocalApiError, createLocalApiServer };
