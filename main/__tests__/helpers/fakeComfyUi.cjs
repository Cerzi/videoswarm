// A fake ComfyUI for tests: a real HTTP server on 127.0.0.1 answering the
// read-only endpoints Video Swarm's connection test uses, driven by the
// test. Tests never talk to a real ComfyUI.
const http = require("http");
const { URL } = require("url");

function createFakeComfyUi({ info = {} } = {}) {
  const state = {
    info,
    running: 0,
    pending: 0,
    requests: [],
    down: false,
    // Extra bytes padded onto every answer, to test the size bound.
    padding: 0,
  };

  const send = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(state.padding ? `${text}${" ".repeat(state.padding)}` : text);
  };
  const items = (count, offset) =>
    Array.from({ length: count }, (_, index) => [offset + index, `p${offset + index}`, {}, {}, []]);

  const server = http.createServer((req, res) => {
    if (state.down) {
      req.socket.destroy();
      return;
    }
    const url = new URL(req.url, "http://127.0.0.1");
    state.requests.push(`${req.method} ${url.pathname}`);
    if (req.method === "GET" && url.pathname.startsWith("/object_info/")) {
      const name = decodeURIComponent(url.pathname.slice("/object_info/".length));
      return send(res, 200, state.info[name] ? { [name]: state.info[name] } : {});
    }
    if (req.method === "GET" && url.pathname === "/queue") {
      return send(res, 200, {
        queue_running: items(state.running, 0),
        queue_pending: items(state.pending, state.running),
      });
    }
    return send(res, 404, { error: "not found" });
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
  };
}

module.exports = { createFakeComfyUi };
