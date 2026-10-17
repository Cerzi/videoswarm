import { createRequire } from "module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  PARTITION,
  createComfyWorkflowWindow,
  graphFromPayload,
  isAllowedRequest,
  loadGraphScript,
} = require("../comfy-workflow-window");

const ORIGIN = "http://127.0.0.1:8188";
const WORKFLOW = JSON.stringify({ nodes: [{ id: 1 }], links: [] });
const PROMPT = JSON.stringify({ 1: { class_type: "KSampler", inputs: {} } });

function createFakes({ readyAfter = 0, loadResult = true } = {}) {
  const windows = [];
  const sessionHandlers = {};
  const fakeSession = {
    webRequest: {
      onBeforeRequest: vi.fn((handler) => {
        sessionHandlers.request = handler;
      }),
    },
    setPermissionRequestHandler: vi.fn((handler) => {
      sessionHandlers.permission = handler;
    }),
    setPermissionCheckHandler: vi.fn((handler) => {
      sessionHandlers.check = handler;
    }),
  };
  const session = { fromPartition: vi.fn(() => fakeSession) };

  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.listeners = {};
      this.contentsListeners = {};
      this.scripts = [];
      let probes = 0;
      this.webContents = {
        setWindowOpenHandler: vi.fn((handler) => {
          this.openHandler = handler;
        }),
        on: (name, handler) => {
          this.contentsListeners[name] = handler;
        },
        executeJavaScript: vi.fn(async (code) => {
          this.scripts.push(code);
          if (code.includes("loadGraphData === \"function\"")) {
            probes += 1;
            return probes > readyAfter;
          }
          return loadResult;
        }),
      };
      this.loadURL = vi.fn(async () => {});
      this.show = vi.fn();
      this.focus = vi.fn();
      this.close = vi.fn();
      this.restore = vi.fn();
      this.removeMenu = vi.fn();
      windows.push(this);
    }
    once(name, handler) {
      this.listeners[name] = handler;
    }
    on(name, handler) {
      this.listeners[name] = handler;
    }
    isDestroyed() {
      return this.destroyed;
    }
    isMinimized() {
      return false;
    }
    destroy() {
      this.destroyed = true;
      this.listeners.closed?.();
    }
  }

  return { BrowserWindow: FakeWindow, session, sessionHandlers, windows };
}

function createViewer(fakes, extra = {}) {
  return createComfyWorkflowWindow({
    BrowserWindow: fakes.BrowserWindow,
    session: fakes.session,
    getUrl: () => ORIGIN,
    probe: vi.fn(async () => ({})),
    sleep: async () => {},
    logger: { warn: vi.fn() },
    ...extra,
  });
}

describe("comfy workflow window helpers", () => {
  it("prefers the editor workflow and falls back to the prompt", () => {
    expect(graphFromPayload({ workflow: WORKFLOW, prompt: PROMPT })).toEqual({
      kind: "workflow",
      graph: WORKFLOW,
    });
    expect(graphFromPayload({ workflow: "not json", prompt: PROMPT })).toEqual({
      kind: "prompt",
      graph: PROMPT,
    });
    expect(graphFromPayload({ prompt: "[1,2]" })).toBeNull();
    expect(graphFromPayload(null)).toBeNull();
  });

  it("lets the window reach only that ComfyUI and its live socket", () => {
    expect(isAllowedRequest(`${ORIGIN}/api/object_info`, ORIGIN)).toBe(true);
    expect(isAllowedRequest("ws://127.0.0.1:8188/ws?clientId=1", ORIGIN)).toBe(true);
    expect(isAllowedRequest("data:image/png;base64,AA", ORIGIN)).toBe(true);
    expect(isAllowedRequest("http://127.0.0.1:9000/", ORIGIN)).toBe(false);
    expect(isAllowedRequest("https://api.comfy.org/releases", ORIGIN)).toBe(false);
    expect(isAllowedRequest("wss://127.0.0.1:8188/ws", ORIGIN)).toBe(false);
    expect(isAllowedRequest("not a url", ORIGIN)).toBe(false);
  });

  it("passes the graph as a string literal the page parses", () => {
    const hostile = '{"a":"</script>\\"); alert(1); //"}';
    const script = loadGraphScript({ kind: "workflow", graph: hostile, name: 'a"b' });
    expect(script).toContain(`JSON.parse(${JSON.stringify(hostile)})`);
    expect(script).toContain(JSON.stringify('a"b'));
    expect(loadGraphScript({ kind: "prompt", graph: PROMPT, name: "x" })).toContain(
      "loadApiJson"
    );
  });
});

