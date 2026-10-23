import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import useRatingArena from "./useRatingArena";

const roundOf = (id, kind = "place") => ({
  success: true,
  round: { id, kind, clips: [{ instanceId: id, role: kind === "place" ? "new" : "check", rating: null }] },
  records: [{ id: `/a1/${id}.mp4`, instanceId: id, fingerprint: `f${id}`, name: `${id}.mp4` }],
  counts: { unrated: 10 - id, rated: id, byRating: {}, total: 10 },
});

function installArena() {
  let next = 1;
  const api = {
    start: vi.fn(async () => ({ success: true, session: "s1", counts: { unrated: 10 } })),
    round: vi.fn(async () => roundOf(next++)),
    finish: vi.fn(async () => ({ success: true, outcomes: { placed: 1 } })),
    end: vi.fn(async () => ({ success: true })),
  };
  window.electronAPI = { arena: api };
  return api;
}

describe("useRatingArena", () => {
  afterEach(() => {
    delete window.electronAPI;
  });

  it("opens, deals, finishes rounds and brings the last one back for Undo", async () => {
    const api = installArena();
    const { result } = renderHook(() => useRatingArena());
    await act(async () => result.current.open());
    expect(result.current.arena).toMatchObject({ session: "s1", status: "ready", roundNumber: 1 });
    expect(result.current.arena.round.id).toBe(1);

    await act(async () => result.current.next());
    expect(api.finish).toHaveBeenCalledWith({ session: "s1", round: 1 });
    expect(result.current.arena.round.id).toBe(2);
    expect(result.current.arena.previous.round.id).toBe(1);
    expect(result.current.arena.finished).toEqual([{ id: 1, outcomes: { placed: 1 } }]);

    act(() => {
      result.current.restorePrevious();
    });
    expect(result.current.arena).toMatchObject({
      restored: true,
      previous: null,
      roundNumber: 1,
      counts: { unrated: 9 },
    });
    expect(result.current.arena.round.id).toBe(1);
    // Its outcomes leave the counts until it is finished again.
    expect(result.current.arena.finished).toEqual([]);

    // Ratings made anywhere reach the round's records.
    act(() =>
      result.current.updateRecords((list) => list.map((video) => ({ ...video, rating: 4 })))
    );
    expect(result.current.arena.records[0].rating).toBe(4);

    let summary = null;
    await act(async () => {
      summary = await result.current.close({ finishCurrent: true });
    });
    expect(api.finish).toHaveBeenLastCalledWith({ session: "s1", round: 1 });
    expect(api.end).toHaveBeenCalledWith("s1");
    expect(summary).toMatchObject({ rounds: 1, placed: 1 });
    expect(result.current.arena).toBeNull();
  });

  it("drops an untouched round for one of a new kind without finishing it", async () => {
    const api = installArena();
    const { result } = renderHook(() => useRatingArena());
    await act(async () => result.current.open());
    await act(async () => result.current.setOptions({ kind: "tier" }));
    expect(api.finish).not.toHaveBeenCalled();
    expect(api.round).toHaveBeenLastCalledWith({ session: "s1", kind: "tier", border: null, match: "similar" });
    expect(result.current.arena).toMatchObject({ kind: "tier", previous: null });
  });

  it("says when the pool has nothing to deal, and closes when it cannot open", async () => {
    const api = installArena();
    api.round.mockResolvedValueOnce({ success: true, round: null, reason: "place", counts: { unrated: 0 } });
    const notify = vi.fn();
    const { result } = renderHook(() => useRatingArena({ notify }));
    await act(async () => result.current.open({ kind: "place" }));
    expect(result.current.arena).toMatchObject({ status: "empty", reason: "place", round: null });

    await act(async () => {
      await result.current.close();
    });
    api.start.mockResolvedValueOnce({ success: false, error: "no" });
    await act(async () => result.current.open());
    await waitFor(() => expect(result.current.arena).toBeNull());
    expect(notify).toHaveBeenCalledWith("The arena could not open", "error");
  });
});
