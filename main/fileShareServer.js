const http = require("http");
const { createReadStream } = require("fs");
const path = require("path");
const { randomBytes } = require("crypto");

const DEFAULT_TTL_MS = 2 * 60 * 1000; // 2 minutes

const tokens = new Map();
let server = null;
let port = null;
let cleanupTimer = null;

function ensureCleanupTimer() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of tokens.entries()) {
      if (entry.expiresAt <= now) {
        tokens.delete(token);
      }
    }
    if (!tokens.size && server) {
      // keep running, but timer can stop to save work
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, 30 * 1000);
  cleanupTimer.unref?.();
}

function ensureServer() {
  if (server) {
    return server;
  }

  server = http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400);
      res.end("Bad Request");
      return;
    }

    const segments = req.url.split("/").filter(Boolean);
    if (!segments.length) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const token = segments[0];
    const entry = tokens.get(token);
    if (!entry) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const now = Date.now();
    if (entry.expiresAt <= now) {
      tokens.delete(token);
      res.writeHead(410);
      res.end("Expired");
      return;
    }

    const { filePath, mimeType, downloadName } = entry;
    const stream = createReadStream(filePath);

    stream.on("error", (error) => {
      console.warn("FileShareServer stream error", error);
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end("Internal Server Error");
      tokens.delete(token);
    });

    res.writeHead(200, {
      "Content-Type": mimeType || "application/octet-stream",
      "Content-Disposition":
        `attachment; filename="${encodeURIComponent(downloadName || path.basename(filePath))}"`,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });

    stream.pipe(res);
    res.on("close", () => {
      tokens.delete(token);
    });
  });

  server.listen(0, "127.0.0.1", () => {
    port = server.address().port;
  });

  server.on("error", (error) => {
    console.error("FileShareServer error", error);
  });

  return server;
}

function createShareURL({ filePath, mimeType, downloadName, ttlMs = DEFAULT_TTL_MS }) {
  if (!filePath) throw new Error("filePath is required");

  ensureServer();
  ensureCleanupTimer();

  const token = randomBytes(16).toString("hex");
  const expiresAt = Date.now() + Math.max(ttlMs, 5 * 1000);

  tokens.set(token, {
    filePath,
    mimeType: mimeType || "application/octet-stream",
    downloadName: downloadName || path.basename(filePath),
    expiresAt,
  });

  if (!port) {
    const address = server.address();
    port = address && typeof address.port === "number" ? address.port : null;
  }

  if (!port) {
    throw new Error("FileShareServer not ready");
  }

  const encodedName = encodeURIComponent(downloadName || path.basename(filePath));
  return `http://127.0.0.1:${port}/${token}/${encodedName}`;
}

function shutdown() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  tokens.clear();
  if (server) {
    try {
      server.close();
    } catch (error) {
      console.warn("Error closing FileShareServer", error);
    }
    server = null;
    port = null;
  }
}

ensureServer();

module.exports = {
  createShareURL,
  shutdown,
};
