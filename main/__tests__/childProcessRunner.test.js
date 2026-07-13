import { EventEmitter } from "events";
import { createRequire } from "module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createChildProcessRunner } = require("../child-process-runner");

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.kill = vi.fn(() => true);
  }

  close(code = 0, signal = null) {
    this.emit("close", code, signal);
  }
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("ChildProcessRunner", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("enforces concurrency and an explicit pending queue limit", async () => {
    const children = [];
    const spawn = vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    const runner = createChildProcessRunner({
      spawn,
      concurrency: 1,
      maxPending: 1,
    });

    const first = runner.run("tool", ["first"], { ownerId: "window-1" });
    const second = runner.run("tool", ["second"], { ownerId: "window-2" });
    const rejected = runner.run("tool", ["third"]);

    await expect(rejected).rejects.toMatchObject({ code: "QUEUE_FULL" });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(runner.getSnapshot()).toMatchObject({ active: 1, pending: 1 });

    children[0].stdout.emit("data", Buffer.from("one"));
    children[0].close(0);
    await expect(first).resolves.toMatchObject({ stdout: Buffer.from("one") });
    await flush();

    expect(spawn).toHaveBeenCalledTimes(2);
    children[1].close(0);
    await expect(second).resolves.toMatchObject({ code: 0 });
    expect(runner.getSnapshot()).toMatchObject({ active: 0, pending: 0 });
  });

  it("terminates output floods and settles an error/close race exactly once", async () => {
    const child = new FakeChild();
    const runner = createChildProcessRunner({
      spawn: () => child,
      maxStdoutBytes: 4,
      killGraceMs: 10,
    });

    const result = runner.run("noisy");
    child.stdout.emit("data", Buffer.from("12345"));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("error", new Error("late stream error"));
    child.close(1);

    await expect(result).rejects.toMatchObject({ code: "STDOUT_LIMIT" });
    expect(runner.getSnapshot().totals).toMatchObject({
      failed: 1,
      outputLimited: 1,
    });
  });

  it("uses SIGTERM then SIGKILL when a timed-out child does not close", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const runner = createChildProcessRunner({
      spawn: () => child,
      timeoutMs: 20,
      killGraceMs: 10,
    });

    const result = runner.run("hung");
    const rejected = expect(result).rejects.toMatchObject({
      code: "PROCESS_TIMEOUT",
      timeoutMs: 20,
    });

    await vi.advanceTimersByTimeAsync(20);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(runner.getSnapshot().active).toBe(1);

    await vi.advanceTimersByTimeAsync(10);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await rejected;
    expect(runner.getSnapshot()).toMatchObject({ active: 0, pending: 0 });
  });

  it("cancels active and pending work by owner without affecting other owners", async () => {
    const children = [];
    const runner = createChildProcessRunner({
      spawn: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      concurrency: 1,
      maxPending: 3,
      killGraceMs: 5,
    });

    const active = runner.run("tool", ["a"], { ownerId: "owner-a" });
    const queuedSameOwner = runner.run("tool", ["a2"], {
      ownerId: "owner-a",
    });
    const queuedOtherOwner = runner.run("tool", ["b"], {
      ownerId: "owner-b",
    });
    const activeRejected = expect(active).rejects.toMatchObject({
      code: "OWNER_CANCELLED",
    });
    const queuedRejected = expect(queuedSameOwner).rejects.toMatchObject({
      code: "OWNER_CANCELLED",
    });

    expect(runner.cancelOwner("owner-a")).toBe(2);
    children[0].close(null, "SIGTERM");
    await Promise.all([activeRejected, queuedRejected]);
    await flush();

    expect(children).toHaveLength(2);
    children[1].close(0);
    await expect(queuedOtherOwner).resolves.toMatchObject({ ownerId: "owner-b" });
    expect(runner.getSnapshot().totals.cancelled).toBe(2);
  });

  it("shutdown cancels owned work and rejects future submissions", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const runner = createChildProcessRunner({
      spawn: () => child,
      killGraceMs: 5,
    });
    const active = runner.run("tool", [], { ownerId: "owner" });
    const activeRejected = expect(active).rejects.toMatchObject({
      code: "RUNNER_CANCELLED",
    });

    const shutdown = runner.shutdown();
    await expect(runner.run("later")).rejects.toMatchObject({
      code: "RUNNER_SHUTDOWN",
    });
    await vi.advanceTimersByTimeAsync(5);
    await activeRejected;
    await expect(shutdown).resolves.toMatchObject({ closed: true, active: 0 });
  });
});
