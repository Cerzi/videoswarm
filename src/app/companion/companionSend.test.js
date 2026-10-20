import { act, renderHook } from "@testing-library/react";
import {
  COMPANION_SEND_CHUNK,
  checkTargetSend,
  sendToTarget,
  sendWithoutReview,
  withdrawRows,
  companionRowsOf,
  formatEstimate,
  rowsToSend,
  summarizeSendResults,
} from "./companionSend";
import { useCompanionSend } from "./useCompanionSend";

describe("companion send helpers", () => {
  it("keeps catalogued rows and counts the rest", () => {
    expect(
      companionRowsOf([{ instanceId: 3 }, { instanceId: 3 }, { name: "web.mp4" }, { instanceId: "x" }])
    ).toEqual({ instanceIds: [3], excludedCount: 2 });
  });

  it("counts outcomes, totals estimates and groups reasons", () => {
    const summary = summarizeSendResults(
      new Map([
        [1, { result: "sent", why: "", estimate: 600 }],
        [2, { result: "sent", why: "" }],
        [3, { result: "skipped", why: "Already sent" }],
        [4, { result: "skipped", why: "Already sent" }],
        [5, { result: "refused", why: "No prompt" }],
        [6, { result: "odd" }],
      ])
    );
    expect(summary).toMatchObject({ sent: 2, skipped: 2, refused: 1, unknown: 1, estimate: 600 });
    expect(summary.skippedReasons).toEqual([{ why: "Already sent", count: 2 }]);
    expect(summary.refusedReasons).toEqual([{ why: "No prompt", count: 1 }]);
    expect(summarizeSendResults(null).estimate).toBeNull();
  });

  it("formats estimates and picks the rows to send", () => {
    expect(formatEstimate(20)).toBe("≈ 20 s");
    expect(formatEstimate(720)).toBe("≈ 12 min");
    expect(formatEstimate(22_800)).toBe("≈ 6 h 20 min");
    expect(formatEstimate(7200)).toBe("≈ 2 h");
    expect(formatEstimate(null)).toBe("");
    expect(
      rowsToSend(new Map([[1, { result: "sent" }], [2, { result: "skipped" }]]))
    ).toEqual([1]);
  });
});

describe("useCompanionSend", () => {
  afterEach(() => {
    delete window.electronAPI;
  });

  function installSend(plan = (id) => ({ result: id % 2 ? "sent" : "skipped", why: "", estimate: 60 })) {
    const send = vi.fn(async ({ instanceIds }) => ({
      success: true,
      results: Object.fromEntries(instanceIds.map((id) => [id, plan(id)])),
    }));
    window.electronAPI = { companion: { send } };
    return send;
  }

  it("dry-runs in chunks, then sends only what the dry run would send", async () => {
    const send = installSend();
    const onSent = vi.fn();
    const ids = Array.from({ length: 150 }, (_, index) => index + 1);
    const { result } = renderHook(() =>
      useCompanionSend({ companionId: "c3", action: "polish", instanceIds: ids, onSent })
    );
    await act(async () => result.current.check(false));
    expect(send.mock.calls.map(([request]) => [request.instanceIds.length, request.dryRun])).toEqual([
      [100, true],
      [50, true],
    ]);
    expect(result.current.phase).toBe("ready");
    expect(result.current.dry.size).toBe(150);

    await act(async () => result.current.send());
    const real = send.mock.calls.slice(2).map(([request]) => request);
    expect(
      real.every(
        (request) =>
          request.dryRun === false && request.action === "polish" && request.companionId === "c3"
      )
    ).toBe(true);
    expect(real.flatMap((request) => request.instanceIds)).toEqual(ids.filter((id) => id % 2));
    expect(result.current.phase).toBe("done");
    expect(onSent).toHaveBeenCalledWith(ids.filter((id) => id % 2));
  });

  it("asks again with `again` and reports a failed answer", async () => {
    const send = installSend();
    const { result } = renderHook(() => useCompanionSend({ action: "polish", instanceIds: [1] }));
    await act(async () => result.current.check(true));
    expect(send.mock.calls[0][0]).toMatchObject({ again: true, dryRun: true });
    expect(result.current.again).toBe(true);

    send.mockResolvedValueOnce({ success: false, error: "Not answering" });
    await act(async () => result.current.check(false));
    expect(result.current).toMatchObject({ phase: "error", error: "Not answering" });
  });
});

