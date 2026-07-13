import { createRequire } from "module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  createDirectoryScanProgressReporter,
  createPeriodicEventLoopYielder,
} = require("../directory-scan-progress");

function createSender() {
  return {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  };
}

describe("directory scan progress reporter", () => {
  it("emits scan-owned snapshots and retains throttled counter updates", () => {
    let time = 1_000;
    const sender = createSender();
    const reporter = createDirectoryScanProgressReporter({
      scanId: "scan-1",
      sender,
      rootPath: "/library",
      recursive: true,
      throttleMs: 100,
      now: () => time,
    });

    reporter.setPhase("enumerating", { currentPath: "." });
    time += 20;
    expect(
      reporter.report({
        directoriesScanned: 1,
        entriesChecked: 8,
        videosFound: 3,
      })
    ).toBe(false);
    time += 80;
    expect(reporter.report({ entriesChecked: 12, videosFound: 5 })).toBe(true);

    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.send.mock.calls[1]).toEqual([
      "directory-scan-progress",
      expect.objectContaining({
        scanId: "scan-1",
        phase: "enumerating",
        rootPath: "/library",
        recursive: true,
        sequence: 2,
        directoriesScanned: 1,
        entriesChecked: 12,
        videosFound: 5,
        startedAt: 1_000,
        updatedAt: 1_100,
        elapsedMs: 100,
      }),
    ]);
  });

  it("force-sends phase transitions while keeping lifetime counters monotonic", () => {
    let time = 5_000;
    const sender = createSender();
    const reporter = createDirectoryScanProgressReporter({
      scanId: "scan-2",
      sender,
      throttleMs: 1_000,
      now: () => time,
    });

    reporter.setPhase("enumerating", {
      entriesChecked: 30,
      videosFound: 12,
      warnings: 1,
    });
    time += 1;
    reporter.setPhase("indexing", {
      phaseTotal: 12,
      entriesChecked: 1,
      videosFound: 2,
      warnings: 0,
    });
    time += 1;
    reporter.report(
      {
        phaseCurrent: 20,
        indexedFiles: 12,
        fingerprintsReused: 7,
      },
      { force: true }
    );

    expect(sender.send).toHaveBeenCalledTimes(3);
    expect(sender.send.mock.calls[1][1]).toMatchObject({
      phase: "indexing",
      phaseCurrent: 0,
      phaseTotal: 12,
      entriesChecked: 30,
      videosFound: 12,
      warnings: 1,
    });
    expect(sender.send.mock.calls[2][1]).toMatchObject({
      phaseCurrent: 12,
      indexedFiles: 12,
      fingerprintsReused: 7,
    });
  });

  it("does not throw or advance sequence after its sender is destroyed", () => {
    const sender = createSender();
    const reporter = createDirectoryScanProgressReporter({
      scanId: "scan-3",
      sender,
      now: () => 100,
    });

    reporter.setPhase("enumerating");
    sender.isDestroyed.mockReturnValue(true);

    expect(() =>
      reporter.report({ entriesChecked: 10 }, { force: true })
    ).not.toThrow();
    expect(reporter.getSnapshot()).toMatchObject({
      entriesChecked: 10,
      sequence: 1,
    });
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it("periodically yields without allocating a promise for every operation", async () => {
    const yieldFn = vi.fn(async () => {});
    const maybeYield = createPeriodicEventLoopYielder({ every: 3, yieldFn });

    expect(maybeYield()).toBeNull();
    expect(maybeYield()).toBeNull();
    await maybeYield();
    expect(yieldFn).toHaveBeenCalledTimes(1);
    expect(maybeYield()).toBeNull();
  });
});
