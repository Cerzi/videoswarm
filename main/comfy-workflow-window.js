const { parseComfyUrl } = require("./comfy-connection");

// A clip's workflow in the user's own ComfyUI, inside Video Swarm: one window
// showing the loopback ComfyUI page, into which the clip's embedded workflow
// is loaded as if it had been dropped on the canvas. See
// docs/architecture/comfy-workflow-window.md.
//
// The window is web content from another program, so it gets nothing of
// Video Swarm's: no preload, a sandboxed renderer, its own in-memory session,
// and requests only to that ComfyUI. ComfyUI features that reach the internet
// (templates, release notes, the manager's registry) do not work in it.

const PARTITION = "videoswarm-comfyui";
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;
const MAX_GRAPH_CHARS = 64 * 1024 * 1024;
const PASSIVE_SCHEMES = new Set(["data:", "blob:", "devtools:"]);

class ComfyWorkflowWindowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ComfyWorkflowWindowError";
    this.code = code;
  }
}

// ComfyUI's app object, under either frontend.
const APP = "(window.app || window.comfyAPI?.app?.app)";
const READY_PROBE = `(() => { const a = ${APP}; return Boolean(a && (a.rootGraph || a.graph) && typeof a.loadGraphData === "function"); })()`;

/**
 * The page script that loads a graph. `graph` is the JSON text from the
 * clip; it is passed as a string literal and parsed by the page, exactly as
 * ComfyUI parses a dropped file.
 */
function loadGraphScript({ kind, graph, name }) {
  const text = JSON.stringify(graph);
  const label = JSON.stringify(name);
  if (kind === "workflow") {
    return `(async () => { const a = ${APP}; await a.loadGraphData(JSON.parse(${text}), true, true, ${label}); return true; })()`;
  }
  return `(async () => { const a = ${APP}; if (typeof a.loadApiJson !== "function") return false; await a.loadApiJson(JSON.parse(${text}), ${label}); return true; })()`;
}

/** Whether a request from the window may go out: only to that ComfyUI. */
function isAllowedRequest(url, origin) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (PASSIVE_SCHEMES.has(parsed.protocol)) return true;
  const comfy = new URL(origin);
  if (parsed.host !== comfy.host) return false;
  if (parsed.protocol === comfy.protocol) return true;
  // ComfyUI's live updates use a WebSocket on the same host and port.
  return parsed.protocol === (comfy.protocol === "https:" ? "wss:" : "ws:");
}

function isSameOrigin(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** The graph to load from an embedded payload: the editor workflow if any. */
function graphFromPayload(payload) {
  for (const kind of ["workflow", "prompt"]) {
    const text = payload?.[kind];
    if (typeof text !== "string" || !text.trim() || text.length > MAX_GRAPH_CHARS) continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { kind, graph: text };
      }
    } catch {
      // Try the prompt.
    }
  }
  return null;
}

function createComfyWorkflowWindow({
  BrowserWindow,
  session,
  getUrl,
  probe,
  icon = undefined,
  logger = console,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
}) {
  let win = null;
  let winOrigin = null;
  let allowedOrigin = null;
  let sessionReady = false;
  let opening = Promise.resolve();

  function configureSession() {
    if (sessionReady) return;
    const comfySession = session.fromPartition(PARTITION);
    comfySession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !allowedOrigin || !isAllowedRequest(details.url, allowedOrigin) });
    });
    // Copying nodes is ComfyUI's only use of a permission worth granting.
    comfySession.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(permission === "clipboard-sanitized-write")
    );
    comfySession.setPermissionCheckHandler(
      (_contents, permission) => permission === "clipboard-sanitized-write"
    );
    sessionReady = true;
  }

  function createWindow(origin) {
    const created = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 640,
      minHeight: 400,
      title: "ComfyUI workflow",
      backgroundColor: "#1e1e1e",
      autoHideMenuBar: true,
      show: false,
      icon,
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        safeDialogs: true,
        navigateOnDragDrop: false,
      },
    });
    created.removeMenu?.();
    const contents = created.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    const keepToComfy = (event, url) => {
      if (!isSameOrigin(url, origin)) event.preventDefault();
    };
    contents.on("will-navigate", keepToComfy);
    contents.on("will-redirect", keepToComfy);
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("before-input-event", (event, input) => {
      if (
        input.type === "keyDown" &&
        (input.control || input.meta) &&
        String(input.key).toLowerCase() === "w"
      ) {
        event.preventDefault();
        created.close();
      }
    });
    created.once("ready-to-show", () => {
      if (!created.isDestroyed()) created.show();
    });
    created.on("closed", () => {
      if (win === created) {
        win = null;
        winOrigin = null;
      }
    });
    return created;
  }

  async function waitUntilReady(target) {
    const deadline = now() + READY_TIMEOUT_MS;
    for (;;) {
      if (target.isDestroyed()) {
        throw new ComfyWorkflowWindowError("COMFY_WINDOW_CLOSED", "The workflow window was closed");
      }
      try {
        if (await target.webContents.executeJavaScript(READY_PROBE, true)) return;
      } catch {
        // The page is still loading.
      }
      if (now() >= deadline) {
        throw new ComfyWorkflowWindowError(
          "COMFY_NOT_READY",
          "ComfyUI opened but did not finish loading in time"
        );
      }
      await sleep(READY_POLL_MS);
    }
  }

  async function openNow({ payload, name }) {
    const origin = parseComfyUrl(getUrl());
    const graph = graphFromPayload(payload);
    if (!graph) {
      throw new ComfyWorkflowWindowError(
        "COMFY_NO_WORKFLOW",
        "This clip carries no ComfyUI workflow"
      );
    }
    await probe(origin);
    configureSession();
    allowedOrigin = origin;

    if (win && !win.isDestroyed() && winOrigin !== origin) {
      win.destroy();
      win = null;
    }
    let target = win;
    if (!target || target.isDestroyed()) {
      target = createWindow(origin);
      win = target;
      winOrigin = origin;
      target.loadURL(`${origin}/`).catch((error) => {
        logger.warn?.("[comfy-window] ComfyUI page failed to load", error?.message || error);
      });
    } else {
      if (target.isMinimized()) target.restore();
      target.show();
      target.focus();
    }

    await waitUntilReady(target);
    const loaded = await target.webContents.executeJavaScript(
      loadGraphScript({ ...graph, name }),
      true
    );
    if (loaded !== true) {
      throw new ComfyWorkflowWindowError(
        "COMFY_PROMPT_ONLY",
        "This clip carries only a prompt, which this ComfyUI cannot open as a workflow"
      );
    }
    if (!target.isDestroyed()) {
      target.show();
      target.focus();
    }
    return { kind: graph.kind };
  }

  return {
    /** Opens (or reuses) the window and loads `payload`'s graph into it. */
    open(request) {
      const next = opening.then(
        () => openNow(request),
        () => openNow(request)
      );
      opening = next.catch(() => {});
      return next;
    },
    close() {
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
      winOrigin = null;
    },
    isOpen: () => Boolean(win && !win.isDestroyed()),
  };
}

module.exports = {
  ComfyWorkflowWindowError,
  PARTITION,
  createComfyWorkflowWindow,
  graphFromPayload,
  isAllowedRequest,
  loadGraphScript,
};
