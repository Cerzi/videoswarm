// A fake companion app for tests: a real HTTP server on 127.0.0.1 speaking
// companion protocol v1 (docs/architecture/companion-app.md), driven by the
// test. Clips, actions and labels are made up; tests never talk to a real
// companion.
const http = require("http");
const { Buffer } = require("buffer");
const { URL } = require("url");

const DEFAULT_DESCRIPTION = Object.freeze({
  protocol: 1,
  name: "Fake companion",
  actions: [
    { id: "polish", label: "Polish", send: "Send to polish", hint: "Makes a better copy", quick: true },
    { id: "enlarge", label: "Enlarge", send: "Send to enlarge" },
  ],
});

// An app whose action sends into a target the user picks (a project),
// adding to it, and can take adds back. Made-up names throughout.
const TARGET_DESCRIPTION = Object.freeze({
  protocol: 1,
  name: "Fake editor",
  actions: [
    {
      id: "add",
      label: "Add to project",
      send: "Add to",
      pick: "Add to project…",
      withdraw: true,
      targets: { label: "Project", new: "New project…" },
    },
  ],
});

function createFakeCompanion({ description = DEFAULT_DESCRIPTION } = {}) {
  const state = {
    description,
    // Targets for actions that have them: [{ id, label, detail, current }].
    targets: [],
    // target id -> Map(path -> client that added it)
    members: new Map(),
    // path -> { kind, chip, actions: { id: { phase, why } } }
    clips: new Map(),
    requests: [],
    down: false,
    refuse: null,
    // (action, path, again) -> { result, why, estimate }
    plan: null,
  };

  const reply = (res, status, body) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(text);
  };

  const server = http.createServer((req, res) => {
    if (state.down) {
      req.socket.destroy();
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const host = String(req.headers.host || "");
      const type = String(req.headers["content-type"] || "");
      state.requests.push({ method: req.method, path: url.pathname, host, type });
      // As a real companion should: JSON only, from a local Host only.
      if (!type.startsWith("application/json") || !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/u.test(host)) {
        return reply(res, 403, { error: "Forbidden" });
      }
      let body;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      } catch {
        return reply(res, 400, { error: "Bad JSON" });
      }
      state.requests.at(-1).body = body;
      if (state.refuse) return reply(res, state.refuse.status, state.refuse.body);
      if (req.method !== "POST") return reply(res, 405, { error: "POST only" });

      if (url.pathname === "/api/describe") return reply(res, 200, state.description);

      const declared = state.description.actions.find((action) => action.id === body.action);
      if (url.pathname === "/api/targets") return reply(res, 200, { targets: state.targets });

      if (declared?.targets && (url.pathname === "/api/send" || url.pathname === "/api/withdraw")) {
        let target = null;
        if (typeof body.target === "string") {
          target = state.targets.find((entry) => entry.id === body.target) || null;
          if (!target) return reply(res, 404, { error: "No such project" });
        } else if (body.target && typeof body.target.new === "string") {
          target = { id: `/projects/${body.target.new}`, label: body.target.new, detail: "New", current: false };
          if (!body.dry_run && url.pathname === "/api/send") {
            state.targets.unshift(target);
            state.members.set(target.id, new Map());
          }
        }
        const members = (target && state.members.get(target.id)) || new Map();
        const results = {};
        for (const filePath of body.paths || []) {
          if (url.pathname === "/api/withdraw") {
            if (members.get(filePath) === body.client) {
              members.delete(filePath);
              results[filePath] = { result: "withdrawn", why: "" };
            } else {
              results[filePath] = { result: "skipped", why: "Not added by this app" };
            }
          } else if (!target) {
            results[filePath] = { result: "refused", why: "Choose a project" };
          } else if (members.has(filePath)) {
            results[filePath] = { result: "skipped", why: `Already in ${target.label}` };
          } else {
            results[filePath] = { result: "sent", why: "" };
            if (!body.dry_run) {
              if (!state.members.has(target.id)) state.members.set(target.id, members);
              members.set(filePath, body.client);
            }
          }
        }
        return reply(res, 200, {
          results,
          ...(target ? { target: { id: target.id, label: target.label } } : {}),
          dry_run: body.dry_run === true,
        });
      }

      if (url.pathname === "/api/lookup") {
        const clips = {};
        const current = state.targets.find((entry) => entry.current);
        for (const filePath of body.paths || []) {
          const added = current && state.members.get(current.id)?.has(filePath);
          if (added) {
            clips[filePath] = {
              kind: "video",
              chip: { label: `In ${current.label}`, tone: "done" },
              actions: { add: { phase: "done", why: `In ${current.label}` } },
            };
            continue;
          }
          clips[filePath] = state.clips.get(filePath) || {
            kind: "video",
            chip: null,
            actions: Object.fromEntries(
              state.description.actions.map((action) => [action.id, { phase: "not-sent", why: "" }])
            ),
          };
        }
        return reply(res, 200, { clips });
      }

      if (url.pathname === "/api/send") {
        // As the protocol says: stars by sent path, whole numbers 0 to 5.
        if (
          body.ratings !== undefined &&
          (!body.ratings ||
            typeof body.ratings !== "object" ||
            Array.isArray(body.ratings) ||
            Object.values(body.ratings).some(
              (value) => typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 5
            ))
        ) {
          return reply(res, 400, { error: "ratings should map paths to a number of stars from 0 to 5" });
        }
        const results = {};
        for (const filePath of body.paths || []) {
          const planned = state.plan?.(body.action, filePath, body.again === true) || {
            result: "sent",
            why: "",
            estimate: 60,
          };
          results[filePath] = planned;
          if (!body.dry_run && planned.result === "sent") {
            const clip = state.clips.get(filePath) || { kind: "render", chip: null, actions: {} };
            clip.actions = { ...clip.actions, [body.action]: { phase: "under-way", why: "Waiting" } };
            clip.chip = { label: `${body.action} waiting`, tone: "progress" };
            state.clips.set(filePath, clip);
          }
        }
        return reply(res, 200, { results, dry_run: body.dry_run === true });
      }
      return reply(res, 404, { error: "Not found" });
    });
  });

  return {
    state,
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    async stop() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { createFakeCompanion, DEFAULT_DESCRIPTION, TARGET_DESCRIPTION };
