import { act, renderHook } from "@testing-library/react";
import {
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
      useCompanionSend({ action: "polish", instanceIds: ids, onSent })
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
    expect(real.every((request) => request.dryRun === false && request.action === "polish")).toBe(true);
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
