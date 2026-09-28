// A fake ComfyUI for tests: a real HTTP server on 127.0.0.1 answering the
// endpoints Video Swarm uses, driven by the test. Tests never talk to a real
// ComfyUI.
const http = require("http");
const { Buffer } = require("buffer");
const { URL } = require("url");

function createFakeComfyUi({ info = {} } = {}) {
  const state = {
    info,
    running: [], // [{ id, prompt, extra }]
    pending: [],
    history: {},
    posted: [],
    deleted: [],
    freed: 0,
    requests: [],
    down: false,
    refuse: null,
    nextId: 1,
  };

  const send = (res, status, body) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(text);
  };
  const entry = (item, number) => [number, item.id, item.prompt, item.extra, []];

  const server = http.createServer((req, res) => {
    if (state.down) {
      req.socket.destroy();
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      state.requests.push(`${req.method} ${url.pathname}${url.search}`);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      if (req.method === "GET" && url.pathname.startsWith("/object_info/")) {
        const name = decodeURIComponent(url.pathname.slice("/object_info/".length));
        return send(res, 200, state.info[name] ? { [name]: state.info[name] } : {});
      }
      if (req.method === "GET" && url.pathname === "/queue") {
        return send(res, 200, {
          queue_running: state.running.map((item, index) => entry(item, index)),
          queue_pending: state.pending.map((item, index) => entry(item, state.running.length + index)),
        });
      }
      if (req.method === "GET" && url.pathname === "/history") {
        return send(res, 200, state.history);
      }
      if (req.method === "GET" && url.pathname.startsWith("/history/")) {
        const id = decodeURIComponent(url.pathname.slice("/history/".length));
        return send(res, 200, state.history[id] ? { [id]: state.history[id] } : {});
      }
      if (req.method === "POST" && url.pathname === "/prompt") {
        if (state.refuse) {
          return send(res, 400, state.refuse);
        }
        const id = `p${state.nextId++}`;
        state.posted.push(body);
        state.pending.push({ id, prompt: body.prompt, extra: body.extra_data || {} });
        return send(res, 200, { prompt_id: id, number: state.nextId, node_errors: {} });
      }
      if (req.method === "POST" && url.pathname === "/queue") {
        const ids = body?.delete || [];
        state.deleted.push(...ids);
        state.pending = state.pending.filter((item) => !ids.includes(item.id));
        return send(res, 200, "");
      }
      if (req.method === "POST" && url.pathname === "/free") {
        state.freed += 1;
        return send(res, 200, "");
      }
      return send(res, 404, { error: "not found" });
    });
  });

  return {
    state,
    get url() {
      return `http://127.0.0.1:${server.address().port}`;
    },
    listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
    // The next pending prompt starts rendering.
    startNext() {
      const item = state.pending.shift();
      if (item) state.running.push(item);
      return item;
    },
    // A running or pending prompt finishes with this history entry.
    finish(id, historyEntry) {
      state.running = state.running.filter((item) => item.id !== id);
      state.pending = state.pending.filter((item) => item.id !== id);
      state.history[id] = historyEntry;
    },
    // ComfyUI restarts: its queue is gone and nothing reaches its history.
    crash() {
      state.running = [];
      state.pending = [];
    },
  };
}

function historyEntry({ ok = true, message = "", nodeType = "KSamplerAdvanced", file = null, interrupted = false } = {}) {
  const messages = [["execution_start", { timestamp: 1_000 }]];
  if (interrupted) messages.push(["execution_interrupted", { timestamp: 31_000 }]);
  else if (ok) messages.push(["execution_success", { timestamp: 61_000 }]);
  else messages.push(["execution_error", { timestamp: 61_000, node_type: nodeType, exception_message: message }]);
  return {
    status: { status_str: ok && !interrupted ? "success" : "error", completed: true, messages },
    outputs: file ? { 9: { images: [{ filename: file.filename, subfolder: file.subfolder, type: "output" }] } } : {},
  };
}

module.exports = { createFakeComfyUi, historyEntry };
