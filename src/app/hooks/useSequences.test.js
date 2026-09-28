import { act, renderHook, waitFor } from "@testing-library/react";
import { useSequences } from "./useSequences";

const snapshot = (entries, overrides = {}) => ({
  id: 7,
  name: "Act one",
  entryCount: entries.length,
  createdAt: 0,
  updatedAt: 0,
  entries,
  missingCount: entries.filter((item) => !item.video).length,
  ...overrides,
});

const entry = (id, present = true) => ({
  id,
  position: id - 1,
  fingerprint: `fp-${id}`,
  addedAt: 0,
  video: present
    ? {
        id: `/library/${id}.mp4`,
        instanceId: id * 10,
        name: `${id}.mp4`,
        rootPath: "/library",
        isElectronFile: true,
      }
    : null,
});

describe("useSequences", () => {
  beforeEach(() => {
    window.electronAPI = {
      sequences: {
        list: vi.fn().mockResolvedValue({
          success: true,
          sequences: [{ id: 7, name: "Act one", entryCount: 2 }],
        }),
        snapshot: vi.fn().mockResolvedValue({
          success: true,
          sequence: snapshot([entry(1), entry(2)]),
        }),
        create: vi.fn().mockResolvedValue({
          success: true,
          sequence: { id: 8, name: "Act two", entryCount: 0 },
        }),
        rename: vi.fn().mockResolvedValue({ success: true, sequence: {} }),
        remove: vi.fn().mockResolvedValue({ success: true, deleted: true }),
        append: vi.fn().mockResolvedValue({ success: true, entries: [] }),
        removeEntries: vi.fn().mockResolvedValue({ success: true, entries: [] }),
        reorder: vi.fn().mockResolvedValue({ success: true, entries: [] }),
        moveEntry: vi.fn().mockResolvedValue({ success: true, entries: [] }),
      },
    };
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it("lists sequences and loads the selected one as a resolved snapshot", async () => {
    const { result } = renderHook(() =>
      useSequences({ preferredRootPath: "/library" })
    );
    await waitFor(() => expect(result.current.sequences).toHaveLength(1));

    await act(async () => {
      result.current.selectSequence(7);
    });
    await waitFor(() => expect(result.current.activeSequence).toBeTruthy());

    expect(window.electronAPI.sequences.snapshot).toHaveBeenCalledWith(7, {
      preferredRootPath: "/library",
    });
    expect(result.current.activeSequence.entries).toHaveLength(2);
  });

  it("appends the given fingerprints in order and reloads", async () => {
    const { result } = renderHook(() => useSequences());
    await waitFor(() => expect(result.current.sequences).toHaveLength(1));
    await act(async () => {
      result.current.selectSequence(7);
    });
    await waitFor(() => expect(result.current.activeSequence).toBeTruthy());

    await act(async () => {
      await result.current.appendFingerprints(["fp-a", "fp-b", "fp-a"]);
    });

    // A repeated fingerprint is meaningful: a story can return to a shot.
    expect(window.electronAPI.sequences.append).toHaveBeenCalledWith(7, [
      "fp-a",
      "fp-b",
      "fp-a",
    ]);
    expect(window.electronAPI.sequences.snapshot).toHaveBeenCalledTimes(2);
  });

  it("does not call the store for an empty append", async () => {
    const { result } = renderHook(() => useSequences());
    await waitFor(() => expect(result.current.sequences).toHaveLength(1));
    await act(async () => {
      result.current.selectSequence(7);
    });

    await act(async () => {
      await result.current.appendFingerprints([]);
    });
    expect(window.electronAPI.sequences.append).not.toHaveBeenCalled();
  });

  it("shows a move immediately and then reloads the authoritative order", async () => {
    let resolveMove;
    window.electronAPI.sequences.moveEntry.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMove = () => resolve({ success: true, entries: [] });
        })
    );
    const { result } = renderHook(() => useSequences());
    await waitFor(() => expect(result.current.sequences).toHaveLength(1));
    await act(async () => {
      result.current.selectSequence(7);
    });
    await waitFor(() => expect(result.current.activeSequence).toBeTruthy());

    let pending;
    await act(async () => {
      pending = result.current.moveEntry(2, 0);
    });

    // Optimistic: the drop reads as landed before the store has answered.
    expect(result.current.activeSequence.entries.map((item) => item.id)).toEqual(
      [2, 1]
    );
    expect(
      result.current.activeSequence.entries.map((item) => item.position)
    ).toEqual([0, 1]);

    window.electronAPI.sequences.snapshot.mockResolvedValue({
      success: true,
      sequence: snapshot([entry(2), entry(1)]),
    });
    await act(async () => {
      resolveMove();
      await pending;
    });
    expect(result.current.activeSequence.entries.map((item) => item.id)).toEqual(
      [2, 1]
    );
  });

  it("reloads after a failed move so the optimistic order cannot stick", async () => {
    window.electronAPI.sequences.moveEntry.mockResolvedValue({
      success: false,
      error: "Entry 2 is not in sequence 7",
    });
    const { result } = renderHook(() => useSequences());
    await waitFor(() => expect(result.current.sequences).toHaveLength(1));
    await act(async () => {
      result.current.selectSequence(7);
    });
    await waitFor(() => expect(result.current.activeSequence).toBeTruthy());

    await act(async () => {
      await result.current.moveEntry(2, 0);
    });

    expect(result.current.error).toMatch(/not in sequence/i);
    expect(result.current.activeSequence.entries.map((item) => item.id)).toEqual(
      [1, 2]
    );
  });

  it("reports a name collision without clearing the list", async () => {
    window.electronAPI.sequences.create.mockResolvedValue({
      success: false,
      error: 'A sequence named "Act one" already exists',
      code: "SEQUENCE_NAME_TAKEN",
    });
    const { result } = renderHook(() => useSequences());
    await waitFor(() => expect(result.current.sequences).toHaveLength(1));

    await act(async () => {
      await result.current.createSequence("Act one").catch(() => {});
    });

    expect(result.current.error).toMatch(/already exists/i);
    expect(result.current.sequences).toHaveLength(1);
  });

  it("selects a surviving sequence after deleting the active one", async () => {
    window.electronAPI.sequences.list
      .mockResolvedValueOnce({
        success: true,
        sequences: [
          { id: 7, name: "Act one", entryCount: 2 },
          { id: 9, name: "Act three", entryCount: 1 },
        ],
      })
      .mockResolvedValue({
        success: true,
        sequences: [{ id: 9, name: "Act three", entryCount: 1 }],
      });
    const { result } = renderHook(() => useSequences());
    await waitFor(() => expect(result.current.sequences).toHaveLength(2));
    await act(async () => {
      result.current.selectSequence(7);
    });

    await act(async () => {
      await result.current.deleteSequence(7);
    });

    expect(result.current.activeSequenceId).toBe(9);
  });

  it("drops everything belonging to the previous profile", async () => {
    let notify;
    window.electronAPI.profiles = {
      onChanged: (callback) => {
        notify = callback;
        return () => {};
      },
    };
    const { result } = renderHook(() => useSequences());
    await waitFor(() => expect(result.current.sequences).toHaveLength(1));
    await act(async () => {
      result.current.selectSequence(7);
    });
    await waitFor(() => expect(result.current.activeSequence).toBeTruthy());

    window.electronAPI.sequences.list.mockResolvedValue({
      success: true,
      sequences: [],
    });
    await act(async () => {
      notify();
    });

    await waitFor(() => expect(result.current.sequences).toHaveLength(0));
    expect(result.current.activeSequenceId).toBeNull();
    expect(result.current.activeSequence).toBeNull();
  });
});
