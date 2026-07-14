import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  createSettingsWriter,
  readSettingsFileBounded,
  serializeSettings,
  writeFileAtomically,
} = require("../settings-writer");

const temporaryDirectories = new Set();

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-settings-"));
  temporaryDirectories.add(directory);
  return directory;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function deferredSettingsRead(contents = "{}") {
  const bytes = Buffer.from(contents);
  const started = deferred();
  const release = deferred();
  const close = vi.fn(async () => {});
  const handle = {
    stat: vi.fn(async () => ({ size: bytes.length, isFile: () => true })),
    read: vi.fn(async (buffer, offset, length, position) => {
      if (position === 0) {
        started.resolve();
        await release.promise;
      }
      const bytesRead = Math.max(
        0,
        Math.min(length, bytes.length - position)
      );
      if (bytesRead > 0) {
        bytes.copy(buffer, offset, position, position + bytesRead);
      }
      return { bytesRead };
    }),
    close,
  };
  return {
    started,
    release,
    close,
    fsApi: {
      ...fs.promises,
      open: vi.fn(async () => handle),
    },
  };
}

function writerFixture(options = {}) {
  const base = temporaryDirectory();
  const writer = createSettingsWriter({
    resolvePath: (profileId) => path.join(base, profileId, "settings.json"),
    ...options,
  });
  return {
    base,
    writer,
    settingsPath: (profileId) => path.join(base, profileId, "settings.json"),
  };
}

