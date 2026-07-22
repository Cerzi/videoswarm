import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  assertInteger,
  assertPathString,
  assertPayloadSize,
  assertPngDataUrlDimensions,
  assertStringArray,
  createIpcTrustValidator,
  createPathAuthority,
  createTrustedIpcRegistrar,
  isAllowedFrameUrl,
  isPathInsideRoot,
} = require("../ipc-security");

const temporaryDirectories = new Set();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-ipc-"));
  temporaryDirectories.add(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

function trustedFixture(frameUrl = "file:///opt/videoswarm/dist-react/index.html") {
  const frame = { url: frameUrl };
  const sender = {
    id: 17,
    mainFrame: frame,
    isDestroyed: vi.fn(() => false),
  };
  const win = {
    webContents: sender,
    isDestroyed: vi.fn(() => false),
  };
  const validator = createIpcTrustValidator({
    getMainWindow: () => win,
    allowedFrameUrls: ["file:///opt/videoswarm/dist-react/index.html"],
    allowedOrigins: ["http://localhost:6173"],
  });
  return { frame, sender, win, validator, event: { sender, senderFrame: frame } };
}

describe("IPC sender trust", () => {
  it("keeps unsupported response-only directives out of the meta CSP", () => {
    const html = fs.readFileSync(path.resolve(process.cwd(), "index.html"), "utf8");
    const content = html.match(
      /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/
    )?.[1];

    expect(content).toBeTruthy();
    expect(content).toContain("frame-src 'none'");
    expect(content).not.toContain("frame-ancestors");
  });

  it("accepts only the live main frame and returns immutable context", () => {
    const { validator, event, sender } = trustedFixture();
    const context = validator(event);
    expect(context).toEqual(
      expect.objectContaining({ sender, senderId: 17, frameUrl: event.senderFrame.url })
    );
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("allows a configured dev origin but not a lookalike origin", () => {
    expect(
      isAllowedFrameUrl("http://localhost:6173/src/index.html?x=1", {
        allowedOrigins: ["http://localhost:6173"],
      })
    ).toBe(true);
    expect(
      isAllowedFrameUrl("http://localhost:6173.evil.test/index.html", {
        allowedOrigins: ["http://localhost:6173"],
      })
    ).toBe(false);
  });

  it("rejects a different sender, a subframe, and an unauthorized URL", () => {
    const { validator, event, sender } = trustedFixture();
    expect(() => validator({ ...event, sender: { ...sender } })).toThrow(
      expect.objectContaining({ code: "UNTRUSTED_SENDER" })
    );
    expect(() => validator({ ...event, senderFrame: { url: event.senderFrame.url } })).toThrow(
      expect.objectContaining({ code: "UNTRUSTED_FRAME" })
    );
    event.senderFrame.url = "https://evil.test/";
    expect(() => validator(event)).toThrow(
      expect.objectContaining({ code: "UNTRUSTED_ORIGIN" })
    );
  });

  it("wraps invoke and event listeners and disposes all registrations", async () => {
    const invokeHandlers = new Map();
    const eventHandlers = new Map();
    const ipcMain = {
      handle: vi.fn((channel, handler) => invokeHandlers.set(channel, handler)),
      on: vi.fn((channel, handler) => eventHandlers.set(channel, handler)),
      removeHandler: vi.fn((channel) => invokeHandlers.delete(channel)),
      removeListener: vi.fn((channel) => eventHandlers.delete(channel)),
    };
    const { validator, event } = trustedFixture();
    const trustedValidator = vi.fn(validator);
    const registrar = createTrustedIpcRegistrar({
      ipcMain,
      assertTrustedSender: trustedValidator,
    });
    const invokeListener = vi.fn(async (_event, value) => value * 2);
    const eventListener = vi.fn();
    registrar.handle("secure:invoke", invokeListener, {
      validate: ([value]) => [assertInteger(value, { min: 1, max: 10 })],
    });
    registrar.handle("secure:bounded", async (_event, value) => value);
    registrar.on("secure:event", eventListener);

    await expect(invokeHandlers.get("secure:invoke")(event, 4)).resolves.toBe(8);
    await expect(invokeHandlers.get("secure:invoke")(event, 40)).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
    });
    await expect(
      invokeHandlers.get("secure:bounded")(event, "x".repeat(5 * 1024 * 1024))
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    await eventHandlers.get("secure:event")(event, "ok");
    expect(eventListener).toHaveBeenCalledWith(event, "ok");
    const invokeTrustContext = trustedValidator.mock.calls.find(
      ([, context]) => context?.channel === "secure:invoke"
    )?.[1];
    const eventTrustContext = trustedValidator.mock.calls.find(
      ([, context]) => context?.channel === "secure:event"
    )?.[1];
    expect(invokeTrustContext).toEqual({ channel: "secure:invoke" });
    expect(eventTrustContext).toEqual({ channel: "secure:event" });
    expect(Object.isFrozen(invokeTrustContext)).toBe(true);
    expect(Object.isFrozen(eventTrustContext)).toBe(true);

    registrar.dispose();
    expect(ipcMain.removeHandler).toHaveBeenCalledWith("secure:invoke");
    expect(ipcMain.removeListener).toHaveBeenCalledWith(
      "secure:event",
      expect.any(Function)
    );
  });
});

describe("IPC payload validation", () => {
  it("normalizes absolute paths and rejects traversal-shaped relative input", () => {
    expect(assertPathString(" /tmp/library/clip.mp4 ")).toBe(
      path.resolve("/tmp/library/clip.mp4")
    );
    expect(() => assertPathString("../etc/passwd")).toThrow(
      expect.objectContaining({ code: "INVALID_PATH" })
    );
    expect(() => assertPathString("/tmp/a\0b")).toThrow();
  });

  it("bounds and deduplicates string arrays", () => {
    expect(
      assertStringArray(["one", "one", "two"], {
        maxEntries: 3,
        item: { minChars: 1, maxChars: 8 },
      })
    ).toEqual(["one", "two"]);
    expect(() => assertStringArray(["one", "two"], { maxEntries: 1 })).toThrow(
      expect.objectContaining({ code: "INVALID_PAYLOAD" })
    );
  });

  it("rejects oversized and unserializable payloads", () => {
    expect(assertPayloadSize({ ok: true }, 64)).toEqual({ ok: true });
    expect(() => assertPayloadSize({ value: "x".repeat(100) }, 32)).toThrow(
      expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" })
    );
    const cyclic = {};
    cyclic.self = cyclic;
    expect(() => assertPayloadSize(cyclic)).toThrow(
      expect.objectContaining({ code: "INVALID_PAYLOAD" })
    );
  });
});

describe("clipboard image validation", () => {
  function pngDataUrl(width, height) {
    const header = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write("IHDR", 12, "ascii");
    header.writeUInt32BE(width, 16);
    header.writeUInt32BE(height, 20);
    return `data:image/png;base64,${header.toString("base64")}`;
  }

  it("accepts ordinary frame dimensions before native decoding", () => {
    expect(assertPngDataUrlDimensions(pngDataUrl(3840, 2160))).toEqual({
      width: 3840,
      height: 2160,
      pixels: 8_294_400,
    });
  });

  it("rejects oversized, amplified, and malformed image headers", () => {
    expect(() => assertPngDataUrlDimensions(pngDataUrl(8193, 1))).toThrow(
      expect.objectContaining({ code: "IMAGE_DIMENSIONS_TOO_LARGE" })
    );
    expect(() => assertPngDataUrlDimensions(pngDataUrl(8192, 8192))).toThrow(
      expect.objectContaining({ code: "IMAGE_DIMENSIONS_TOO_LARGE" })
    );
    expect(() =>
      assertPngDataUrlDimensions("data:image/png;base64,bm90LXBuZw==")
    ).toThrow(expect.objectContaining({ code: "INVALID_IMAGE_DATA" }));
  });
});

describe("profile- and owner-scoped path authority", () => {
  it("authorizes canonical files below a granted root only", async () => {
    const base = temporaryDirectory();
    const root = path.join(base, "library");
    const sibling = path.join(base, "library-escape");
    fs.mkdirSync(root);
    fs.mkdirSync(sibling);
    const inside = path.join(root, "clip.mp4");
    const outside = path.join(sibling, "clip.mp4");
    fs.writeFileSync(inside, "inside");
    fs.writeFileSync(outside, "outside");
    const authority = createPathAuthority();

    await authority.grantRoot({ ownerId: 1, scopeId: "profile-a", rootPath: root });
    await expect(
      authority.assertAuthorizedPath({
        ownerId: 1,
        scopeId: "profile-a",
        targetPath: inside,
        kind: "file",
      })
    ).resolves.toEqual({
      path: fs.realpathSync(inside),
      rootPath: fs.realpathSync(root),
    });
    await expect(
      authority.assertAuthorizedPath({
        ownerId: 1,
        scopeId: "profile-a",
        targetPath: outside,
      })
    ).rejects.toMatchObject({ code: "PATH_NOT_AUTHORIZED" });
    await expect(
      authority.assertAuthorizedPath({
        ownerId: 2,
        scopeId: "profile-a",
        targetPath: inside,
      })
    ).rejects.toMatchObject({ code: "PATH_NOT_AUTHORIZED" });
    await expect(
      authority.assertAuthorizedPath({
        ownerId: 1,
        scopeId: "profile-b",
        targetPath: inside,
      })
    ).rejects.toMatchObject({ code: "PATH_NOT_AUTHORIZED" });
  });

  it("resolves symlinks before containment checks", async () => {
    const base = temporaryDirectory();
    const root = path.join(base, "library");
    const outside = path.join(base, "outside.mp4");
    const symlink = path.join(root, "escape.mp4");
    fs.mkdirSync(root);
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, symlink);
    const authority = createPathAuthority();
    await authority.grantRoot({ ownerId: 1, scopeId: "profile", rootPath: root });

    await expect(
      authority.assertAuthorizedPath({
        ownerId: 1,
        scopeId: "profile",
        targetPath: symlink,
      })
    ).rejects.toMatchObject({ code: "PATH_NOT_AUTHORIZED" });
  });

  it("revokes owner and scope grants and releases all state on dispose", async () => {
    const root = temporaryDirectory();
    const authority = createPathAuthority();
    await authority.grantRoot({ ownerId: 1, scopeId: "one", rootPath: root });
    await authority.grantRoot({ ownerId: 1, scopeId: "two", rootPath: root });
    await authority.grantRoot({ ownerId: 2, scopeId: "two", rootPath: root });
    expect(authority.snapshot()).toMatchObject({ scopes: 2, owners: 3, roots: 3 });
    expect(authority.revokeOwner(1)).toBe(2);
    expect(authority.revokeScope("two")).toBe(1);
    expect(authority.snapshot()).toMatchObject({ scopes: 0, owners: 0, roots: 0 });
    expect(authority.dispose()).toBe(true);
    await expect(
      authority.grantRoot({ ownerId: 1, scopeId: "one", rootPath: root })
    ).rejects.toMatchObject({ code: "PATH_AUTHORITY_DISPOSED" });
  });

  it("evicts the least-recent root instead of permanently exhausting authority", async () => {
    const first = temporaryDirectory();
    const second = temporaryDirectory();
    const firstFile = path.join(first, "first.mp4");
    const secondFile = path.join(second, "second.mp4");
    fs.writeFileSync(firstFile, "first");
    fs.writeFileSync(secondFile, "second");
    const authority = createPathAuthority({ maxRootsPerOwner: 1 });

    await authority.grantRoot({ ownerId: 1, scopeId: "one", rootPath: first });
    await authority.grantRoot({ ownerId: 1, scopeId: "one", rootPath: second });

    await expect(
      authority.assertAuthorizedPath({
        ownerId: 1,
        scopeId: "one",
        targetPath: firstFile,
      })
    ).rejects.toMatchObject({ code: "PATH_NOT_AUTHORIZED" });
    await expect(
      authority.assertAuthorizedPath({
        ownerId: 1,
        scopeId: "one",
        targetPath: secondFile,
      })
    ).resolves.toMatchObject({ path: fs.realpathSync(secondFile) });
    expect(authority.snapshot()).toMatchObject({ roots: 1 });
    authority.dispose();
  });

  it("rejects an authorization whose scope is revoked during realpath", async () => {
    const root = temporaryDirectory();
    const filePath = path.join(root, "clip.mp4");
    fs.writeFileSync(filePath, "clip");
    const realpathGate = deferred();
    let delayTarget = false;
    const fsApi = {
      ...fs.promises,
      realpath: vi.fn(async (candidate) => {
        if (delayTarget && path.resolve(candidate) === path.resolve(filePath)) {
          await realpathGate.promise;
        }
        return fs.promises.realpath(candidate);
      }),
    };
    const authority = createPathAuthority({ fsApi });
    await authority.grantRoot({ ownerId: 1, scopeId: "one", rootPath: root });
    delayTarget = true;

    const pending = authority.assertAuthorizedPath({
      ownerId: 1,
      scopeId: "one",
      targetPath: filePath,
      kind: "file",
    });
    await vi.waitFor(() => expect(fsApi.realpath).toHaveBeenCalledTimes(2));
    authority.revokeScope("one");
    realpathGate.resolve();

    await expect(pending).rejects.toMatchObject({ code: "PATH_NOT_AUTHORIZED" });
    authority.dispose();
  });

  it("uses path-segment containment rather than string prefixes", () => {
    expect(isPathInsideRoot("/tmp/library", "/tmp/library/a.mp4")).toBe(true);
    expect(isPathInsideRoot("/tmp/library", "/tmp/library-escape/a.mp4")).toBe(false);
  });
});