describe("createComfyWorkflowWindow", () => {
  it("opens an isolated window on the ComfyUI page and loads the workflow", async () => {
    const fakes = createFakes({ readyAfter: 2 });
    const viewer = createViewer(fakes);
    await expect(
      viewer.open({ payload: { workflow: WORKFLOW }, name: "clip_0001" })
    ).resolves.toEqual({ kind: "workflow" });

    expect(fakes.session.fromPartition).toHaveBeenCalledWith(PARTITION);
    const [win] = fakes.windows;
    expect(win.options.webPreferences).toMatchObject({
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    expect(win.options.webPreferences.preload).toBeUndefined();
    expect(win.loadURL).toHaveBeenCalledWith(`${ORIGIN}/`);
    expect(win.scripts.at(-1)).toContain("loadGraphData(JSON.parse(");
    expect(win.scripts.at(-1)).toContain('"clip_0001"');

    // Requests, new windows and navigation stay with that ComfyUI.
    const callback = vi.fn();
    fakes.sessionHandlers.request({ url: "https://example.com/x" }, callback);
    expect(callback).toHaveBeenCalledWith({ cancel: true });
    fakes.sessionHandlers.request({ url: `${ORIGIN}/api/queue` }, callback);
    expect(callback).toHaveBeenLastCalledWith({ cancel: false });
    expect(win.openHandler()).toEqual({ action: "deny" });
    const navigation = { preventDefault: vi.fn() };
    win.contentsListeners["will-navigate"](navigation, "https://example.com/");
    expect(navigation.preventDefault).toHaveBeenCalled();
    const permission = vi.fn();
    fakes.sessionHandlers.permission(null, "media", permission);
    expect(permission).toHaveBeenCalledWith(false);
  });

  it("reuses the open window and closes it on Ctrl+W", async () => {
    const fakes = createFakes();
    const viewer = createViewer(fakes);
    await viewer.open({ payload: { workflow: WORKFLOW }, name: "a" });
    await viewer.open({ payload: { workflow: WORKFLOW }, name: "b" });
    expect(fakes.windows).toHaveLength(1);
    expect(fakes.windows[0].focus).toHaveBeenCalled();

    const event = { preventDefault: vi.fn() };
    fakes.windows[0].contentsListeners["before-input-event"](event, {
      type: "keyDown",
      control: true,
      key: "w",
    });
    expect(fakes.windows[0].close).toHaveBeenCalled();
    viewer.close();
    expect(viewer.isOpen()).toBe(false);
  });

  it("refuses a clip without a graph and a ComfyUI that is not running", async () => {
    const fakes = createFakes();
    const probe = vi.fn(async () => {
      throw Object.assign(new Error("ComfyUI is not reachable"), { code: "COMFY_UNAVAILABLE" });
    });
    const viewer = createViewer(fakes, { probe });
    await expect(viewer.open({ payload: {}, name: "a" })).rejects.toMatchObject({
      code: "COMFY_NO_WORKFLOW",
    });
    await expect(
      viewer.open({ payload: { workflow: WORKFLOW }, name: "a" })
    ).rejects.toMatchObject({ code: "COMFY_UNAVAILABLE" });
    expect(fakes.windows).toHaveLength(0);
  });

  it("says when a ComfyUI cannot open a prompt-only clip", async () => {
    const fakes = createFakes({ loadResult: false });
    const viewer = createViewer(fakes);
    await expect(
      viewer.open({ payload: { prompt: PROMPT }, name: "a" })
    ).rejects.toMatchObject({ code: "COMFY_PROMPT_ONLY" });
  });

  it("gives up when the page never becomes ready", async () => {
    const fakes = createFakes({ readyAfter: Infinity });
    let clock = 0;
    const viewer = createViewer(fakes, {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    await expect(
      viewer.open({ payload: { workflow: WORKFLOW }, name: "a" })
    ).rejects.toMatchObject({ code: "COMFY_NOT_READY" });
  });
});
