// src/hooks/actions/actions.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { actionRegistry, ActionIds } from "./actions";

const makeVideo = (p) => ({
  id: p,
  name: p.split("/").pop(),
  isElectronFile: true,
  fullPath: p,
});

describe("actionRegistry → MOVE_TO_TRASH (bulk)", () => {
  let electronAPI;
  let notify;
  let confirm;
  let releaseVideoHandlesForAsync;
  let onItemsRemoved;

  beforeEach(() => {
    notify = vi.fn();
    confirm = vi.fn(() => true);
    releaseVideoHandlesForAsync = vi.fn(async () => {});
    onItemsRemoved = vi.fn();

    electronAPI = {
      // default: everything moves; tests will override per-case
      bulkMoveToTrash: vi.fn(async (paths) => ({
        success: true,
        moved: [...paths],
        failed: [],
      })),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("moves all items in one bulk call; releases handles pre/post; prunes and notifies", async () => {
    const videos = [makeVideo("/x"), makeVideo("/y")];

    await actionRegistry[ActionIds.MOVE_TO_TRASH](videos, {
      electronAPI,
      notify,
      confirm,
      releaseVideoHandlesForAsync,
      onItemsRemoved,
    });

    // confirmation
    expect(confirm).toHaveBeenCalledTimes(1);

    // bulk called once with all paths
    expect(electronAPI.bulkMoveToTrash).toHaveBeenCalledTimes(1);
    expect(electronAPI.bulkMoveToTrash).toHaveBeenCalledWith(["/x", "/y"]);

    // handle releases: pre + post (with moved)
    expect(releaseVideoHandlesForAsync).toHaveBeenCalledTimes(2);
    expect(releaseVideoHandlesForAsync.mock.calls[0][0]).toEqual(["/x", "/y"]); // pre
    expect(new Set(releaseVideoHandlesForAsync.mock.calls[1][0])).toEqual(
      new Set(["/x", "/y"])
    ); // post

    // pruning includes moved paths
    expect(onItemsRemoved).toHaveBeenCalledTimes(1);
    const pruned = onItemsRemoved.mock.calls[0][0];
    expect(pruned instanceof Set).toBe(true);
    expect(pruned.has("/x")).toBe(true);
    expect(pruned.has("/y")).toBe(true);

    // some toast was shown (exact wording not enforced)
    expect(notify).toHaveBeenCalled();
  });

  it("retries transient failures and succeeds on retry; prunes moved; shows some toast", async () => {
    const videos = [makeVideo("/ok"), makeVideo("/locked")];

    // 1st call: '/locked' transient failure; 2nd (retry): moves '/locked'
    electronAPI.bulkMoveToTrash
      .mockResolvedValueOnce({
        success: true,
        moved: ["/ok"],
        failed: [{ path: "/locked", error: "EBUSY: in use" }],
      })
      .mockResolvedValueOnce({
        success: true,
        moved: ["/locked"],
        failed: [],
      });

    await actionRegistry[ActionIds.MOVE_TO_TRASH](videos, {
      electronAPI,
      notify,
      confirm,
      releaseVideoHandlesForAsync,
      onItemsRemoved,
    });

    // call shapes: initial with both, retry with just the failed
    const calls = electronAPI.bulkMoveToTrash.mock.calls.map((c) => c[0]);
    expect(
      calls.some(
        (a) => Array.isArray(a) && a.length === 2 && a.includes("/ok") && a.includes("/locked")
      )
    ).toBe(true);
    expect(calls.some((a) => Array.isArray(a) && a.length === 1 && a[0] === "/locked")).toBe(true);

    // pruning: union of all prune calls must include both moved items
    expect(onItemsRemoved).toHaveBeenCalled();
    const prunedUnion = new Set(onItemsRemoved.mock.calls.flatMap((c) => Array.from(c[0] || [])));
    expect(prunedUnion.has("/ok")).toBe(true);
    expect(prunedUnion.has("/locked")).toBe(true);

    // some toast shown
    expect(notify).toHaveBeenCalled();
  });

  it("retries transient failures and still fails one; prunes what moved; shows some toast", async () => {
    const videos = [makeVideo("/ok"), makeVideo("/locked")];

    // 1st: move '/ok', fail '/locked'; 2nd (retry): still fail '/locked'
    electronAPI.bulkMoveToTrash
      .mockResolvedValueOnce({
        success: true,
        moved: ["/ok"],
        failed: [{ path: "/locked", error: "EBUSY: in use" }],
      })
      .mockResolvedValueOnce({
        success: true,
        moved: [],
        failed: [{ path: "/locked", error: "EBUSY" }],
      });

    await actionRegistry[ActionIds.MOVE_TO_TRASH](videos, {
      electronAPI,
      notify,
      confirm,
      releaseVideoHandlesForAsync,
      onItemsRemoved,
    });

    // call shapes: initial all, retry subset
    const calls = electronAPI.bulkMoveToTrash.mock.calls.map((c) => c[0]);
    expect(
      calls.some(
        (a) => Array.isArray(a) && a.length === 2 && a.includes("/ok") && a.includes("/locked")
      )
    ).toBe(true);
    expect(calls.some((a) => Array.isArray(a) && a.length === 1 && a[0] === "/locked")).toBe(true);

    // pruning includes '/ok' at least
    expect(onItemsRemoved).toHaveBeenCalled();
    const prunedUnion = new Set(onItemsRemoved.mock.calls.flatMap((c) => Array.from(c[0] || [])));
    expect(prunedUnion.has("/ok")).toBe(true);

    // some toast shown (success or warning/error depending on implementation)
    expect(notify).toHaveBeenCalled();
  });

  it("aborts when user cancels confirmation", async () => {
    confirm.mockReturnValue(false);
    const videos = [makeVideo("/x")];

    await actionRegistry[ActionIds.MOVE_TO_TRASH](videos, {
      electronAPI,
      notify,
      confirm,
      releaseVideoHandlesForAsync,
      onItemsRemoved,
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(electronAPI.bulkMoveToTrash).not.toHaveBeenCalled();
    expect(onItemsRemoved).not.toHaveBeenCalled();
    expect(releaseVideoHandlesForAsync).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('handles "nothing to trash" and shows info toast', async () => {
    const videos = [
      { id: "a", name: "a", isElectronFile: false, fullPath: "" },
      { id: "b", name: "b" }, // no fullPath
    ];

    await actionRegistry[ActionIds.MOVE_TO_TRASH](videos, {
      electronAPI,
      notify,
      confirm,
      releaseVideoHandlesForAsync,
      onItemsRemoved,
    });

    expect(electronAPI.bulkMoveToTrash).not.toHaveBeenCalled();
    expect(releaseVideoHandlesForAsync).not.toHaveBeenCalled();
    expect(onItemsRemoved).not.toHaveBeenCalled();
    expect(
      notify.mock.calls.some((c) => typeof c?.[0] === "string" && /nothing to trash/i.test(c[0]))
    ).toBe(true);
  });
});
