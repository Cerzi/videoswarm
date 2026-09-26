import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  ACCEPTED_COPY_CODES,
  createReviewCopyAcceptedCoordinator,
} = require("../review-copy-accepted");

const fsp = fs.promises;
const temporaryDirectories = [];
const coordinators = [];

async function temporaryDirectory(label) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), `${label}-`));
  const canonicalDirectory = await fsp.realpath(directory);
  temporaryDirectories.push(canonicalDirectory);
  return canonicalDirectory;
}

async function writeFile(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content);
  return filePath;
}

async function recordFor(rootPath, relativePath) {
  const absolutePath = path.join(rootPath, ...relativePath.split("/"));
  const stats = await fsp.stat(absolutePath);
  return {
    instanceId: Math.floor(Math.random() * 1_000_000) + 1,
    absolutePath,
    relativePath,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    fingerprint: `fp:${relativePath}`,
  };
}

const completeRoot = (rootPath) => ({
  rootPath,
  recursive: true,
  refreshState: "idle",
  lastScanStartedAt: 100,
  lastScanCompletedAt: 101,
});

function harness({
  rootPath,
  destinationPath,
  records,
  fsPromises = fsp,
  assertActive = vi.fn(),
  showDirectoryPicker,
  listReusableDestinations,
  onDestinationPrepared,
  onSourcesRemoved,
  queryAcceptedInstances,
  maxPlans,
  now,
  planTtlMs,
  caseInsensitivePaths,
  platform,
} = {}) {
  const owner = { id: 42 };
  const root = completeRoot(rootPath);
  const progress = [];
  let planSequence = 0;
  const dependencies = {
    captureContext: vi.fn(() => ({
      profileId: "profile-a",
      generation: 7,
      token: "context-a",
    })),
    assertActive,
    authorizeRoot: vi.fn(async () => ({ path: rootPath })),
    getRoot: vi.fn(async () => root),
    showDirectoryPicker: showDirectoryPicker || vi.fn(async () => ({
      canceled: false,
      filePaths: [destinationPath],
    })),
    queryAcceptedInstances: queryAcceptedInstances || vi.fn(async () => ({
      root,
      records,
    })),
    emitProgress: vi.fn(({ payload }) => progress.push(payload)),
    ...(listReusableDestinations === undefined
      ? {}
      : { listReusableDestinations }),
    ...(onDestinationPrepared === undefined ? {} : { onDestinationPrepared }),
    ...(onSourcesRemoved === undefined ? {} : { onSourcesRemoved }),
    fsPromises,
    createPlanId: () => `copyplan${String(++planSequence).padStart(4, "0")}`,
    progressIntervalMs: 0,
    logger: { error: vi.fn(), warn: vi.fn() },
    ...(maxPlans === undefined ? {} : { maxPlans }),
    ...(now === undefined ? {} : { now }),
    ...(planTtlMs === undefined ? {} : { planTtlMs }),
    ...(caseInsensitivePaths === undefined ? {} : { caseInsensitivePaths }),
    ...(platform === undefined ? {} : { platform }),
  };
  const coordinator = createReviewCopyAcceptedCoordinator(dependencies);
  coordinators.push(coordinator);
  return { coordinator, dependencies, owner, progress, root };
}

const prepareRequest = (owner, rootPath, extra = {}) => ({
  owner,
  rootPath,
  directory: "",
  scope: "all-descendants",
  ...extra,
});

