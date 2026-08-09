import { describe, expect, it, vi } from "vitest";
import { createRequire } from "module";
import path from "path";

const require = createRequire(import.meta.url);
const {
  createTrashConfirmationStore,
  mapTrashWorkBounded,
  trashAuthorizedPaths,
} = require("../ipc-trash");

const testPath = (...segments) =>
  path.join(path.parse(process.cwd()).root, ...segments);

function createClock(initial = 1_000) {
  let current = initial;
  return {
    now: () => current,
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}

describe("authorized trash service", () => {
  it("runs bounded native work concurrently and preserves ordered partial results", async () => {
    const order = [];
    let active = 0;
    let peakActive = 0;
    const shell = {
      trashItem: vi.fn(async (filePath) => {
        order.push(`trash:${filePath}`);
        active += 1;
        peakActive = Math.max(peakActive, active);
        await Promise.resolve();
        active -= 1;
        if (filePath === "/library/b.mp4") throw new Error("busy");
      }),
    };
    const authorizePath = vi.fn(async (filePath) => {
      order.push(`authorize:${filePath}`);
      if (filePath === "/outside/c.mp4") throw new Error("not authorized");
      return { path: filePath };
    });

    const result = await trashAuthorizedPaths({
      paths: ["/library/a.mp4", "/library/b.mp4", "/outside/c.mp4"],
      shell,
      authorizePath,
      concurrency: 2,
      logger: { warn: vi.fn() },
    });

    expect(result).toEqual({
      success: false,
      moved: ["/library/a.mp4"],
      failed: [
        { path: "/library/b.mp4", error: "busy" },
        { path: "/outside/c.mp4", error: "not authorized" },
      ],
    });
    expect(peakActive).toBe(2);
    expect(order).toEqual(
      expect.arrayContaining([
        "authorize:/library/a.mp4",
        "trash:/library/a.mp4",
        "authorize:/library/b.mp4",
        "trash:/library/b.mp4",
        "authorize:/outside/c.mp4",
      ])
    );
    expect(order.indexOf("authorize:/library/a.mp4")).toBeLessThan(
      order.indexOf("trash:/library/a.mp4")
    );
    expect(order.indexOf("authorize:/library/b.mp4")).toBeLessThan(
      order.indexOf("trash:/library/b.mp4")
    );
  });

  it("drains active preflight work and stops admitting tasks after a failure", async () => {
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const visited = [];
    const operation = mapTrashWorkBounded(
      ["first", "fails", "must-not-start", "also-must-not-start"],
      async (value) => {
        visited.push(value);
        if (value === "first") await firstGate;
        if (value === "fails") throw new Error("preflight failed");
        return value;
      },
      2
    );
    const settlement = vi.fn();
    operation.then(settlement, settlement);

    await vi.waitFor(() => expect(visited).toHaveLength(2));
    await Promise.resolve();
    expect(settlement).not.toHaveBeenCalled();
    releaseFirst();

    await expect(operation).rejects.toThrow("preflight failed");
    expect(visited).toEqual(["first", "fails"]);
    expect(settlement).toHaveBeenCalledTimes(1);
  });

  it("moves one canonical file once when multiple requested paths are aliases", async () => {
    const shell = { trashItem: vi.fn(async () => {}) };
    const authorizePath = vi.fn(async () => ({
      path: "/library/canonical.mp4",
    }));

    const result = await trashAuthorizedPaths({
      paths: ["/library/canonical.mp4", "/library/alias.mp4"],
      shell,
      authorizePath,
      concurrency: 2,
    });

    expect(shell.trashItem).toHaveBeenCalledTimes(1);
    expect(shell.trashItem).toHaveBeenCalledWith("/library/canonical.mp4");
    expect(result).toEqual({
      success: true,
      moved: ["/library/canonical.mp4", "/library/alias.mp4"],
      failed: [],
    });
  });

  it("reports monotonic progress and a terminal event for every item", async () => {
    const shell = {
      trashItem: vi.fn(async (target) => {
        if (target.endsWith("second.mp4")) throw new Error("locked");
      }),
    };
    const events = [];

    const result = await trashAuthorizedPaths({
      paths: ["/library/first.mp4", "/library/second.mp4", "/library/third.mp4"],
      shell,
      authorizePath: async (filePath) => ({ path: filePath }),
      concurrency: 1,
      onProgress: (progress) => events.push({ ...progress }),
    });

    expect(result.moved).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    // One leading event, one per item, and one explicit terminal event.
    expect(events).toHaveLength(5);
    expect(events[0]).toMatchObject({ processed: 0, total: 3, finished: false });
    expect(events.map((event) => event.processed)).toEqual([0, 1, 2, 3, 3]);
    const terminal = events.at(-1);
    expect(terminal).toMatchObject({
      processed: 3,
      total: 3,
      moved: 2,
      failed: 1,
      finished: true,
    });
  });

  it("completes the trash operation even when progress reporting throws", async () => {
    const shell = { trashItem: vi.fn(async () => {}) };

    const result = await trashAuthorizedPaths({
      paths: ["/library/only.mp4"],
      shell,
      authorizePath: async (filePath) => ({ path: filePath }),
      onProgress: () => {
        throw new Error("renderer went away");
      },
    });

    expect(result).toEqual({
      success: true,
      moved: ["/library/only.mp4"],
      failed: [],
    });
    expect(shell.trashItem).toHaveBeenCalledTimes(1);
  });

  it("rejects empty, oversized, and unbounded calls before touching the shell", async () => {
    const shell = { trashItem: vi.fn() };
    const authorizePath = vi.fn();
    await expect(
      trashAuthorizedPaths({ paths: [], shell, authorizePath })
    ).rejects.toThrow(/1-2000/);
    await expect(
      trashAuthorizedPaths({
        paths: ["/a", "/b"],
        maxItems: 1,
        shell,
        authorizePath,
      })
    ).rejects.toThrow(/1-1/);
    await expect(
      trashAuthorizedPaths({
        paths: ["/a"],
        concurrency: 0,
        shell,
        authorizePath,
      })
    ).rejects.toThrow(/concurrency/i);
    expect(shell.trashItem).not.toHaveBeenCalled();
    expect(authorizePath).not.toHaveBeenCalled();
  });
});

describe("trash confirmation capability store", () => {
  it("issues cryptographically shaped tokens and validates confirmed subsets", () => {
    const store = createTrashConfirmationStore();
    const firstPath = testPath("library", "a.mp4");
    const secondPath = testPath("library", "b.mp4");
    const secondAlias = `${testPath("library", "sub")}${path.sep}..${path.sep}b.mp4`;
    const thirdPath = testPath("library", "c.mp4");
    const first = store.issue({
      ownerId: 17,
      scopeId: "profile-a",
      generation: 4,
      paths: [firstPath, secondAlias],
      bindings: {
        [firstPath]: "identity-a",
        [secondPath]: "identity-b",
      },
    });
    const second = store.issue({
      ownerId: 17,
      scopeId: "profile-a",
      generation: 4,
      paths: [thirdPath],
      bindings: { [thirdPath]: "identity-c" },
    });

    expect(first.token).toMatch(/^[a-f0-9]{64}$/);
    expect(second.token).not.toBe(first.token);
    expect(first.pathCount).toBe(2);
    expect(
      store.validate({
        token: first.token,
        ownerId: 17,
        scopeId: "profile-a",
        generation: 4,
        paths: [secondPath],
      })
    ).toMatchObject({
      paths: [secondPath],
      bindings: { [secondPath]: "identity-b" },
      expiresAt: first.expiresAt,
    });
  });

  it("consumes a grant so a confirmed path cannot be replayed", () => {
    const store = createTrashConfirmationStore();
    const confirmedPath = testPath("library", "a.mp4");
    const grant = store.issue({
      ownerId: 1,
      scopeId: "default",
      generation: 1,
      paths: [confirmedPath],
    });
    const request = {
      token: grant.token,
      ownerId: 1,
      scopeId: "default",
      generation: 1,
      paths: [confirmedPath],
    };

    expect(store.consume(request)).toMatchObject({
      paths: [confirmedPath],
    });
    expect(() => store.consume(request)).toThrow(
      expect.objectContaining({ code: "TRASH_CONFIRMATION_NOT_FOUND" })
    );
    expect(store.snapshot()).toMatchObject({ grants: 0 });
  });

  it("rejects ownership, profile generation, empty, and out-of-set requests", () => {
    const store = createTrashConfirmationStore();
    const firstPath = testPath("library", "a.mp4");
    const secondPath = testPath("library", "b.mp4");
    const { token } = store.issue({
      ownerId: 8,
      scopeId: "profile-a",
      generation: 2,
      paths: [firstPath, secondPath],
    });
    const request = {
      token,
      ownerId: 8,
      scopeId: "profile-a",
      generation: 2,
      paths: [firstPath],
    };

    expect(() => store.validate({ ...request, ownerId: 9 })).toThrow(
      expect.objectContaining({ code: "TRASH_CONFIRMATION_CONTEXT_MISMATCH" })
    );
    expect(() => store.validate({ ...request, scopeId: "profile-b" })).toThrow(
      expect.objectContaining({ code: "TRASH_CONFIRMATION_CONTEXT_MISMATCH" })
    );
    expect(() => store.validate({ ...request, generation: 3 })).toThrow(
      expect.objectContaining({ code: "TRASH_CONFIRMATION_CONTEXT_MISMATCH" })
    );
    expect(() => store.validate({ ...request, paths: [] })).toThrow(
      expect.objectContaining({ code: "INVALID_TRASH_CONFIRMATION_PATHS" })
    );
    expect(() =>
      store.validate({ ...request, paths: [testPath("library", "not-confirmed.mp4")] })
    ).toThrow(
      expect.objectContaining({ code: "TRASH_CONFIRMATION_PATH_MISMATCH" })
    );
  });

  it("expires grants after thirty seconds and rejects later reuse", () => {
    const clock = createClock();
    const store = createTrashConfirmationStore({ clock });
    const grant = store.issue({
      ownerId: 1,
      scopeId: "default",
      generation: 1,
      paths: [testPath("library", "a.mp4")],
    });
    const request = {
      token: grant.token,
      ownerId: 1,
      scopeId: "default",
      generation: 1,
      paths: [testPath("library", "a.mp4")],
    };

    clock.advance(29_999);
    expect(() => store.validate(request)).not.toThrow();
    clock.advance(1);
    expect(() => store.validate(request)).toThrow(
      expect.objectContaining({ code: "TRASH_CONFIRMATION_EXPIRED" })
    );
    expect(() => store.validate(request)).toThrow(
      expect.objectContaining({ code: "TRASH_CONFIRMATION_NOT_FOUND" })
    );
  });

  it("bounds paths and active grants while pruning expired capacity", () => {
    const clock = createClock();
    let tokenByte = 0;
    const store = createTrashConfirmationStore({
      clock,
      maxPaths: 2,
      maxGrants: 2,
      randomBytes: (length) => Buffer.alloc(length, ++tokenByte),
    });
    const issue = (pathName) =>
      store.issue({
        ownerId: 1,
        scopeId: "default",
        generation: 1,
        paths: [pathName],
      });

    issue(testPath("library", "a.mp4"));
    issue(testPath("library", "b.mp4"));
    expect(() => issue(testPath("library", "c.mp4"))).toThrow(
      expect.objectContaining({ code: "TRASH_CONFIRMATION_GRANT_LIMIT" })
    );
    expect(() =>
      store.issue({
        ownerId: 1,
        scopeId: "default",
        generation: 1,
        paths: [testPath("a"), testPath("b"), testPath("c")],
      })
    ).toThrow(expect.objectContaining({ code: "INVALID_TRASH_CONFIRMATION_PATHS" }));

    clock.advance(30_000);
    expect(() => issue(testPath("library", "c.mp4"))).not.toThrow();
    expect(store.snapshot()).toMatchObject({ grants: 1 });
  });

  it("revokes by owner, scope generation, all grants, and disposal", () => {
    let tokenByte = 0;
    const store = createTrashConfirmationStore({
      randomBytes: (length) => Buffer.alloc(length, ++tokenByte),
    });
    const issue = (ownerId, scopeId, generation, fileName) =>
      store.issue({
        ownerId,
        scopeId,
        generation,
        paths: [testPath("library", fileName)],
      });

    issue(1, "one", 1, "a.mp4");
    issue(1, "two", 1, "b.mp4");
    issue(2, "two", 1, "c.mp4");
    issue(2, "two", 2, "d.mp4");
    expect(store.revokeOwner(1)).toBe(2);
    expect(store.revokeScope("two", 1)).toBe(1);
    expect(store.snapshot()).toMatchObject({ grants: 1 });
    expect(store.revokeAll()).toBe(1);
    expect(store.snapshot()).toMatchObject({ grants: 0 });

    issue(3, "three", 1, "e.mp4");
    expect(store.dispose()).toBe(true);
    expect(store.dispose()).toBe(false);
    expect(store.snapshot()).toMatchObject({ disposed: true, grants: 0 });
    expect(() => issue(3, "three", 1, "f.mp4")).toThrow(
      expect.objectContaining({ code: "TRASH_CONFIRMATION_STORE_DISPOSED" })
    );
  });
});
