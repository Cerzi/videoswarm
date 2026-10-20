import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createCompanionService } = require("../companion-service");
const { createFakeCompanion, TARGET_DESCRIPTION } = require("./helpers/fakeCompanion.cjs");

const CLIP = "/library/run/clip-a.mp4";

describe("createCompanionService", () => {
  let fake;
  afterEach(async () => {
    await fake?.stop();
    fake = null;
  });

  async function connected(extra = {}) {
    fake = createFakeCompanion(extra);
    const url = await fake.start();
    let clock = 0;
    const service = createCompanionService({
      getConnection: () => ({ enabled: true, url }),
      now: () => clock,
    });
    return { service, url, advance: (ms) => (clock += ms) };
  }

  it("does nothing while switched off", async () => {
    const service = createCompanionService({
      getConnection: () => ({ enabled: false, url: "http://127.0.0.1:9" }),
    });
    await expect(service.lookup([CLIP])).rejects.toMatchObject({ code: "COMPANION_OFF" });
    await expect(service.describe()).rejects.toMatchObject({ code: "COMPANION_OFF" });
  });

  it("remembers the description for a minute and reads stages for its actions", async () => {
    const { service, advance } = await connected();
    await service.lookup([CLIP]);
    await service.lookup([CLIP]);
    const describes = () =>
      fake.state.requests.filter((request) => request.path === "/api/describe").length;
    expect(describes()).toBe(1);
    advance(61_000);
    const found = await service.lookup([CLIP]);
    expect(describes()).toBe(2);
    expect(Object.keys(found.get(CLIP).actions)).toEqual(["polish", "enlarge"]);
    await service.describe({ fresh: true });
    expect(describes()).toBe(3);
  });

  it("sends only actions the companion offers", async () => {
    const { service } = await connected();
    await expect(service.send({ action: "erase", paths: [CLIP] })).rejects.toMatchObject({
      code: "COMPANION_UNKNOWN_ACTION",
    });
    const outcome = await service.send({ action: "enlarge", paths: [CLIP], dryRun: true });
    expect(outcome.results.get(CLIP).result).toBe("sent");
    expect(fake.state.requests.at(-1).body).toMatchObject({ action: "enlarge", dry_run: true });
    // An action without Undo cannot be taken back.
    await expect(service.withdraw({ action: "enlarge", paths: [CLIP] })).rejects.toMatchObject({
      code: "COMPANION_NO_WITHDRAW",
    });
  });

  it("hands out target handles, never ids, and resolves them for sends and withdraws", async () => {
    const { service } = await connected({ description: TARGET_DESCRIPTION });
    fake.state.targets = [
      { id: "/projects/one", label: "One", detail: "", current: true },
      { id: "/projects/two", label: "Two", detail: "", current: false },
    ];
    const targets = await service.targets("add");
    expect(targets).toEqual([
      { handle: "t1", label: "One", detail: "", current: true },
      { handle: "t2", label: "Two", detail: "", current: false },
    ]);
    expect(JSON.stringify(targets)).not.toContain("/projects");
    // Asked afresh each time; the same id keeps its handle.
    expect((await service.targets("add"))[1].handle).toBe("t2");

    const sent = await service.send({ action: "add", paths: [CLIP], target: { handle: "t2" } });
    expect(fake.state.requests.at(-1).body.target).toBe("/projects/two");
    expect(sent.target).toEqual({ handle: "t2", label: "Two" });

    const made = await service.send({ action: "add", paths: [CLIP], target: { new: "Fresh" } });
    expect(made.target).toEqual({ handle: "t3", label: "Fresh" });

    const back = await service.withdraw({ action: "add", paths: [CLIP], target: { handle: "t2" } });
    expect(back.results.get(CLIP).result).toBe("withdrawn");

    await expect(
      service.send({ action: "add", paths: [CLIP], target: { handle: "t99" } })
    ).rejects.toMatchObject({ code: "COMPANION_TARGET_UNKNOWN" });
  });
});

describe("companion main-process integration", () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), "main.js"), "utf8");
  const section = (start, end) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return source.slice(from, to);
  };

  it("changes the connections only through their validated IPC", () => {
    const set = section('ipcMain.handle("companion:connections:set"', 'ipcMain.handle("companion:connection:test"');
    expect(set).toContain("validateCompanionConnections(");
    expect(set).toContain("saveSettingsPartial({ companionConnections: value }");
    const guard = section("function withoutComfyConnection", 'ipcMain.handle("save-settings"');
    expect(guard).toContain("companionConnections: _ignoredCompanions");
    expect(source).toContain("companionConnections: normalizeCompanionConnections(");
  });

  it("looks up by catalog row and authorizes every path it sends", () => {
    const lookup = section('ipcMain.handle("companion:lookup"', 'ipcMain.handle("companion:send"');
    expect(lookup).toContain("maxEntries: COMPANION_LIMITS.maxLookupPaths");
    expect(lookup).toContain("companionServiceFor(payload.companionId)");
    expect(lookup).not.toContain("payload.paths");
    const send = section('ipcMain.handle("companion:send"', "// ===== ComfyUI address IPC");
    expect(send).toContain("maxEntries: COMPANION_LIMITS.maxSendPaths");
    expect(send).toContain('await assertRendererPath(event, filePath, "file")');
    expect(send).not.toContain("payload.paths");
  });
});
