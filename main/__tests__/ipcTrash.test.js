import { describe, expect, it, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  createTrashConfirmationStore,
  trashAuthorizedPaths,
} = require("../ipc-trash");

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
  it("uses one sequential implementation and preserves partial results", async () => {
    const order = [];
    const shell = {
      trashItem: vi.fn(async (filePath) => {
        order.push(`trash:${filePath}`);
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
    expect(order).toEqual([
      "authorize:/library/a.mp4",
      "trash:/library/a.mp4",
      "authorize:/library/b.mp4",
      "trash:/library/b.mp4",
      "authorize:/outside/c.mp4",
    ]);
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
    expect(shell.trashItem).not.toHaveBeenCalled();
    expect(authorizePath).not.toHaveBeenCalled();
  });
});

describe("trash confirmation capability store", () => {
  it("issues cryptographically shaped tokens and validates confirmed subsets", () => {
    const store = createTrashConfirmationStore();
    const first = store.issue({
      ownerId: 17,
      scopeId: "profile-a",
      generation: 4,
      paths: ["/library/a.mp4", "/library/sub/../b.mp4"],
      bindings: {
        "/library/a.mp4": "identity-a",
        "/library/b.mp4": "identity-b",
      },
    });
    const second = store.issue({
      ownerId: 17,
      scopeId: "profile-a",
      generation: 4,
      paths: ["/library/c.mp4"],
      bindings: { "/library/c.mp4": "identity-c" },
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
        paths: ["/library/b.mp4"],
      })
    ).toMatchObject({
      paths: ["/library/b.mp4"],
      bindings: { "/library/b.mp4": "identity-b" },
      expiresAt: first.expiresAt,
    });
  });

  it("consumes a grant so a confirmed path cannot be replayed", () => {
    const store = createTrashConfirmationStore();
    const grant = store.issue({
      ownerId: 1,
      scopeId: "default",
      generation: 1,
      paths: ["/library/a.mp4"],
    });
    const request = {
      token: grant.token,
      ownerId: 1,
      scopeId: "default",
      generation: 1,
      paths: ["/library/a.mp4"],
    };

    expect(store.consume(request)).toMatchObject({ paths: ["/library/a.mp4"] });
    expect(() => store.consume(request)).toThrow(
      expect.objectContaining({ code: "TRASH_CONFIRMATION_NOT_FOUND" })
    );
    expect(store.snapshot()).toMatchObject({ grants: 0 });
  });

  it("rejects ownership, profile generation, empty, and out-of-set requests", () => {
    const store = createTrashConfirmationStore();
    const { token } = store.issue({
      ownerId: 8,
      scopeId: "profile-a",
      generation: 2,
      paths: ["/library/a.mp4", "/library/b.mp4"],
    });
    const request = {
      token,
      ownerId: 8,
      scopeId: "profile-a",
      generation: 2,
      paths: ["/library/a.mp4"],
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
      store.validate({ ...request, paths: ["/library/not-confirmed.mp4"] })
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
      paths: ["/library/a.mp4"],
    });
    const request = {
      token: grant.token,
      ownerId: 1,
      scopeId: "default",
      generation: 1,
      paths: ["/library/a.mp4"],
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

    issue("/library/a.mp4");
    issue("/library/b.mp4");
    expect(() => issue("/library/c.mp4")).toThrow(
      expect.objectContaining({ code: "TRASH_CONFIRMATION_GRANT_LIMIT" })
    );
    expect(() =>
      store.issue({
        ownerId: 1,
        scopeId: "default",
        generation: 1,
        paths: ["/a", "/b", "/c"],
      })
    ).toThrow(expect.objectContaining({ code: "INVALID_TRASH_CONFIRMATION_PATHS" }));

    clock.advance(30_000);
    expect(() => issue("/library/c.mp4")).not.toThrow();
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
        paths: [`/library/${fileName}`],
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
