import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  ACCEPTED_COPY_CODES,
  buildSequenceConcatList,
  createReviewCopyAcceptedCoordinator,
} = require("../review-copy-accepted");
const { buildSequenceCopyRecords } = require("../sequence-export");

const fsp = fs.promises;
const temporaryDirectories = [];
const coordinators = [];

async function temporaryDirectory(label) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), `${label}-`));
  const canonical = await fsp.realpath(directory);
  temporaryDirectories.push(canonical);
  return canonical;
}

async function instanceFor(rootPath, relativePath, content) {
  const absolutePath = path.join(rootPath, ...relativePath.split("/"));
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
  await fsp.writeFile(absolutePath, content);
  const stats = await fsp.stat(absolutePath);
  return {
    instanceId: Math.floor(Math.random() * 1_000_000) + 1,
    rootPath,
    relativePath,
    absolutePath,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    fingerprint: `fp:${relativePath}`,
  };
}

const snapshotOf = (instances) => ({
  id: 5,
  name: "Act one",
  entries: instances.map((instance, index) => ({
    id: index + 1,
    position: index,
    fingerprint: instance?.fingerprint || `fp:missing-${index}`,
    instance,
  })),
});

function sequenceHarness({ destinationPath, snapshot }) {
  const owner = { id: 7 };
  const queryAcceptedInstances = vi.fn(async ({ sequenceId }) => {
    expect(sequenceId).toBe(5);
    return { records: buildSequenceCopyRecords(snapshot()) };
  });
  const coordinator = createReviewCopyAcceptedCoordinator({
    captureContext: () => ({ profileId: "p", generation: 1 }),
    assertActive: vi.fn(),
    authorizeRoot: vi.fn(async ({ rootPath }) => ({ path: rootPath })),
    getRoot: vi.fn(async () => null),
    showDirectoryPicker: vi.fn(async () => ({
      canceled: false,
      filePaths: [destinationPath],
    })),
    queryAcceptedInstances,
    fsPromises: fsp,
    progressIntervalMs: 0,
    logger: { error: vi.fn(), warn: vi.fn() },
  });
  coordinators.push(coordinator);
  const prepare = () =>
    coordinator.prepare({
      owner,
      directory: "",
      scope: "all-descendants",
      sequenceId: 5,
      // A sequence ignores any layout it is sent.
      layout: "structured",
    });
  const start = (planId, transferMode = "copy") =>
    coordinator.start({ owner, planId, collisionPolicy: "skip", transferMode });
  return { coordinator, owner, prepare, start, queryAcceptedInstances };
}

