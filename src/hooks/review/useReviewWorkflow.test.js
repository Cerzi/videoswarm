import { act, renderHook, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import useReviewWorkflow, {
  REVIEW_WORKFLOW_MAX_PENDING,
  buildReviewProgress,
} from "./useReviewWorkflow";

const video = (id, fingerprint, reviewState = "unreviewed", rating = null) => ({
  id,
  fingerprint,
  reviewState,
  rating,
  tags: ["untouched"],
});

const successful = { success: true };

const makeProps = (overrides = {}) => ({
  scopeVideos: [video("a", "fp-a"), video("b", "fp-b")],
  orderedVideoIds: ["a", "b"],
  selectedIds: new Set(["a"]),
  selectExactly: vi.fn(),
  setSelectedIds: vi.fn(),
  scrollToId: vi.fn(),
  ownershipKey: "profile-1/root-1/scope-1",
  setReviewState: vi.fn().mockResolvedValue(successful),
  setRating: vi.fn().mockResolvedValue(successful),
  restoreReviewMetadata: vi.fn().mockResolvedValue(successful),
  autoAdvance: false,
  notify: vi.fn(),
  ...overrides,
});

describe("buildReviewProgress", () => {
  it("counts instances while treating a rating as reviewed evidence", () => {
    expect(
      buildReviewProgress([
        video("a", "fp-a"),
        video("b", "fp-b", "unreviewed", 4),
        video("c", "fp-c", "reviewed"),
        video("d", "fp-d", "pick", 5),
        video("e", "fp-e", "reject"),
      ])
    ).toEqual({
      total: 5,
      reviewedTotal: 4,
      reviewed: 2,
      accept: 1,
      reject: 1,
      unreviewed: 1,
    });
  });
});

describe("useReviewWorkflow", () => {
  it("deduplicates fingerprint targets and skips duplicate instances when advancing", async () => {
    const props = makeProps({
      scopeVideos: [
        video("a", "fp-a"),
        video("a-copy", "fp-a"),
        video("b", "fp-b"),
      ],
      orderedVideoIds: ["a", "a-copy", "b"],
      selectedIds: new Set(["a"]),
      autoAdvance: true,
    });
    const { result } = renderHook(() => useReviewWorkflow(props));

    await act(async () => {
      expect(await result.current.applyReviewState("pick")).toBe(true);
    });

    expect(props.setReviewState).toHaveBeenCalledWith("pick", ["fp-a"]);
    expect(props.selectExactly).toHaveBeenCalledWith("b");
    expect(props.scrollToId).toHaveBeenCalledWith("b", { align: "center" });
    expect(result.current.canUndo).toBe(true);
  });

  it("deduplicates a multi-selection without auto-advancing", async () => {
    const props = makeProps({
      scopeVideos: [video("a", "fp-a"), video("a-copy", "fp-a")],
      orderedVideoIds: ["a", "a-copy"],
      selectedIds: new Set(["a", "a-copy"]),
      autoAdvance: true,
    });
    const { result } = renderHook(() => useReviewWorkflow(props));

    await act(async () => {
      await result.current.applyReviewState("reject");
    });

    expect(props.setReviewState).toHaveBeenCalledWith("reject", ["fp-a"]);
    expect(props.selectExactly).not.toHaveBeenCalled();
  });

  it.each([
    ["resetting to Unreviewed", "review", "unreviewed"],
    ["clearing a rating", "rating", null],
  ])("does not advance when %s", async (_label, kind, value) => {
    const props = makeProps({ autoAdvance: true });
    const { result } = renderHook(() => useReviewWorkflow(props));

    await act(async () => {
      if (kind === "review") await result.current.applyReviewState(value);
      else await result.current.applyRating(value);
    });

    expect(props.selectExactly).not.toHaveBeenCalled();
  });

  it("allows ratings 1-5 to advance", async () => {
    const props = makeProps({ autoAdvance: true });
    const { result } = renderHook(() => useReviewWorkflow(props));

    await act(async () => {
      await result.current.applyRating(4);
    });

    expect(props.setRating).toHaveBeenCalledWith(4, ["fp-a"]);
    expect(props.selectExactly).toHaveBeenCalledWith("b");
  });

  it("does not advance or replace undo history after a failed write", async () => {
    const props = makeProps({
      autoAdvance: true,
      setReviewState: vi.fn().mockResolvedValue({ success: false }),
    });
    const { result } = renderHook(() => useReviewWorkflow(props));

    await act(async () => {
      expect(await result.current.applyReviewState("pick")).toBe(false);
    });

    expect(props.selectExactly).not.toHaveBeenCalled();
    expect(result.current.canUndo).toBe(false);
  });

  it("serializes rapid mutations and uses the selection advanced by the prior action", async () => {
    let resolveFirst;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const setReviewState = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(successful);
    const props = makeProps({ autoAdvance: true, setReviewState });
    const { result } = renderHook(() => useReviewWorkflow(props));

    let firstAction;
    let secondAction;
    act(() => {
      firstAction = result.current.applyReviewState("pick");
      secondAction = result.current.applyReviewState("reject");
    });

    await waitFor(() => expect(setReviewState).toHaveBeenCalledTimes(1));
    expect(result.current.isBusy).toBe(true);

    await act(async () => {
      resolveFirst(successful);
      await Promise.all([firstAction, secondAction]);
    });

    expect(setReviewState.mock.calls).toEqual([
      ["pick", ["fp-a"]],
      ["reject", ["fp-b"]],
    ]);
    expect(result.current.isBusy).toBe(false);
  });

  it("bounds held-key input without repeating saturation warnings", async () => {
    let resolveFirst;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const setReviewState = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(successful);
    const props = makeProps({ setReviewState });
    const { result } = renderHook(() => useReviewWorkflow(props));
    let actions;

    act(() => {
      actions = Array.from(
        { length: REVIEW_WORKFLOW_MAX_PENDING + 2 },
        () => result.current.applyReviewState("reviewed")
      );
    });

    await expect(actions.at(-1)).resolves.toBe(false);
    expect(props.notify).toHaveBeenCalledTimes(1);
    expect(props.notify).toHaveBeenCalledWith(
      "Review input queue is full; wait for pending changes",
      "warning"
    );

    await act(async () => {
      resolveFirst(successful);
      await Promise.all(actions);
    });
    expect(setReviewState).toHaveBeenCalledTimes(REVIEW_WORKFLOW_MAX_PENDING);
    expect(result.current.isBusy).toBe(false);
  });

  it("uses queued metadata for same-clip undo before React commits the first patch", async () => {
    const setReviewState = vi.fn(async (value, fingerprints) => ({
      success: true,
      updates: {
        [fingerprints[0]]: { reviewState: value, rating: null },
      },
    }));
    const props = makeProps({ setReviewState, autoAdvance: false });
    const { result } = renderHook(() => useReviewWorkflow(props));

    await act(async () => {
      await Promise.all([
        result.current.applyReviewState("pick"),
        result.current.applyReviewState("reject"),
      ]);
    });
    setReviewState.mockClear();
    props.setRating.mockClear();
    props.restoreReviewMetadata.mockClear();

    await act(async () => {
      await result.current.undo();
    });

    expect(props.restoreReviewMetadata).toHaveBeenCalledWith([
      { fingerprint: "fp-a", reviewState: "pick", rating: null },
    ]);
    expect(setReviewState).not.toHaveBeenCalled();
    expect(props.setRating).not.toHaveBeenCalled();
  });

  it("does not auto-advance when selection changes during the write", async () => {
    let resolveMutation;
    const setReviewState = vi.fn(
      () => new Promise((resolve) => {
        resolveMutation = resolve;
      })
    );
    let props = makeProps({ autoAdvance: true, setReviewState });
    const { result, rerender } = renderHook(() => useReviewWorkflow(props));

    let action;
    act(() => {
      action = result.current.applyReviewState("pick");
    });
    await waitFor(() => expect(setReviewState).toHaveBeenCalledOnce());

    props = { ...props, selectedIds: new Set(["b"]) };
    rerender();
    await act(async () => {
      resolveMutation(successful);
      await action;
    });

    expect(props.selectExactly).not.toHaveBeenCalled();
  });

  it("does not retain undo or advance when ownership changes during a write", async () => {
    let resolveMutation;
    const setReviewState = vi.fn(
      () => new Promise((resolve) => {
        resolveMutation = resolve;
      })
    );
    let props = makeProps({ autoAdvance: true, setReviewState });
    const { result, rerender } = renderHook(() => useReviewWorkflow(props));

    let action;
    act(() => {
      action = result.current.applyReviewState("pick");
    });
    await waitFor(() => expect(setReviewState).toHaveBeenCalledOnce());

    props = { ...props, ownershipKey: "profile-2/root-2/scope-1" };
    rerender();
    await act(async () => {
      resolveMutation(successful);
      await action;
    });

    expect(props.selectExactly).not.toHaveBeenCalled();
    expect(result.current.canUndo).toBe(false);
  });

  it("serializes explicit fingerprint targets without auto-advancing selection", async () => {
    const props = makeProps({ autoAdvance: true });
    const { result } = renderHook(() => useReviewWorkflow(props));

    await act(async () => {
      await result.current.applyRating(5, {
        fingerprints: ["fp-b", "fp-b"],
        allowAdvance: false,
      });
    });

    expect(props.setRating).toHaveBeenCalledWith(5, ["fp-b"]);
    expect(props.selectExactly).not.toHaveBeenCalled();
    expect(result.current.canUndo).toBe(true);
  });

  it("undo restores review and rating snapshots, then the surviving original selection", async () => {
    let props = makeProps({
      scopeVideos: [
        video("a", "fp-a", "reviewed", 4),
        video("b", "fp-b", "unreviewed", null),
      ],
      selectedIds: new Set(["a", "b"]),
    });
    const { result, rerender } = renderHook(() => useReviewWorkflow(props));

    await act(async () => {
      await result.current.applyReviewState("reject");
    });
    expect(result.current.canUndo).toBe(true);

    props = { ...props, scopeVideos: [props.scopeVideos[0]] };
    rerender();
    props.setReviewState.mockClear();
    props.setRating.mockClear();
    props.restoreReviewMetadata.mockClear();

    await act(async () => {
      expect(await result.current.undo()).toBe(true);
    });

    expect(props.restoreReviewMetadata).toHaveBeenCalledWith([
      { fingerprint: "fp-a", reviewState: "reviewed", rating: 4 },
      { fingerprint: "fp-b", reviewState: "unreviewed", rating: null },
    ]);
    expect(props.setReviewState).not.toHaveBeenCalled();
    expect(props.setRating).not.toHaveBeenCalled();
    expect(props.setSelectedIds).toHaveBeenCalledWith(new Set(["a"]));
    expect(props.notify).toHaveBeenCalledWith(
      "Undid last review change",
      "success"
    );
    expect(result.current.canUndo).toBe(false);
  });

  it("treats undo with no successful history as a harmless no-op", async () => {
    const props = makeProps();
    const { result } = renderHook(() => useReviewWorkflow(props));

    await act(async () => {
      expect(await result.current.undo()).toBe(false);
    });

    expect(props.setReviewState).not.toHaveBeenCalled();
    expect(props.setRating).not.toHaveBeenCalled();
    expect(props.notify).not.toHaveBeenCalled();
  });

  it("keeps undo history and local state intact when atomic restore fails", async () => {
    const restoreReviewMetadata = vi
      .fn()
      .mockResolvedValue({ success: false, error: "write failed" });
    const props = makeProps({ restoreReviewMetadata });
    const { result } = renderHook(() => useReviewWorkflow(props));

    await act(async () => {
      await result.current.applyReviewState("reject");
    });
    expect(result.current.canUndo).toBe(true);

    await act(async () => {
      expect(await result.current.undo()).toBe(false);
    });

    expect(restoreReviewMetadata).toHaveBeenCalledWith([
      { fingerprint: "fp-a", reviewState: "unreviewed", rating: null },
    ]);
    expect(props.setSelectedIds).not.toHaveBeenCalled();
    expect(props.notify).not.toHaveBeenCalledWith(
      "Undid last review change",
      "success"
    );
    expect(result.current.canUndo).toBe(true);
  });

  it("clears undo when the profile/root ownership key changes", async () => {
    let props = makeProps();
    const { result, rerender } = renderHook(() => useReviewWorkflow(props));

    await act(async () => {
      await result.current.applyReviewState("reviewed");
    });
    expect(result.current.canUndo).toBe(true);

    props = { ...props, ownershipKey: "profile-2/root-2/scope-1" };
    rerender();
    await waitFor(() => expect(result.current.canUndo).toBe(false));
  });

  it("announces the queue end and clears selection only when filtering removes it", async () => {
    let props = makeProps({
      scopeVideos: [video("a", "fp-a")],
      orderedVideoIds: ["a"],
      selectedIds: new Set(["a"]),
      autoAdvance: true,
    });
    const originalOrder = props.orderedVideoIds;
    const { result, rerender } = renderHook(() => useReviewWorkflow(props));

    await act(async () => {
      await result.current.applyReviewState("reviewed");
    });
    expect(props.notify).toHaveBeenCalledWith(
      "Reached the end of the review queue",
      "info"
    );
    expect(props.setSelectedIds).not.toHaveBeenCalled();

    props = { ...props, orderedVideoIds: [] };
    expect(props.orderedVideoIds).not.toBe(originalOrder);
    rerender();
    await waitFor(() =>
      expect(props.setSelectedIds).toHaveBeenCalledWith(new Set())
    );
  });
});