function createManualClock() {
  let currentTime = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => currentTime,
    setTimeout: (callback, delay) => {
      const id = ++sequence;
      timers.set(id, { callback, dueAt: currentTime + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    async advance(milliseconds) {
      currentTime += milliseconds;
      while (true) {
        const ready = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= currentTime)
          .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
        if (!ready) break;
        timers.delete(ready[0]);
        await ready[1].callback();
      }
    },
    count: () => timers.size,
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe("atomic settings persistence", () => {
  it("writes a complete JSON file through a same-directory atomic rename", async () => {
    const base = temporaryDirectory();
    const destination = path.join(base, "profile", "settings.json");
    await writeFileAtomically(destination, '{"value":1}', { sequence: 1 });
    expect(fs.readFileSync(destination, "utf8")).toBe('{"value":1}');
    expect(fs.readdirSync(path.dirname(destination))).toEqual(["settings.json"]);
  });

  it("leaves the previous file intact and removes its temporary file when rename fails", async () => {
    const base = temporaryDirectory();
    const destination = path.join(base, "settings.json");
    fs.writeFileSync(destination, "old");
    const failingFs = {
      ...fs.promises,
      rename: vi.fn(async () => {
        const error = new Error("rename failed");
        error.code = "EIO";
        throw error;
      }),
    };

    await expect(
      writeFileAtomically(destination, "new", { fsApi: failingFs, sequence: 2 })
    ).rejects.toThrow("rename failed");
    expect(fs.readFileSync(destination, "utf8")).toBe("old");
    expect(fs.readdirSync(base)).toEqual(["settings.json"]);
  });

  it("rejects oversized or cyclic settings before any write", () => {
    expect(() => serializeSettings({ value: "x".repeat(100) }, 32)).toThrow(
      expect.objectContaining({ code: "SETTINGS_TOO_LARGE" })
    );
    const cyclic = {};
    cyclic.self = cyclic;
    expect(() => serializeSettings(cyclic)).toThrow(
      expect.objectContaining({ code: "INVALID_SETTINGS" })
    );
  });

  it("rejects an oversized on-disk snapshot before parsing it", async () => {
    const base = temporaryDirectory();
    const destination = path.join(base, "settings.json");
    fs.writeFileSync(destination, JSON.stringify({ value: "x".repeat(128) }));
    const writer = createSettingsWriter({
      resolvePath: () => destination,
      maxBytes: 32,
    });

    await expect(writer.getSnapshot("default")).rejects.toMatchObject({
      code: "SETTINGS_TOO_LARGE",
    });
    await writer.dispose({ flush: false });
  });

  it("bounds a settings file that grows after its handle is statted", async () => {
    const close = vi.fn(async () => {});
    const contents = Buffer.from(JSON.stringify({ value: "x".repeat(64) }));
    const handle = {
      stat: vi.fn(async () => ({ size: 2, isFile: () => true })),
      read: vi.fn(async (buffer, offset, length, position) => {
        const bytesRead = Math.min(length, contents.length - position);
        contents.copy(buffer, offset, position, position + bytesRead);
        return { bytesRead };
      }),
      close,
    };

    await expect(
      readSettingsFileBounded("/virtual/settings.json", {
        fsApi: { open: vi.fn(async () => handle) },
        maxBytes: 32,
      })
    ).rejects.toMatchObject({ code: "SETTINGS_TOO_LARGE" });
    expect(handle.read).toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("serialized settings writer", () => {
  it("preserves every field across concurrent partial writes", async () => {
    const { writer, settingsPath } = writerFixture();
    writer.seed("default", { zoomLevel: 1, recursiveMode: false });

    await Promise.all([
      writer.patch("default", { zoomLevel: 2 }),
      writer.patch("default", { recursiveMode: true }),
      writer.patch("default", { showFilenames: false }),
    ]);

    expect(JSON.parse(fs.readFileSync(settingsPath("default"), "utf8"))).toEqual({
      zoomLevel: 2,
      recursiveMode: true,
      showFilenames: false,
    });
    expect(writer.snapshot()).toMatchObject({ dirtyProfiles: 0, writingProfiles: 0 });
    await writer.dispose();
  });

  it("debounces noisy updates and flushes the latest merged snapshot", async () => {
    const clock = createManualClock();
    const { writer, settingsPath } = writerFixture({
      clock,
      debounceMs: 100,
      maxWaitMs: 500,
    });
    writer.seed("default", { windowBounds: { width: 800 } });
    await writer.patch(
      "default",
      { windowBounds: { width: 900 } },
      { debounce: true }
    );
    await writer.patch(
      "default",
      { windowBounds: { width: 1000 } },
      { debounce: true }
    );

    expect(fs.existsSync(settingsPath("default"))).toBe(false);
    expect(writer.snapshot()).toMatchObject({ dirtyProfiles: 1, scheduledProfiles: 1 });
    await clock.advance(99);
    expect(fs.existsSync(settingsPath("default"))).toBe(false);
    await clock.advance(1);
    expect(JSON.parse(fs.readFileSync(settingsPath("default"), "utf8"))).toEqual({
      windowBounds: { width: 1000 },
    });
    await writer.dispose();
  });

  it("forces a pending debounced write through flush", async () => {
    const clock = createManualClock();
    const { writer, settingsPath } = writerFixture({ debounceMs: 10_000, clock });
    writer.seed("default", { sortKey: "name" });
    await writer.patch("default", { sortKey: "created" }, { debounce: true });

    await writer.flush("default");
    expect(JSON.parse(fs.readFileSync(settingsPath("default"), "utf8"))).toEqual({
      sortKey: "created",
    });
    expect(clock.count()).toBe(0);
    await writer.dispose();
  });

  it("does not finish a flush while a settings snapshot is still loading", async () => {
    const pendingRead = deferredSettingsRead('{"value":1}');
    const { writer } = writerFixture({ fsApi: pendingRead.fsApi });
    const loading = writer.getSnapshot("default");
    await pendingRead.started.promise;

    let flushed = false;
    const flushing = writer.flush("default").then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);

    pendingRead.release.resolve();
    await expect(loading).resolves.toEqual({ value: 1 });
    await flushing;
    expect(flushed).toBe(true);
    await writer.dispose();
  });

  it("keeps a profile state owned until an in-flight load settles before forget", async () => {
    const pendingRead = deferredSettingsRead('{"value":2}');
    const { writer } = writerFixture({ fsApi: pendingRead.fsApi });
    const loading = writer.getSnapshot("retiring");
    await pendingRead.started.promise;

    let forgotten = false;
    const forgetting = writer.forget("retiring", { flush: false }).then(
      (result) => {
        forgotten = result;
      }
    );
    await Promise.resolve();
    expect(forgotten).toBe(false);
    expect(writer.snapshot().profiles).toBe(1);
    expect(() => writer.getSnapshot("retiring")).toThrow(
      expect.objectContaining({ code: "SETTINGS_PROFILE_RETIRING" })
    );

    pendingRead.release.resolve();
    await expect(loading).resolves.toEqual({ value: 2 });
    await forgetting;
    expect(forgotten).toBe(true);
    expect(writer.snapshot().profiles).toBe(0);
    expect(pendingRead.close).toHaveBeenCalledOnce();
    await writer.dispose();
  });

  it("honors the maximum wait while updates keep resetting the debounce", async () => {
    const clock = createManualClock();
    const { writer, settingsPath } = writerFixture({
      clock,
      debounceMs: 100,
      maxWaitMs: 250,
    });
    writer.seed("default", { value: 0 });
    await writer.patch("default", { value: 1 }, { debounce: true });
    await clock.advance(90);
    await writer.patch("default", { value: 2 }, { debounce: true });
    await clock.advance(90);
    await writer.patch("default", { value: 3 }, { debounce: true });

    await clock.advance(69);
    expect(fs.existsSync(settingsPath("default"))).toBe(false);
    await clock.advance(1);
    expect(JSON.parse(fs.readFileSync(settingsPath("default"), "utf8"))).toEqual({
      value: 3,
    });
    await writer.dispose();
  });

  it("normalizes an allowlisted schema before it enters memory or disk", async () => {
    const { writer, settingsPath } = writerFixture({
      normalizeSettings: (settings) => ({
        recursiveMode: Boolean(settings.recursiveMode),
        zoomLevel: Math.max(0, Math.min(3, Number(settings.zoomLevel) || 0)),
      }),
    });
    writer.seed("default", {
      recursiveMode: 1,
      zoomLevel: 99,
      unknown: "discarded",
    });
    await writer.patch("default", { zoomLevel: -5, injected: true });

    expect(await writer.getSnapshot("default")).toEqual({
      recursiveMode: true,
      zoomLevel: 0,
    });
    expect(JSON.parse(fs.readFileSync(settingsPath("default"), "utf8"))).toEqual({
      recursiveMode: true,
      zoomLevel: 0,
    });
    await writer.dispose();
  });

  it("keeps profile snapshots and files isolated", async () => {
    const { writer, settingsPath } = writerFixture();
    writer.seed("one", { value: 1 });
    writer.seed("two", { value: 2 });
    await Promise.all([
      writer.patch("one", { name: "first" }),
      writer.patch("two", { name: "second" }),
    ]);
    expect(JSON.parse(fs.readFileSync(settingsPath("one"), "utf8"))).toEqual({
      value: 1,
      name: "first",
    });
    expect(JSON.parse(fs.readFileSync(settingsPath("two"), "utf8"))).toEqual({
      value: 2,
      name: "second",
    });
    await writer.dispose();
  });

  it("surfaces persistence failures without replacing the last good file", async () => {
    const base = temporaryDirectory();
    const destination = path.join(base, "default", "settings.json");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, JSON.stringify({ value: "old" }));
    const failingFs = {
      ...fs.promises,
      rename: vi.fn(async () => {
        const error = new Error("disk failure");
        error.code = "EIO";
        throw error;
      }),
    };
    const writer = createSettingsWriter({
      resolvePath: () => destination,
      fsApi: failingFs,
    });
    writer.seed("default", { value: "old" });

    await expect(writer.patch("default", { value: "new" })).rejects.toThrow(
      "disk failure"
    );
    expect(JSON.parse(fs.readFileSync(destination, "utf8"))).toEqual({ value: "old" });
    expect(writer.snapshot()).toMatchObject({ dirtyProfiles: 1 });
    await writer.dispose({ flush: false });
  });

  it("flushes during dispose and rejects later mutations", async () => {
    const clock = createManualClock();
    const { writer, settingsPath } = writerFixture({ debounceMs: 10_000, clock });
    writer.seed("default", { value: 1 });
    await writer.patch("default", { value: 2 }, { debounce: true });
    await writer.dispose();

    expect(JSON.parse(fs.readFileSync(settingsPath("default"), "utf8"))).toEqual({ value: 2 });
    expect(writer.snapshot()).toMatchObject({ accepting: false, disposed: true, profiles: 0 });
    expect(() => writer.patch("default", { value: 3 })).toThrow(
      expect.objectContaining({ code: "SETTINGS_WRITER_DISPOSED" })
    );
  });

  it("loads an existing file when no in-memory seed was supplied", async () => {
    const { writer, settingsPath } = writerFixture();
    fs.mkdirSync(path.dirname(settingsPath("default")), { recursive: true });
    fs.writeFileSync(settingsPath("default"), JSON.stringify({ existing: true }));

    await writer.patch("default", { added: true });
    expect(await writer.getSnapshot("default")).toEqual({
      existing: true,
      added: true,
    });
    await writer.dispose();
  });

  it("preserves the empty default snapshot when the settings file is missing", async () => {
    const { writer } = writerFixture();

    await expect(writer.getSnapshot("missing")).resolves.toEqual({});
    await writer.dispose();
  });
});