afterEach(async () => {
  while (coordinators.length) await coordinators.pop().closeAndDrain();
  while (temporaryDirectories.length) {
    await fsp.rm(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe("buildSequenceCopyRecords", () => {
  it("numbers every position, a recurring clip once per position", () => {
    const a = {
      instanceId: 1,
      rootPath: "/lib",
      relativePath: "a.mp4",
      absolutePath: "/lib/a.mp4",
      size: 1,
      mtimeMs: 1,
    };
    const b = { ...a, instanceId: 2, relativePath: "x/030_b.mp4", absolutePath: "/lib/x/030_b.mp4" };
    const records = buildSequenceCopyRecords(snapshotOf([a, b, a]), {
      pathImpl: path.posix,
    });
    expect(records.map((record) => record.targetName)).toEqual([
      "010_a.mp4",
      "020_b.mp4",
      "030_a.mp4",
    ]);
    expect(records[2].instanceId).toBe(1);
  });

  it("refuses to export while entries are missing, naming their positions", () => {
    const a = {
      instanceId: 1,
      rootPath: "/lib",
      relativePath: "a.mp4",
      absolutePath: "/lib/a.mp4",
      size: 1,
      mtimeMs: 1,
    };
    expect(() => buildSequenceCopyRecords(snapshotOf([a, null, a, null]))).toThrow(
      expect.objectContaining({
        code: "SEQUENCE_ENTRIES_MISSING",
        expose: true,
        message: expect.stringMatching(/Cannot export while clips are missing: positions 2, 4/),
      })
    );
  });

  it("writes an ffmpeg concat list with ffmpeg's quoting", () => {
    expect(buildSequenceConcatList(["010_a.mp4", "020_it's.mp4"])).toContain(
      "file '010_a.mp4'\nfile '020_it'\\''s.mp4'\n"
    );
  });
});

describe("numbered sequence copy through the transfer coordinator", () => {
  it("copies each position under its number and writes concat.txt in order", async () => {
    const rootPath = await temporaryDirectory("seq-root");
    const destinationPath = await temporaryDirectory("seq-destination");
    const a = await instanceFor(rootPath, "shots/a.mp4", "A");
    const b = await instanceFor(rootPath, "b.mp4", "B");
    const { prepare, start } = sequenceHarness({
      destinationPath,
      snapshot: () => snapshotOf([b, a, b]),
    });

    const plan = await prepare();
    expect(plan).toMatchObject({
      success: true,
      layout: "sequence",
      canStart: true,
      copyableCount: 3,
      collisionCount: 0,
      sequence: {
        id: 5,
        concatFileName: "concat.txt",
        blockedReason: null,
        targetNames: ["010_b.mp4", "020_a.mp4", "030_b.mp4"],
      },
    });

    const result = await start(plan.planId);
    expect(result).toMatchObject({ success: true, copiedCount: 3, concatWritten: true });
    expect((await fsp.readdir(destinationPath)).sort()).toEqual([
      "010_b.mp4",
      "020_a.mp4",
      "030_b.mp4",
      "concat.txt",
    ]);
    expect(await fsp.readFile(path.join(destinationPath, "020_a.mp4"), "utf8")).toBe("A");
    const concat = await fsp.readFile(path.join(destinationPath, "concat.txt"), "utf8");
    expect(concat.split("\n").filter((line) => line.startsWith("file "))).toEqual([
      "file '010_b.mp4'",
      "file '020_a.mp4'",
      "file '030_b.mp4'",
    ]);
    // Originals are untouched.
    expect(await fsp.readFile(a.absolutePath, "utf8")).toBe("A");
  });

  it("will not start when any name is taken, and overwrites nothing", async () => {
    const rootPath = await temporaryDirectory("seq-collide-root");
    const destinationPath = await temporaryDirectory("seq-collide-destination");
    const a = await instanceFor(rootPath, "a.mp4", "A");
    const b = await instanceFor(rootPath, "b.mp4", "B");
    await fsp.writeFile(path.join(destinationPath, "020_b.mp4"), "someone else's");
    const { prepare, start } = sequenceHarness({
      destinationPath,
      snapshot: () => snapshotOf([a, b]),
    });

    const plan = await prepare();
    expect(plan.success).toBe(true);
    expect(plan.canStart).toBe(false);
    expect(plan.collisionSamples).toEqual([
      expect.objectContaining({ relativePath: "020_b.mp4", reason: "exists" }),
    ]);
    expect(plan.sequence.blockedReason).toMatch(/1 of these names already exists/);

    const refused = await start(plan.planId);
    expect(refused).toMatchObject({
      success: false,
      code: ACCEPTED_COPY_CODES.SEQUENCE_BLOCKED,
    });
    expect((await fsp.readdir(destinationPath)).sort()).toEqual(["020_b.mp4"]);
    expect(await fsp.readFile(path.join(destinationPath, "020_b.mp4"), "utf8")).toBe(
      "someone else's"
    );
  });

  it("treats an existing concat.txt as a collision", async () => {
    const rootPath = await temporaryDirectory("seq-concat-root");
    const destinationPath = await temporaryDirectory("seq-concat-destination");
    const a = await instanceFor(rootPath, "a.mp4", "A");
    await fsp.writeFile(path.join(destinationPath, "concat.txt"), "mine");
    const { prepare } = sequenceHarness({
      destinationPath,
      snapshot: () => snapshotOf([a]),
    });

    const plan = await prepare();
    expect(plan.canStart).toBe(false);
    expect(plan.collisionSamples.map((sample) => sample.relativePath)).toEqual([
      "concat.txt",
    ]);
  });

  it("copies, never moves or links, a sequence", async () => {
    const rootPath = await temporaryDirectory("seq-mode-root");
    const destinationPath = await temporaryDirectory("seq-mode-destination");
    const a = await instanceFor(rootPath, "a.mp4", "A");
    const { prepare, start } = sequenceHarness({
      destinationPath,
      snapshot: () => snapshotOf([a]),
    });

    const plan = await prepare();
    const refused = await start(plan.planId, "move");
    expect(refused).toMatchObject({
      success: false,
      code: ACCEPTED_COPY_CODES.SEQUENCE_MODE,
    });
    expect(await fsp.readFile(a.absolutePath, "utf8")).toBe("A");
    expect(await fsp.readdir(destinationPath)).toEqual([]);
  });

  it("reports the missing positions from the query instead of a generic failure", async () => {
    const rootPath = await temporaryDirectory("seq-missing-root");
    const destinationPath = await temporaryDirectory("seq-missing-destination");
    const a = await instanceFor(rootPath, "a.mp4", "A");
    const { prepare } = sequenceHarness({
      destinationPath,
      snapshot: () => snapshotOf([a, null, a]),
    });

    const plan = await prepare();
    expect(plan).toMatchObject({
      success: false,
      code: "SEQUENCE_ENTRIES_MISSING",
      error: expect.stringMatching(/position 2\b/),
    });
    expect(await fsp.readdir(destinationPath)).toEqual([]);
  });
});