afterEach(async () => {
  while (coordinators.length) {
    await coordinators.pop().closeAndDrain();
  }
  while (temporaryDirectories.length) {
    await fsp.rm(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe("Copy Accepted native coordinator", () => {
  it("reuses a host-recorded destination without showing the picker", async () => {
    const rootPath = await temporaryDirectory("reuse-root");
    const destinationPath = await temporaryDirectory("reuse-destination");
    await writeFile(path.join(rootPath, "clip.mp4"), "reusable");
    const showDirectoryPicker = vi.fn(async () => ({ canceled: true }));
    const onDestinationPrepared = vi.fn();
    const { coordinator, owner } = harness({
      rootPath,
      destinationPath,
      records: [await recordFor(rootPath, "clip.mp4")],
      showDirectoryPicker,
      listReusableDestinations: vi.fn(async () => [destinationPath]),
      onDestinationPrepared,
    });

    const result = await coordinator.prepare(
      prepareRequest(owner, rootPath, { destinationPath })
    );

    expect(result.success).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(showDirectoryPicker).not.toHaveBeenCalled();
    expect(onDestinationPrepared).toHaveBeenCalledWith(
      expect.objectContaining({ destinationPath })
    );
  });

  it("falls back to the picker when the destination is not host-recorded", async () => {
    const rootPath = await temporaryDirectory("unknown-root");
    const destinationPath = await temporaryDirectory("unknown-destination");
    await writeFile(path.join(rootPath, "clip.mp4"), "unknown");
    const showDirectoryPicker = vi.fn(async () => ({
      canceled: false,
      filePaths: [destinationPath],
    }));
    const { coordinator, owner } = harness({
      rootPath,
      destinationPath,
      records: [await recordFor(rootPath, "clip.mp4")],
      showDirectoryPicker,
      // The renderer names somewhere the host has never recorded.
      listReusableDestinations: vi.fn(async () => []),
    });

    const result = await coordinator.prepare(
      prepareRequest(owner, rootPath, {
        destinationPath: path.join(destinationPath, "not-approved"),
      })
    );

    expect(result.success).toBe(true);
    expect(showDirectoryPicker).toHaveBeenCalledTimes(1);
    expect(result.destinationLabel).toBe(path.basename(destinationPath));
  });

  it("prepares from an explicit selection without a review scope", async () => {
    const rootPath = await temporaryDirectory("selection-root");
    const destinationPath = await temporaryDirectory("selection-destination");
    await writeFile(path.join(rootPath, "batch", "one.mp4"), "one");
    const queryAcceptedInstances = vi.fn(async () => ({
      root: completeRoot(rootPath),
      records: [await recordFor(rootPath, "batch/one.mp4")],
      requestedCount: 2,
      unavailableCount: 1,
    }));
    const { coordinator, owner } = harness({
      rootPath,
      destinationPath,
      queryAcceptedInstances,
    });

    const plan = await coordinator.prepare(
      prepareRequest(owner, rootPath, { instanceIds: [11, 12] })
    );

    expect(plan.success).toBe(true);
    expect(queryAcceptedInstances).toHaveBeenCalledWith(
      expect.objectContaining({ instanceIds: [11, 12] })
    );
    expect(plan.copyableCount).toBe(1);
    // The id that no longer resolves is reported the same way a source that
    // disappears during preflight would be.
    expect(plan.missingCount).toBe(1);
  });

  it("rejects a malformed or oversized selection before any native work", async () => {
    const rootPath = await temporaryDirectory("bad-selection-root");
    const destinationPath = await temporaryDirectory("bad-selection-destination");
    await writeFile(path.join(rootPath, "clip.mp4"), "clip");
    const showDirectoryPicker = vi.fn(async () => ({ canceled: true }));
    const { coordinator, owner } = harness({
      rootPath,
      destinationPath,
      records: [await recordFor(rootPath, "clip.mp4")],
      showDirectoryPicker,
    });

    for (const instanceIds of [[], [0], ["nope"], [1.5]]) {
      const result = await coordinator.prepare(
        prepareRequest(owner, rootPath, { instanceIds })
      );
      expect(result.success).toBe(false);
    }
    expect(showDirectoryPicker).not.toHaveBeenCalled();
  });


  it("transfers a selection spanning two roots and authorizes each", async () => {
    const alphaRoot = await temporaryDirectory("multi-alpha");
    const betaRoot = await temporaryDirectory("multi-beta");
    const destinationPath = await temporaryDirectory("multi-destination");
    await writeFile(path.join(alphaRoot, "batch", "one.mp4"), "alpha-one");
    await writeFile(path.join(betaRoot, "batch", "two.mp4"), "beta-two");
    const alphaRecord = {
      ...(await recordFor(alphaRoot, "batch/one.mp4")),
      rootPath: alphaRoot,
    };
    const betaRecord = {
      ...(await recordFor(betaRoot, "batch/two.mp4")),
      rootPath: betaRoot,
    };
    const authorizeRoot = vi.fn(async ({ rootPath }) => ({ path: rootPath }));
    const { owner, dependencies } = harness({
      rootPath: alphaRoot,
      destinationPath,
      queryAcceptedInstances: vi.fn(async () => ({
        records: [alphaRecord, betaRecord],
        rootPaths: [alphaRoot, betaRoot],
      })),
    });
    dependencies.authorizeRoot = authorizeRoot;
    const multiRootCoordinator = createReviewCopyAcceptedCoordinator({
      ...dependencies,
      authorizeRoot,
    });
    coordinators.push(multiRootCoordinator);

    // No rootPath at all: this is what a rootless tag view sends.
    const plan = await multiRootCoordinator.prepare({
      owner,
      directory: "",
      scope: "all-descendants",
      instanceIds: [alphaRecord.instanceId, betaRecord.instanceId],
      layout: "flat",
    });

    expect(plan.success).toBe(true);
    expect(plan.copyableCount).toBe(2);
    // Each contributing root is a separate grant, not implied by the first.
    const authorized = authorizeRoot.mock.calls.map((call) => call[0].rootPath);
    expect(authorized).toEqual(expect.arrayContaining([alphaRoot, betaRoot]));

    const result = await multiRootCoordinator.start({
      owner,
      planId: plan.planId,
      collisionPolicy: "skip",
      transferMode: "copy",
    });
    expect(result.success).toBe(true);
    expect(result.copiedCount).toBe(2);
    expect((await fsp.readdir(destinationPath)).sort()).toEqual([
      "one.mp4",
      "two.mp4",
    ]);
  });

  it("refuses a destination inside any contributing root", async () => {
    const alphaRoot = await temporaryDirectory("inside-alpha");
    const betaRoot = await temporaryDirectory("inside-beta");
    await writeFile(path.join(alphaRoot, "one.mp4"), "alpha-one");
    await writeFile(path.join(betaRoot, "two.mp4"), "beta-two");
    const alphaRecord = {
      ...(await recordFor(alphaRoot, "one.mp4")),
      rootPath: alphaRoot,
    };
    const betaRecord = {
      ...(await recordFor(betaRoot, "two.mp4")),
      rootPath: betaRoot,
    };
    // The destination sits inside the *second* root, which a single-root check
    // would have missed entirely.
    const destinationPath = path.join(betaRoot, "gathered");
    await fsp.mkdir(destinationPath, { recursive: true });
    const { owner, dependencies } = harness({
      rootPath: alphaRoot,
      destinationPath,
      queryAcceptedInstances: vi.fn(async () => ({
        records: [alphaRecord, betaRecord],
      })),
    });
    const multiRootCoordinator = createReviewCopyAcceptedCoordinator({
      ...dependencies,
      authorizeRoot: vi.fn(async ({ rootPath }) => ({ path: rootPath })),
    });
    coordinators.push(multiRootCoordinator);

    const plan = await multiRootCoordinator.prepare({
      owner,
      directory: "",
      scope: "all-descendants",
      instanceIds: [alphaRecord.instanceId, betaRecord.instanceId],
    });

    expect(plan.success).toBe(false);
    expect(plan.code).toBe(ACCEPTED_COPY_CODES.DESTINATION_INSIDE_ROOT);
  });

  it("rejects a source that is outside the root the catalog named", async () => {
    const alphaRoot = await temporaryDirectory("mismatch-alpha");
    const betaRoot = await temporaryDirectory("mismatch-beta");
    const destinationPath = await temporaryDirectory("mismatch-destination");
    await writeFile(path.join(alphaRoot, "one.mp4"), "alpha-one");
    const record = {
      ...(await recordFor(alphaRoot, "one.mp4")),
      // Claims to belong to beta while physically living under alpha.
      rootPath: betaRoot,
    };
    const { owner, dependencies } = harness({
      rootPath: alphaRoot,
      destinationPath,
      queryAcceptedInstances: vi.fn(async () => ({ records: [record] })),
    });
    const multiRootCoordinator = createReviewCopyAcceptedCoordinator({
      ...dependencies,
      authorizeRoot: vi.fn(async ({ rootPath }) => ({ path: rootPath })),
    });
    coordinators.push(multiRootCoordinator);

    const plan = await multiRootCoordinator.prepare({
      owner,
      directory: "",
      scope: "all-descendants",
      instanceIds: [record.instanceId],
    });

    expect(plan.success).toBe(false);
    expect(plan.code).toBe(ACCEPTED_COPY_CODES.SOURCE_INVALID);
  });

  it("writes flat layout basenames and reports same-name collisions", async () => {
    const rootPath = await temporaryDirectory("flat-root");
    const destinationPath = await temporaryDirectory("flat-destination");
    await writeFile(path.join(rootPath, "batch-a", "clip.mp4"), "first");
    await writeFile(path.join(rootPath, "batch-b", "clip.mp4"), "second");
    await writeFile(path.join(rootPath, "batch-b", "other.mp4"), "unique");
    const { coordinator, owner } = harness({
      rootPath,
      destinationPath,
      records: [
        await recordFor(rootPath, "batch-a/clip.mp4"),
        await recordFor(rootPath, "batch-b/clip.mp4"),
        await recordFor(rootPath, "batch-b/other.mp4"),
      ],
    });

    const plan = await coordinator.prepare(
      prepareRequest(owner, rootPath, { layout: "flat" })
    );
    expect(plan.success).toBe(true);
    expect(plan.layout).toBe("flat");
    // Two sources share a basename once the folder tree is dropped.
    expect(plan.collisionCount).toBe(1);
    expect(plan.copyableCount).toBe(2);

    const result = await coordinator.start({
      owner,
      planId: plan.planId,
      collisionPolicy: "skip",
      transferMode: "copy",
    });

    expect(result.success).toBe(true);
    expect(result.copiedCount).toBe(2);
    const written = (await fsp.readdir(destinationPath)).sort();
    expect(written).toEqual(["clip.mp4", "other.mp4"]);
  });

  it("keeps the root-relative tree under the structured default", async () => {
    const rootPath = await temporaryDirectory("structured-root");
    const destinationPath = await temporaryDirectory("structured-destination");
    await writeFile(path.join(rootPath, "batch-a", "deep", "clip.mp4"), "nested");
    const { coordinator, owner } = harness({
      rootPath,
      destinationPath,
      records: [await recordFor(rootPath, "batch-a/deep/clip.mp4")],
    });

    const plan = await coordinator.prepare(prepareRequest(owner, rootPath));
    expect(plan.layout).toBe("structured");
    const result = await coordinator.start({
      owner,
      planId: plan.planId,
      collisionPolicy: "skip",
      transferMode: "copy",
    });

    expect(result.success).toBe(true);
    await expect(
      fsp.stat(path.join(destinationPath, "batch-a", "deep", "clip.mp4"))
    ).resolves.toBeTruthy();
  });

  it("prepares and copies accepted media without adjacent metadata files", async () => {
    const rootPath = await temporaryDirectory("copy-accepted-root");
    const destinationPath = await temporaryDirectory("copy-accepted-output");
    const mediaPath = await writeFile(
      path.join(rootPath, "batch", "clip.mp4"),
      "video"
    );
    await writeFile(`${mediaPath}.json`, "video-json");
    await writeFile(path.join(rootPath, "batch", "clip.workflow.json"), "workflow");
    await writeFile(path.join(rootPath, "batch", "clip.json"), "stem-json");
    const records = [await recordFor(rootPath, "batch/clip.mp4")];
    let activeCopies = 0;
    let peakCopies = 0;
    const instrumentedFs = {
      ...fsp,
      copyFile: vi.fn(async (...args) => {
        activeCopies += 1;
        peakCopies = Math.max(peakCopies, activeCopies);
        try {
          await new Promise((resolve) => setImmediate(resolve));
          return await fsp.copyFile(...args);
        } finally {
          activeCopies -= 1;
        }
      }),
    };
    const test = harness({
      rootPath,
      destinationPath,
      records,
      fsPromises: instrumentedFs,
    });

    const prepared = await test.coordinator.prepare(
      prepareRequest(test.owner, rootPath)
    );

    expect(prepared).toMatchObject({
      success: true,
      cancelled: false,
      destinationLabel: path.basename(destinationPath),
      mediaCount: 1,
      copyableCount: 1,
      canStart: true,
      collisionCount: 0,
      missingCount: 0,
    });
    expect(prepared.planId).toMatch(/^copyplan/u);
    expect(JSON.stringify(prepared)).not.toContain(rootPath);
    expect(JSON.stringify(prepared)).not.toContain(destinationPath);
    expect(test.dependencies.queryAcceptedInstances).toHaveBeenCalledWith(
      expect.objectContaining({
        rootPath,
        directory: "",
        scope: "all-descendants",
        limit: 20_001,
        maxRecords: 20_000,
        maxPathBytes: 16 * 1024 * 1024,
        assertActive: expect.any(Function),
      })
    );

    const result = await test.coordinator.start({
      owner: test.owner,
      planId: prepared.planId,
      collisionPolicy: "skip",
    });

    expect(result).toMatchObject({
      success: true,
      cancelled: false,
      copiedCount: 1,
      skippedCount: 0,
      missingCount: 0,
      failedCount: 0,
    });
    expect(peakCopies).toBe(1);
    await expect(fsp.readFile(
      path.join(destinationPath, "batch", "clip.mp4"),
      "utf8"
    )).resolves.toBe("video");
    await expect(fsp.stat(
      path.join(destinationPath, "batch", "clip.mp4.json")
    )).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fsp.stat(
      path.join(destinationPath, "batch", "clip.workflow.json")
    )).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fsp.stat(
      path.join(destinationPath, "batch", "clip.json")
    )).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(result)).not.toContain(rootPath);
    expect(JSON.stringify(result)).not.toContain(destinationPath);
    expect(test.progress.at(-1)).toMatchObject({
      planId: prepared.planId,
      phase: "complete",
      copiedMedia: 1,
    });
    expect(JSON.stringify(test.progress)).not.toContain(rootPath);
    expect(JSON.stringify(test.progress)).not.toContain(destinationPath);
  });

  it("preflights existing targets and skips them without overwriting", async () => {
    const rootPath = await temporaryDirectory("copy-collision-root");
    const destinationPath = await temporaryDirectory("copy-collision-output");
    await writeFile(path.join(rootPath, "clip.mp4"), "new-content");
    await writeFile(path.join(destinationPath, "clip.mp4"), "keep-content");
    const records = [await recordFor(rootPath, "clip.mp4")];
    const test = harness({ rootPath, destinationPath, records });

    const prepared = await test.coordinator.prepare(
      prepareRequest(test.owner, rootPath)
    );
    expect(prepared).toMatchObject({
      success: true,
      mediaCount: 1,
      copyableCount: 0,
      canStart: false,
      collisionCount: 1,
      collisionSamples: [
        { relativePath: "clip.mp4", kind: "media", reason: "exists" },
      ],
    });

    const result = await test.coordinator.start({
      owner: test.owner,
      planId: prepared.planId,
      collisionPolicy: "skip",
    });
    expect(result).toMatchObject({
      success: true,
      copiedCount: 0,
      skippedCount: 1,
      failedCount: 0,
    });
    await expect(fsp.readFile(
      path.join(destinationPath, "clip.mp4"),
      "utf8"
    )).resolves.toBe("keep-content");
  });

  it("marks distinct in-plan target collisions", async () => {
    const rootPath = await temporaryDirectory("copy-plan-collision-root");
    const destinationPath = await temporaryDirectory("copy-plan-collision-output");
    await writeFile(path.join(rootPath, "Clip.mp4"), "upper");
    await writeFile(path.join(rootPath, "clip.mp4"), "lower");
    const records = [
      await recordFor(rootPath, "Clip.mp4"),
      await recordFor(rootPath, "clip.mp4"),
    ];
    const test = harness({
      rootPath,
      destinationPath,
      records,
      caseInsensitivePaths: true,
    });

    const prepared = await test.coordinator.prepare(
      prepareRequest(test.owner, rootPath)
    );
    expect(prepared).toMatchObject({
      success: true,
      mediaCount: 2,
      copyableCount: 1,
      collisionCount: 1,
      collisionSamples: [
        { relativePath: "clip.mp4", kind: "media", reason: "in-plan" },
      ],
    });
  });

  it("moves accepted clips only after an exclusive destination copy succeeds", async () => {
    const rootPath = await temporaryDirectory("move-accepted-root");
    const destinationPath = await temporaryDirectory("move-accepted-output");
    const sourcePath = await writeFile(
      path.join(rootPath, "batch", "move-me.mp4"),
      "move-video"
    );
    const test = harness({
      rootPath,
      destinationPath,
      records: [await recordFor(rootPath, "batch/move-me.mp4")],
    });
    const prepared = await test.coordinator.prepare(
      prepareRequest(test.owner, rootPath)
    );

    const result = await test.coordinator.start({
      owner: test.owner,
      planId: prepared.planId,
      collisionPolicy: "skip",
      transferMode: "move",
    });

    expect(result).toMatchObject({
      success: true,
      transferMode: "move",
      copiedCount: 1,
      movedCount: 1,
    });
    await expect(fsp.readFile(
      path.join(destinationPath, "batch", "move-me.mp4"),
      "utf8"
    )).resolves.toBe("move-video");
    await expect(fsp.stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  describe("link mode", () => {
    const start = (test, planId) =>
      test.coordinator.start({
        owner: test.owner,
        planId,
        collisionPolicy: "skip",
        transferMode: "link",
      });

    it.skipIf(process.platform === "win32")(
      "links clips to their originals without copying or touching sources",
      async () => {
        const rootPath = await temporaryDirectory("link-root");
        const destinationPath = await temporaryDirectory("link-output");
        const sourcePath = await writeFile(path.join(rootPath, "batch", "draft.mp4"), "draft");
        await writeFile(path.join(destinationPath, "batch", "taken.mp4"), "existing");
        await writeFile(path.join(rootPath, "batch", "taken.mp4"), "source");
        const test = harness({
          rootPath,
          destinationPath,
          records: [
            await recordFor(rootPath, "batch/draft.mp4"),
            await recordFor(rootPath, "batch/taken.mp4"),
          ],
        });
        const prepared = await test.coordinator.prepare(prepareRequest(test.owner, rootPath));
        const result = await start(test, prepared.planId);

        expect(result).toMatchObject({
          success: true,
          transferMode: "link",
          copiedCount: 1,
          linkedCount: 1,
          movedCount: 0,
          bytesCopied: 0,
          skippedCount: 1,
        });
        const linkPath = path.join(destinationPath, "batch", "draft.mp4");
        expect((await fsp.lstat(linkPath)).isSymbolicLink()).toBe(true);
        expect(await fsp.readlink(linkPath)).toBe(sourcePath);
        await expect(fsp.readFile(sourcePath, "utf8")).resolves.toBe("draft");
        await expect(
          fsp.readFile(path.join(destinationPath, "batch", "taken.mp4"), "utf8")
        ).resolves.toBe("existing");
        expect(test.progress.at(-1)).toMatchObject({ phase: "complete", bytesCopied: 0 });
      }
    );

    it.skipIf(process.platform === "win32")(
      "treats an entry appearing at the destination as a skipped collision",
      async () => {
        const rootPath = await temporaryDirectory("link-race-root");
        const destinationPath = await temporaryDirectory("link-race-output");
        await writeFile(path.join(rootPath, "clip.mp4"), "source");
        const test = harness({
          rootPath,
          destinationPath,
          records: [await recordFor(rootPath, "clip.mp4")],
        });
        const prepared = await test.coordinator.prepare(prepareRequest(test.owner, rootPath));
        await writeFile(path.join(destinationPath, "clip.mp4"), "raced");
        const result = await start(test, prepared.planId);
        expect(result).toMatchObject({ linkedCount: 0, skippedCount: 1 });
        await expect(fsp.readFile(path.join(destinationPath, "clip.mp4"), "utf8")).resolves.toBe("raced");
      }
    );

    it.skipIf(process.platform === "win32")(
      "removes only the link it made when the source changes during linking",
      async () => {
        const rootPath = await temporaryDirectory("link-change-root");
        const destinationPath = await temporaryDirectory("link-change-output");
        const sourcePath = await writeFile(path.join(rootPath, "clip.mp4"), "source");
        let changed = false;
        const fsPromises = {
          ...fsp,
          symlink: async (...args) => {
            await fsp.symlink(...args);
            await fsp.writeFile(sourcePath, "rewritten while linking");
            changed = true;
          },
        };
        const test = harness({
          rootPath,
          destinationPath,
          records: [await recordFor(rootPath, "clip.mp4")],
          fsPromises,
        });
        const prepared = await test.coordinator.prepare(prepareRequest(test.owner, rootPath));
        const result = await start(test, prepared.planId);
        expect(changed).toBe(true);
        expect(result).toMatchObject({ linkedCount: 0, missingCount: 1 });
        await expect(fsp.lstat(path.join(destinationPath, "clip.mp4"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(fsp.readFile(sourcePath, "utf8")).resolves.toBe("rewritten while linking");
      }
    );

    it("reports Windows symlink permission once, with its remedy, and stops trying", async () => {
      const rootPath = await temporaryDirectory("link-eperm-root");
      const destinationPath = await temporaryDirectory("link-eperm-output");
      const names = ["a.mp4", "b.mp4", "c.mp4", "d.mp4"];
      for (const name of names) await writeFile(path.join(rootPath, name), name);
      const symlink = vi.fn(async () => {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      });
      const test = harness({
        rootPath,
        destinationPath,
        records: await Promise.all(names.map((name) => recordFor(rootPath, name))),
        fsPromises: { ...fsp, symlink },
        platform: "win32",
      });
      const prepared = await test.coordinator.prepare(prepareRequest(test.owner, rootPath));
      const result = await start(test, prepared.planId);

      expect(result).toMatchObject({
        success: false,
        linkedCount: 0,
        failedCount: 4,
        symlinkUnsupported: true,
      });
      // Two workers may each have been mid-attempt when the first failed.
      expect(symlink.mock.calls.length).toBeLessThanOrEqual(2);
      expect(result.failureSamples).toHaveLength(1);
      expect(result.failureSamples[0]).toMatchObject({
        code: "ACCEPTED_COPY_SYMLINK_UNSUPPORTED",
        message: expect.stringMatching(/Developer Mode/),
      });
      for (const name of names) {
        await expect(fsp.readFile(path.join(rootPath, name), "utf8")).resolves.toBe(name);
      }
    });

    it("explains an unsupported destination on other platforms", async () => {
      const rootPath = await temporaryDirectory("link-enotsup-root");
      const destinationPath = await temporaryDirectory("link-enotsup-output");
      await writeFile(path.join(rootPath, "clip.mp4"), "source");
      const test = harness({
        rootPath,
        destinationPath,
        records: [await recordFor(rootPath, "clip.mp4")],
        fsPromises: {
          ...fsp,
          symlink: async () => {
            throw Object.assign(new Error("not permitted"), { code: "EPERM" });
          },
        },
        platform: "linux",
      });
      const prepared = await test.coordinator.prepare(prepareRequest(test.owner, rootPath));
      const result = await start(test, prepared.planId);
      expect(result.failureSamples[0].message).toBe("The destination does not support symbolic links.");
    });

    it("refuses link mode when the filesystem API cannot link", async () => {
      const rootPath = await temporaryDirectory("link-api-root");
      const destinationPath = await temporaryDirectory("link-api-output");
      await writeFile(path.join(rootPath, "clip.mp4"), "source");
      const { symlink: _symlink, ...withoutSymlink } = fsp;
      const test = harness({
        rootPath,
        destinationPath,
        records: [await recordFor(rootPath, "clip.mp4")],
        fsPromises: withoutSymlink,
      });
      const prepared = await test.coordinator.prepare(prepareRequest(test.owner, rootPath));
      const result = await start(test, prepared.planId);
      expect(result).toMatchObject({ success: false, code: "ACCEPTED_COPY_PLAN_INVALID" });
    });
  });

  it("uses exclusive creation when a collision appears after preflight", async () => {
    const rootPath = await temporaryDirectory("copy-race-root");
    const destinationPath = await temporaryDirectory("copy-race-output");
    await writeFile(path.join(rootPath, "clip.mp4"), "source");
    const records = [await recordFor(rootPath, "clip.mp4")];
    const test = harness({ rootPath, destinationPath, records });
    const prepared = await test.coordinator.prepare(
      prepareRequest(test.owner, rootPath)
    );
    await writeFile(path.join(destinationPath, "clip.mp4"), "racing-writer");

    const result = await test.coordinator.start({
      owner: test.owner,
      planId: prepared.planId,
      collisionPolicy: "skip",
    });
    expect(result).toMatchObject({
      success: true,
      copiedCount: 0,
      skippedCount: 1,
      failedCount: 0,
    });
    await expect(fsp.readFile(
      path.join(destinationPath, "clip.mp4"),
      "utf8"
    )).resolves.toBe("racing-writer");
  });

  it("revalidates the concrete destination parent immediately before copying", async () => {
    const rootPath = await temporaryDirectory("copy-parent-swap-root");
    const destinationPath = await temporaryDirectory("copy-parent-swap-output");
    const outsidePath = await temporaryDirectory("copy-parent-swap-outside");
    await writeFile(path.join(rootPath, "batch", "clip.mp4"), "source");
    const records = [await recordFor(rootPath, "batch/clip.mp4")];
    const expectedParent = path.join(destinationPath, "batch");
    let swapped = false;
    const swappingFs = {
      ...fsp,
      realpath: vi.fn(async (candidate) => {
        if (path.resolve(candidate) === expectedParent && !swapped) {
          swapped = true;
          await fsp.rename(expectedParent, `${expectedParent}-original`);
          await fsp.symlink(outsidePath, expectedParent, "dir");
        }
        return fsp.realpath(candidate);
      }),
    };
    const test = harness({
      rootPath,
      destinationPath,
      records,
      fsPromises: swappingFs,
    });
    const prepared = await test.coordinator.prepare(
      prepareRequest(test.owner, rootPath)
    );

    const result = await test.coordinator.start({
      owner: test.owner,
      planId: prepared.planId,
      collisionPolicy: "skip",
    });
    expect(swapped).toBe(true);
    expect(result).toMatchObject({
      success: false,
      copiedCount: 0,
      missingCount: 0,
      failedCount: 1,
      failureSamples: [
        expect.objectContaining({
          relativePath: "batch/clip.mp4",
          kind: "media",
        }),
      ],
    });
    await expect(fsp.stat(path.join(outsidePath, "clip.mp4"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes its exclusive destination when the source changes during copy", async () => {
    const rootPath = await temporaryDirectory("copy-midflight-source-root");
    const destinationPath = await temporaryDirectory("copy-midflight-output");
    const mediaPath = await writeFile(path.join(rootPath, "clip.mp4"), "before");
    const records = [await recordFor(rootPath, "clip.mp4")];
    const mutatingFs = {
      ...fsp,
      copyFile: vi.fn(async (...args) => {
        await fsp.copyFile(...args);
        await fsp.appendFile(mediaPath, "-changed-during-copy");
      }),
    };
    const test = harness({
      rootPath,
      destinationPath,
      records,
      fsPromises: mutatingFs,
    });
    const prepared = await test.coordinator.prepare(
      prepareRequest(test.owner, rootPath)
    );

    const result = await test.coordinator.start({
      owner: test.owner,
      planId: prepared.planId,
      collisionPolicy: "skip",
    });
    expect(result).toMatchObject({
      success: false,
      copiedCount: 0,
      missingCount: 1,
      failedCount: 0,
      failureSamples: [
        expect.objectContaining({
          relativePath: "clip.mp4",
          code: ACCEPTED_COPY_CODES.SOURCE_CHANGED,
        }),
      ],
    });
    await expect(fsp.stat(path.join(destinationPath, "clip.mp4"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rechecks source identity immediately before copying", async () => {
    const rootPath = await temporaryDirectory("copy-identity-root");
    const destinationPath = await temporaryDirectory("copy-identity-output");
    const mediaPath = await writeFile(path.join(rootPath, "clip.mp4"), "before");
    const records = [await recordFor(rootPath, "clip.mp4")];
    const test = harness({ rootPath, destinationPath, records });
    const prepared = await test.coordinator.prepare(
      prepareRequest(test.owner, rootPath)
    );
    await fsp.appendFile(mediaPath, "-changed");

    const result = await test.coordinator.start({
      owner: test.owner,
      planId: prepared.planId,
      collisionPolicy: "skip",
    });
    expect(result).toMatchObject({
      success: false,
      copiedCount: 0,
      missingCount: 1,
      failedCount: 0,
      failureSamples: [
        expect.objectContaining({
          relativePath: "clip.mp4",
          code: ACCEPTED_COPY_CODES.SOURCE_CHANGED,
        }),
      ],
    });
    await expect(fsp.stat(path.join(destinationPath, "clip.mp4"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a catalog record whose absolute and relative identities disagree", async () => {
    const rootPath = await temporaryDirectory("copy-record-mismatch-root");
    const destinationPath = await temporaryDirectory("copy-record-mismatch-output");
    await writeFile(path.join(rootPath, "actual.mp4"), "source");
    const record = await recordFor(rootPath, "actual.mp4");
    const test = harness({
      rootPath,
      destinationPath,
      records: [{ ...record, relativePath: "different.mp4" }],
    });

    const prepared = await test.coordinator.prepare(
      prepareRequest(test.owner, rootPath)
    );
    expect(prepared).toMatchObject({
      success: false,
      code: ACCEPTED_COPY_CODES.SOURCE_INVALID,
    });
    expect(JSON.stringify(prepared)).not.toContain(rootPath);
  });

  it("rejects a destination inside the source root before querying records", async () => {
    const rootPath = await temporaryDirectory("copy-inside-root");
    const destinationPath = path.join(rootPath, "export");
    await fsp.mkdir(destinationPath);
    const queryAcceptedInstances = vi.fn();
    const test = harness({
      rootPath,
      destinationPath,
      records: [],
      queryAcceptedInstances,
    });

    await expect(test.coordinator.prepare(
      prepareRequest(test.owner, rootPath)
    )).resolves.toMatchObject({
      success: false,
      code: ACCEPTED_COPY_CODES.DESTINATION_INSIDE_ROOT,
    });
    expect(queryAcceptedInstances).not.toHaveBeenCalled();
  });

  it("binds plans to their owner and accepts only the no-overwrite policy", async () => {
    const rootPath = await temporaryDirectory("copy-owner-root");
    const destinationPath = await temporaryDirectory("copy-owner-output");
    await writeFile(path.join(rootPath, "clip.mp4"), "source");
    const records = [await recordFor(rootPath, "clip.mp4")];
    const test = harness({ rootPath, destinationPath, records });
    const prepared = await test.coordinator.prepare(
      prepareRequest(test.owner, rootPath)
    );

    await expect(test.coordinator.start({
      owner: { id: test.owner.id },
      planId: prepared.planId,
      collisionPolicy: "skip",
    })).resolves.toMatchObject({ code: ACCEPTED_COPY_CODES.PLAN_NOT_FOUND });
    await expect(test.coordinator.start({
      owner: test.owner,
      planId: prepared.planId,
      collisionPolicy: "overwrite",
    })).resolves.toMatchObject({ code: ACCEPTED_COPY_CODES.COLLISION_POLICY });
    expect(test.coordinator.cancel({
      owner: test.owner,
      planId: prepared.planId,
    })).toMatchObject({ success: true, cancelled: true });
  });

  it("cancels and drains the two-worker pool without starting queued files", async () => {
    const rootPath = await temporaryDirectory("copy-cancel-root");
    const destinationPath = await temporaryDirectory("copy-cancel-output");
    const records = [];
    for (const name of ["a.mp4", "b.mp4", "c.mp4", "d.mp4"]) {
      await writeFile(path.join(rootPath, name), name);
      records.push(await recordFor(rootPath, name));
    }
    let releaseCopies;
    const gate = new Promise((resolve) => {
      releaseCopies = resolve;
    });
    let startedCopies = 0;
    const blockedFs = {
      ...fsp,
      copyFile: vi.fn(async (...args) => {
        startedCopies += 1;
        await gate;
        return fsp.copyFile(...args);
      }),
    };
    const test = harness({
      rootPath,
      destinationPath,
      records,
      fsPromises: blockedFs,
    });
    const prepared = await test.coordinator.prepare(
      prepareRequest(test.owner, rootPath)
    );
    const copying = test.coordinator.start({
      owner: test.owner,
      planId: prepared.planId,
      collisionPolicy: "skip",
    });
    await vi.waitFor(() => expect(startedCopies).toBe(2));

    let drained = false;
    const draining = test.coordinator.pauseAndDrain().then((value) => {
      drained = true;
      return value;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    releaseCopies();

    await expect(copying).resolves.toMatchObject({
      success: false,
      cancelled: true,
      copiedCount: 2,
    });
    await expect(draining).resolves.toMatchObject({
      drained: true,
      active: false,
      plans: 0,
    });
    expect(startedCopies).toBe(2);
    expect(test.coordinator.state()).toMatchObject({
      admissionOpen: false,
      active: false,
      plans: 0,
      concurrency: 2,
    });
    expect(test.coordinator.resume()).toBe(true);
  });

  it("bounds pending plans and expires unused native state", async () => {
    const rootPath = await temporaryDirectory("copy-plan-root");
    const destinationPath = await temporaryDirectory("copy-plan-output");
    let currentTime = 1_000;
    const test = harness({
      rootPath,
      destinationPath,
      records: [],
      maxPlans: 2,
      planTtlMs: 100,
      now: () => currentTime,
    });
    const first = await test.coordinator.prepare(
      prepareRequest(test.owner, rootPath)
    );
    const second = await test.coordinator.prepare(
      prepareRequest(test.owner, rootPath)
    );
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    await expect(test.coordinator.prepare(
      prepareRequest(test.owner, rootPath)
    )).resolves.toMatchObject({ code: ACCEPTED_COPY_CODES.NO_PLAN_SLOTS });

    currentTime = 1_101;
    expect(test.coordinator.state()).toMatchObject({ plans: 0, prepared: 0 });
    await expect(test.coordinator.start({
      owner: test.owner,
      planId: first.planId,
      collisionPolicy: "skip",
    })).resolves.toMatchObject({ code: ACCEPTED_COPY_CODES.PLAN_NOT_FOUND });
  });
});
