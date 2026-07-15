import { act, renderHook, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import useReviewSessions, {
  REVIEW_SESSION_SAVE_DEBOUNCE_MS,
  REVIEW_SESSION_SUMMARY_LIMIT,
} from "./useReviewSessions";

const view = {
  version: 1,
  filters: {
    includeTags: [],
    excludeTags: [],
    minRating: null,
    exactRating: null,
    reviewFilter: "any",
  },
  sort: {
    key: "name",
    dir: "asc",
    groupByFolders: true,
    randomSeed: null,
  },
};

const draft = (rootPath = "/root", overrides = {}) => ({
  rootPath,
  directory: "",
  scope: "all-descendants",
  view,
  anchorInstanceId: 1,
  anchorFingerprint: "fp-1",
  ...overrides,
});

const checkpoint = (rootPath = "/root", overrides = {}) => ({
  ...draft(rootPath),
  updatedAt: 100,
  ...overrides,
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const summary = (rootPath, updatedAt = 100) => ({
  rootPath,
  directory: "",
  scope: "all-descendants",
  updatedAt,
});

let profileChanged;
let flushRequested;
let disposeProfile;
let disposeFlush;
let sessions;

beforeEach(() => {
  profileChanged = null;
  flushRequested = null;
  disposeProfile = vi.fn();
  disposeFlush = vi.fn();
  sessions = {
    list: vi.fn().mockResolvedValue({ sessions: [summary("/root")] }),
    get: vi.fn().mockImplementation(async (rootPath) => ({
      checkpoint: checkpoint(rootPath),
    })),
    save: vi.fn().mockImplementation(async (nextDraft) => ({
      checkpoint: { ...nextDraft, updatedAt: Date.now() },
    })),
    clear: vi.fn().mockResolvedValue({ deleted: true }),
    onFlushRequested: vi.fn((callback) => {
      flushRequested = callback;
      return disposeFlush;
    }),
    acknowledgeFlush: vi.fn(),
  };
  window.electronAPI = {
    review: { sessions },
    profiles: {
      onChanged: vi.fn((callback) => {
        profileChanged = callback;
        return disposeProfile;
      }),
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
  delete window.electronAPI;
});

describe("useReviewSessions", () => {
  it("loads bounded profile summaries and auto-loads the active checkpoint", async () => {
    sessions.list.mockResolvedValue({
      sessions: Array.from(
        { length: REVIEW_SESSION_SUMMARY_LIMIT + 10 },
        (_, index) => summary(`/root-${index}`, index)
      ),
    });
    const { result } = renderHook(() => useReviewSessions({
      activeRootPath: "/root-10",
    }));

    await waitFor(() => {
      expect(result.current.summaries).toHaveLength(REVIEW_SESSION_SUMMARY_LIMIT);
      expect(sessions.get).toHaveBeenCalledWith("/root-10");
      expect(result.current.checkpointRootPath).toBe("/root-10");
    });
    expect(result.current.summaryByRoot).toBeInstanceOf(Map);
    expect(result.current.hasCheckpoint("/root-10")).toBe(true);
  });

  it("discards late profile results and refetches isolated summaries", async () => {
    const oldList = deferred();
    sessions.list
      .mockImplementationOnce(() => oldList.promise)
      .mockResolvedValueOnce({ sessions: [summary("/new-profile")] });
    const { result } = renderHook(() => useReviewSessions());

    act(() => profileChanged({ profileId: "new" }));
    await waitFor(() =>
      expect(result.current.hasCheckpoint("/new-profile")).toBe(true)
    );

    await act(async () => {
      oldList.resolve({ sessions: [summary("/old-profile")] });
      await oldList.promise;
    });
    expect(result.current.hasCheckpoint("/old-profile")).toBe(false);
    expect(result.current.summaries.map((item) => item.rootPath)).toEqual([
      "/new-profile",
    ]);
  });

  it("debounces only engaged sessions for 400 ms", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useReviewSessions({
      activeRootPath: "/root",
    }));
    await settle();
    sessions.save.mockClear();

    expect(result.current.schedule(draft("/root", {
      anchorInstanceId: 2,
      anchorFingerprint: "fp-2",
    }))).toBe(false);
    act(() => result.current.engage("/root", draft("/root")));
    expect(result.current.isEngaged).toBe(true);
    expect(result.current.schedule(draft("/root", {
      anchorInstanceId: 2,
      anchorFingerprint: "fp-2",
    }))).toBe(true);

    act(() => vi.advanceTimersByTime(REVIEW_SESSION_SAVE_DEBOUNCE_MS - 1));
    expect(sessions.save).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(sessions.save).toHaveBeenCalledOnce();
    expect(sessions.save.mock.calls[0][0].anchorInstanceId).toBe(2);
  });

  it("owns engagement by root, directory, and scope without moving on passive navigation", async () => {
    let location = {
      activeRootPath: "/root",
      activeDirectory: "run-a",
      activeScope: "current-folder",
    };
    const { result, rerender } = renderHook(() =>
      useReviewSessions(location)
    );
    await settle();
    const savedLocation = draft("/root", {
      directory: "run-a",
      scope: "current-folder",
    });
    act(() => result.current.engage("/root", savedLocation));
    expect(result.current.isEngaged).toBe(true);

    location = { ...location, activeDirectory: "run-b" };
    rerender();
    expect(result.current.isEngaged).toBe(false);
    expect(result.current.schedule(draft("/root", {
      directory: "run-b",
      scope: "current-folder",
      anchorInstanceId: 7,
      anchorFingerprint: "fp-7",
    }))).toBe(false);
    expect(sessions.save).not.toHaveBeenCalled();

    location = { ...location, activeDirectory: "run-a" };
    rerender();
    expect(result.current.isEngaged).toBe(true);
  });

  it("keeps one in-flight save and only the newest trailing draft", async () => {
    const first = deferred();
    const second = deferred();
    sessions.save
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { result } = renderHook(() => useReviewSessions());
    await settle();
    act(() => result.current.engage("/root", draft("/root")));

    let drain;
    act(() => {
      drain = result.current.saveNow(draft("/root", {
        anchorInstanceId: 2,
        anchorFingerprint: "fp-2",
      }));
      for (let index = 3; index <= 20; index += 1) {
        result.current.saveNow(draft("/root", {
          anchorInstanceId: index,
          anchorFingerprint: `fp-${index}`,
        }));
      }
    });
    expect(sessions.save).toHaveBeenCalledOnce();
    expect(result.current.saving).toBe(true);

    await act(async () => {
      first.resolve({
        checkpoint: checkpoint("/root", {
          anchorInstanceId: 2,
          anchorFingerprint: "fp-2",
          updatedAt: 101,
        }),
      });
      await Promise.resolve();
    });
    expect(sessions.save).toHaveBeenCalledTimes(2);
    expect(sessions.save.mock.calls[1][0]).toMatchObject({
      anchorInstanceId: 20,
      anchorFingerprint: "fp-20",
    });

    await act(async () => {
      second.resolve({
        checkpoint: checkpoint("/root", {
          anchorInstanceId: 20,
          anchorFingerprint: "fp-20",
          updatedAt: 102,
        }),
      });
      await drain;
    });
    expect(sessions.save).toHaveBeenCalledTimes(2);
    expect(result.current.saving).toBe(false);
    expect(result.current.checkpoint.anchorInstanceId).toBe(20);
  });

  it("retains an undo cursor behind an in-flight first checkpoint save", async () => {
    sessions.list.mockResolvedValueOnce({ sessions: [] });
    const first = deferred();
    const second = deferred();
    sessions.save
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { result } = renderHook(() => useReviewSessions());
    await settle();
    act(() => result.current.engage("/new-root", draft("/new-root")));

    let drain;
    act(() => {
      result.current.saveNow(
        draft("/new-root", {
          anchorInstanceId: 2,
          anchorFingerprint: "fp-2",
        }),
        { allowCreate: true, engage: true }
      );
      drain = result.current.saveNow(draft("/new-root", {
        anchorInstanceId: 1,
        anchorFingerprint: "fp-1",
      }));
    });
    expect(sessions.save).toHaveBeenCalledOnce();

    await act(async () => {
      first.resolve({
        checkpoint: checkpoint("/new-root", {
          anchorInstanceId: 2,
          anchorFingerprint: "fp-2",
          updatedAt: 101,
        }),
      });
      await Promise.resolve();
    });
    expect(sessions.save).toHaveBeenCalledTimes(2);
    expect(sessions.save.mock.calls[1][0]).toMatchObject({
      anchorInstanceId: 1,
      anchorFingerprint: "fp-1",
    });

    await act(async () => {
      second.resolve({
        checkpoint: checkpoint("/new-root", {
          anchorInstanceId: 1,
          anchorFingerprint: "fp-1",
          updatedAt: 102,
        }),
      });
      await drain;
    });
    expect(result.current.checkpoint.anchorInstanceId).toBe(1);
  });

  it("flushes a pending draft before acknowledging the lifecycle request", async () => {
    vi.useFakeTimers();
    const pendingSave = deferred();
    sessions.save.mockImplementationOnce(() => pendingSave.promise);
    const { result } = renderHook(() => useReviewSessions());
    await settle();
    act(() => result.current.engage("/root", draft("/root")));
    act(() => result.current.schedule(draft("/root", {
      anchorInstanceId: 5,
      anchorFingerprint: "fp-5",
    })));

    act(() => flushRequested(Object.freeze({ requestId: "request-1" })));
    await settle();
    expect(sessions.save).toHaveBeenCalledOnce();
    expect(sessions.acknowledgeFlush).not.toHaveBeenCalled();

    await act(async () => {
      pendingSave.resolve({
        checkpoint: checkpoint("/root", {
          anchorInstanceId: 5,
          anchorFingerprint: "fp-5",
        }),
      });
      await pendingSave.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sessions.acknowledgeFlush).toHaveBeenCalledWith("request-1");
  });

  it("acknowledges flush even when persistence rejects", async () => {
    sessions.save.mockRejectedValueOnce(new Error("disk failed"));
    const notify = vi.fn();
    const { result } = renderHook(() => useReviewSessions({ notify }));
    await settle();
    act(() => result.current.engage("/root", draft("/root")));
    act(() => result.current.schedule(draft("/root", {
      anchorInstanceId: 8,
      anchorFingerprint: "fp-8",
    })));
    act(() => flushRequested({ requestId: "request-2" }));

    await waitFor(() =>
      expect(sessions.acknowledgeFlush).toHaveBeenCalledWith("request-2")
    );
    expect(notify).toHaveBeenCalledWith("disk failed", "error");
  });

  it("silently ignores expected lifecycle invalidation", async () => {
    const invalidated = Object.assign(new Error("closing"), {
      code: "APPLICATION_SHUTDOWN_REQUESTED",
    });
    sessions.save.mockRejectedValueOnce(invalidated);
    const notify = vi.fn();
    const { result } = renderHook(() => useReviewSessions({ notify }));
    await settle();
    act(() => result.current.engage("/root", draft("/root")));

    await act(async () => {
      await result.current.saveNow(draft("/root", {
        anchorInstanceId: 2,
        anchorFingerprint: "fp-2",
      }));
    });
    expect(notify).not.toHaveBeenCalled();
    expect(result.current.error).toBe(null);
  });

  it("lets a new profile save immediately while an old save settles late", async () => {
    const oldSave = deferred();
    sessions.save.mockImplementationOnce(() => oldSave.promise);
    sessions.list
      .mockResolvedValueOnce({ sessions: [summary("/root")] })
      .mockResolvedValueOnce({ sessions: [summary("/new-root")] });
    const { result } = renderHook(() => useReviewSessions());
    await settle();
    act(() => result.current.engage("/root", draft("/root")));
    act(() => {
      result.current.saveNow(draft("/root", {
        anchorInstanceId: 2,
        anchorFingerprint: "fp-2",
      }));
      result.current.saveNow(draft("/root", {
        anchorInstanceId: 3,
        anchorFingerprint: "fp-3",
      }));
    });

    act(() => profileChanged({ profileId: "new" }));
    await waitFor(() =>
      expect(result.current.hasCheckpoint("/new-root")).toBe(true)
    );
    act(() => result.current.engage("/new-root", draft("/new-root")));
    await act(async () => {
      await result.current.saveNow(draft("/new-root", {
        anchorInstanceId: 9,
        anchorFingerprint: "new-fp",
      }));
    });
    expect(sessions.save).toHaveBeenCalledTimes(2);
    expect(sessions.save.mock.calls[1][0].rootPath).toBe("/new-root");

    await act(async () => {
      oldSave.resolve({ checkpoint: checkpoint("/root", { updatedAt: 999 }) });
      await oldSave.promise;
    });
    expect(result.current.hasCheckpoint("/root")).toBe(false);
    expect(result.current.checkpointRootPath).toBe("/new-root");
  });

  it("loads and clears a checkpoint without disturbing review metadata", async () => {
    const { result } = renderHook(() => useReviewSessions());
    await settle();

    let loaded;
    await act(async () => {
      loaded = await result.current.load("/root");
    });
    expect(loaded.rootPath).toBe("/root");
    act(() => result.current.engage("/root", loaded));

    await act(async () => {
      expect(await result.current.clear("/root")).toBe(true);
    });
    expect(sessions.clear).toHaveBeenCalledWith("/root");
    expect(result.current.hasCheckpoint("/root")).toBe(false);
    expect(result.current.checkpoint).toBe(null);
    expect(result.current.engagedRootPath).toBe(null);
  });

  it("unsubscribes profile and flush listeners on unmount", async () => {
    const { unmount } = renderHook(() => useReviewSessions());
    await settle();
    unmount();
    expect(disposeProfile).toHaveBeenCalledOnce();
    expect(disposeFlush).toHaveBeenCalledOnce();
  });
});