describe("sending in one click", () => {
  const answering = (plan) =>
    vi.fn(async ({ instanceIds, dryRun }) => ({
      success: true,
      dryRun,
      results: Object.fromEntries(instanceIds.map((id) => [id, plan(id, dryRun)])),
    }));

  it("sends at once when the dry run says every clip would be sent, in chunks", async () => {
    const send = answering(() => ({ result: "sent", why: "", estimate: 30 }));
    const instanceIds = Array.from({ length: COMPANION_SEND_CHUNK + 5 }, (_, index) => index + 1);
    const outcome = await sendWithoutReview({ companionId: "c1", actionId: "polish", instanceIds, send });
    expect(outcome.status).toBe("sent");
    expect(outcome.rows).toEqual(instanceIds);
    expect(send.mock.calls.map(([call]) => [call.dryRun, call.instanceIds.length])).toEqual([
      [true, COMPANION_SEND_CHUNK],
      [true, 5],
      [false, COMPANION_SEND_CHUNK],
      [false, 5],
    ]);
  });

  it("sends nothing when some clip would be skipped or refused, and says why", async () => {
    const send = answering((id) => (id === 2 ? { result: "refused", why: "No workflow" } : { result: "sent" }));
    const outcome = await sendWithoutReview({ companionId: "c1", actionId: "polish", instanceIds: [1, 2], send });
    expect(outcome.status).toBe("review");
    expect(outcome.dry.get(2)).toMatchObject({ result: "refused", why: "No workflow" });
    expect(send.mock.calls.every(([call]) => call.dryRun)).toBe(true);
  });

  it("reports an app that does not answer", async () => {
    const send = vi.fn(async () => ({ success: false, error: "Not answering" }));
    await expect(
      sendWithoutReview({ companionId: "c1", actionId: "polish", instanceIds: [1], send })
    ).resolves.toEqual({ status: "error", error: "Not answering" });
  });
});

describe("sending into a target", () => {
  // A fake app: a project holding rows; a real send of a new one makes it.
  function projectApp(already = []) {
    const members = new Set(already);
    const labels = { t1: "Proj" };
    let made = 0;
    const send = vi.fn(async ({ instanceIds, dryRun, target }) => {
      if (target?.new && !dryRun) {
        made += 1;
        labels.t9 = target.new;
      }
      const results = Object.fromEntries(
        instanceIds.map((id) => [id, members.has(id) ? { result: "skipped", why: "Already there" } : { result: "sent", why: "" }])
      );
      if (!dryRun) instanceIds.forEach((id) => members.add(id));
      const handle = target?.handle || (target?.new && !dryRun ? "t9" : null);
      return { success: true, results, ...(handle ? { target: { handle, label: labels[handle] } } : {}) };
    });
    return { send, made: () => made };
  }

  it("adds what is not there yet, making a new target once across chunks", async () => {
    const app = projectApp([2]);
    const ids = Array.from({ length: COMPANION_SEND_CHUNK + 5 }, (_, index) => index + 1);
    const outcome = await sendToTarget({
      companionId: "c2",
      actionId: "add",
      instanceIds: ids,
      target: { new: "Fresh" },
      send: app.send,
    });
    expect(outcome.status).toBe("sent");
    expect(outcome.rows).toHaveLength(ids.length - 1);
    expect(outcome.target).toEqual({ handle: "t9", label: "Fresh" });
    expect(app.made()).toBe(1);
    // The dry run names the new target; the real send's later chunks the handle.
    const real = app.send.mock.calls.filter(([request]) => !request.dryRun).map(([request]) => request.target);
    expect(real).toEqual([{ new: "Fresh" }, { handle: "t9" }]);
  });

  it("says when nothing would be added, and checks without sending", async () => {
    const app = projectApp([1, 2]);
    await expect(
      sendToTarget({ companionId: "c2", actionId: "add", instanceIds: [1, 2], target: { handle: "t1" }, send: app.send })
    ).resolves.toMatchObject({ status: "none" });
    const checked = await checkTargetSend({
      companionId: "c2",
      actionId: "add",
      instanceIds: [1, 3],
      target: { handle: "t1" },
      send: app.send,
    });
    expect([...checked.dry.values()].map((entry) => entry.result)).toEqual(["skipped", "sent"]);
    expect(app.send.mock.calls.every(([request]) => request.dryRun)).toBe(true);
  });

  it("takes rows back in chunks with the same target", async () => {
    const withdraw = vi.fn(async ({ instanceIds }) => ({
      success: true,
      results: Object.fromEntries(instanceIds.map((id) => [id, { result: "withdrawn", why: "" }])),
    }));
    const outcome = await withdrawRows({
      companionId: "c2",
      actionId: "add",
      instanceIds: [1, 2],
      target: { handle: "t1" },
      withdraw,
    });
    expect(outcome.status).toBe("done");
    expect(outcome.results.get(2).result).toBe("withdrawn");
    expect(withdraw).toHaveBeenCalledWith({ companionId: "c2", action: "add", instanceIds: [1, 2], target: { handle: "t1" } });
  });
});
