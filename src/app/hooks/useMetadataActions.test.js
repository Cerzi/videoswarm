import { renderHook, act } from "@testing-library/react";
import { useMetadataActions } from "./useMetadataActions";

const noop = () => {};

const deferredPromise = () => {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

describe("useMetadataActions", () => {
  afterEach(() => {
    delete window.electronAPI;
  });

  it("applies metadata patches", () => {
    let videos = [
      { id: "1", fingerprint: "fp1", rating: 1, tags: [], dimensions: null },
    ];
    const setVideos = (updater) => {
      videos = typeof updater === "function" ? updater(videos) : updater;
    };
    const { result } = renderHook(() =>
      useMetadataActions({
        selectedFingerprints: ["fp1"],
        setVideos,
        setAvailableTags: noop,
        notify: noop,
      })
    );

    act(() => {
      result.current.applyMetadataPatch({ fp1: { rating: 4.4, tags: ["A"] } });
    });

    expect(videos[0].rating).toBe(4);
    expect(videos[0].tags).toEqual(["A"]);
  });

  it("adds tags via electron API", async () => {
    let videos = [
      { id: "1", fingerprint: "fp1", rating: null, tags: [], dimensions: null },
    ];
    const setVideos = (updater) => {
      videos = typeof updater === "function" ? updater(videos) : updater;
    };
    const setAvailableTags = vi.fn();
    const notify = vi.fn();

    window.electronAPI = {
      metadata: {
        addTags: vi.fn().mockResolvedValue({
          updates: { fp1: { tags: ["tag"] } },
          tags: ["tag"],
        }),
      },
    };

    const { result } = renderHook(() =>
      useMetadataActions({
        selectedFingerprints: ["fp1"],
        setVideos,
        setAvailableTags,
        notify,
      })
    );

    await act(async () => {
      await result.current.handleAddTags(["tag"]);
    });

    expect(window.electronAPI.metadata.addTags).toHaveBeenCalledWith(["fp1"], ["tag"]);
    expect(setAvailableTags).toHaveBeenCalledWith(["tag"]);
    expect(notify).toHaveBeenCalled();
    expect(videos[0].tags).toEqual(["tag"]);
  });

  it("uses an explicit tag target instead of a later grid selection", async () => {
    window.electronAPI = {
      metadata: {
        addTags: vi.fn().mockResolvedValue({ updates: {}, tags: ["keep"] }),
        removeTag: vi.fn().mockResolvedValue({ updates: {}, tags: [] }),
      },
    };
    const { result, rerender } = renderHook(
      ({ selectedFingerprints }) =>
        useMetadataActions({
          selectedFingerprints,
          setVideos: noop,
          setAvailableTags: noop,
          notify: noop,
        }),
      { initialProps: { selectedFingerprints: ["active-fullscreen"] } }
    );
    const captured = ["active-fullscreen"];

    rerender({ selectedFingerprints: ["new-grid-selection"] });
    await act(async () => {
      await result.current.handleAddTags(["keep"], captured);
      await result.current.handleRemoveTag("keep", captured);
    });

    expect(window.electronAPI.metadata.addTags).toHaveBeenCalledWith(
      captured,
      ["keep"]
    );
    expect(window.electronAPI.metadata.removeTag).toHaveBeenCalledWith(
      captured,
      "keep"
    );
  });

  it("drops a delayed tag completion after its fullscreen session changes", async () => {
    const write = deferredPromise();
    let videos = [
      { id: "1", fingerprint: "fp1", rating: null, tags: [], dimensions: null },
    ];
    const setVideos = (updater) => {
      videos = typeof updater === "function" ? updater(videos) : updater;
    };
    const setAvailableTags = vi.fn();
    const notify = vi.fn();
    let sessionIsCurrent = true;
    window.electronAPI = {
      metadata: { addTags: vi.fn(() => write.promise) },
    };
    const { result } = renderHook(() =>
      useMetadataActions({
        selectedFingerprints: ["fp1"],
        setVideos,
        setAvailableTags,
        notify,
        ownershipKey: "owner-a",
      })
    );

    let pending;
    act(() => {
      pending = result.current.handleAddTags(["late"], ["fp1"], {
        completionGuard: () => sessionIsCurrent,
      });
    });
    sessionIsCurrent = false;
    let mutationResult;
    await act(async () => {
      write.resolve({
        updates: { fp1: { tags: ["late"] } },
        tags: ["late"],
      });
      mutationResult = await pending;
    });

    expect(mutationResult).toMatchObject({ success: true, stale: true });
    expect(videos[0].tags).toEqual([]);
    expect(setAvailableTags).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("drops every delayed metadata response after collection ownership changes", async () => {
    const writes = {
      add: deferredPromise(),
      remove: deferredPromise(),
      rating: deferredPromise(),
      review: deferredPromise(),
      restore: deferredPromise(),
      list: deferredPromise(),
    };
    let videos = [
      {
        id: "1",
        fingerprint: "fp1",
        rating: null,
        reviewState: "unreviewed",
        tags: [],
        dimensions: null,
      },
    ];
    const setVideos = (updater) => {
      videos = typeof updater === "function" ? updater(videos) : updater;
    };
    const setAvailableTags = vi.fn();
    const notify = vi.fn();
    window.electronAPI = {
      metadata: {
        addTags: vi.fn(() => writes.add.promise),
        removeTag: vi.fn(() => writes.remove.promise),
        setRating: vi.fn(() => writes.rating.promise),
        setReviewState: vi.fn(() => writes.review.promise),
        restoreReview: vi.fn(() => writes.restore.promise),
        listTags: vi.fn(() => writes.list.promise),
      },
    };
    const { result, rerender } = renderHook(
      ({ ownershipKey }) =>
        useMetadataActions({
          selectedFingerprints: ["fp1"],
          setVideos,
          setAvailableTags,
          notify,
          ownershipKey,
        }),
      { initialProps: { ownershipKey: "owner-a" } }
    );

    let pending;
    act(() => {
      pending = [
        result.current.handleAddTags(["late"], ["fp1"]),
        result.current.handleRemoveTag("old", ["fp1"]),
        result.current.handleSetRating(5, ["fp1"]),
        result.current.handleSetReviewState("pick", ["fp1"]),
        result.current.handleRestoreReviewMetadata([
          { fingerprint: "fp1", reviewState: "reviewed", rating: 3 },
        ]),
        result.current.refreshTagList(),
      ];
    });
    rerender({ ownershipKey: "owner-b" });

    const update = {
      updates: {
        fp1: { reviewState: "pick", rating: 5, tags: ["late"] },
      },
      tags: ["late"],
    };
    let results;
    await act(async () => {
      writes.add.resolve(update);
      writes.remove.resolve(update);
      writes.rating.resolve(update);
      writes.review.resolve(update);
      writes.restore.resolve(update);
      writes.list.resolve({ tags: ["late"] });
      results = await Promise.all(pending);
    });

    for (const mutationResult of results.slice(0, 5)) {
      expect(mutationResult).toMatchObject({ success: true, stale: true });
    }
    expect(videos[0]).toMatchObject({
      reviewState: "unreviewed",
      rating: null,
      tags: [],
    });
    expect(setAvailableTags).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("sets normalized review state via electron API", async () => {
    let videos = [
      {
        id: "1",
        fingerprint: "fp1",
        rating: null,
        tags: [],
        reviewState: "unreviewed",
        dimensions: null,
      },
    ];
    const setVideos = (updater) => {
      videos = typeof updater === "function" ? updater(videos) : updater;
    };
    const notify = vi.fn();
    window.electronAPI = {
      metadata: {
        setReviewState: vi.fn().mockResolvedValue({
          updates: { fp1: { reviewState: "pick" } },
        }),
      },
    };

    const { result } = renderHook(() =>
      useMetadataActions({
        selectedFingerprints: ["fp1"],
        setVideos,
        setAvailableTags: noop,
        notify,
      })
    );

    let mutationResult;
    await act(async () => {
      mutationResult = await result.current.handleSetReviewState(" PICK ");
    });

    expect(window.electronAPI.metadata.setReviewState).toHaveBeenCalledWith(
      ["fp1"],
      "pick"
    );
    expect(videos[0].reviewState).toBe("pick");
    expect(notify).toHaveBeenCalledWith("Marked 1 item(s) accept", "success");
    expect(mutationResult).toMatchObject({ success: true });
  });

  it("returns a failed result so workflow navigation does not advance", async () => {
    const notify = vi.fn();
    window.electronAPI = {
      metadata: {
        setRating: vi.fn().mockResolvedValue({ error: "profile changed" }),
      },
    };
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() =>
      useMetadataActions({
        selectedFingerprints: ["fp1"],
        setVideos: noop,
        setAvailableTags: noop,
        notify,
      })
    );

    let mutationResult;
    await act(async () => {
      mutationResult = await result.current.handleSetRating(4);
    });

    expect(mutationResult.success).toBe(false);
    expect(notify).toHaveBeenCalledWith("Failed to update rating", "error");
    consoleSpy.mockRestore();
  });

  it("supports quiet workflow restoration without suppressing the metadata patch", async () => {
    let videos = [
      { id: "1", fingerprint: "fp1", rating: null, reviewState: "reject" },
    ];
    const setVideos = (updater) => {
      videos = typeof updater === "function" ? updater(videos) : updater;
    };
    const notify = vi.fn();
    window.electronAPI = {
      metadata: {
        setReviewState: vi.fn().mockResolvedValue({
          updates: { fp1: { reviewState: "reviewed", rating: 4 } },
        }),
        setRating: vi.fn().mockResolvedValue({
          updates: { fp1: { reviewState: "reviewed", rating: 4 } },
        }),
      },
    };
    const { result } = renderHook(() =>
      useMetadataActions({
        selectedFingerprints: ["fp1"],
        setVideos,
        setAvailableTags: noop,
        notify,
      })
    );

    await act(async () => {
      await result.current.handleSetReviewState("reviewed", ["fp1"], { quiet: true });
      await result.current.handleSetRating(4, ["fp1"], { quiet: true });
    });

    expect(videos[0]).toMatchObject({ reviewState: "reviewed", rating: 4 });
    expect(notify).not.toHaveBeenCalled();
  });

  it("restores review metadata atomically and never forwards tags", async () => {
    let videos = [
      {
        id: "1",
        fingerprint: "fp1",
        rating: null,
        reviewState: "reject",
        tags: ["keep-me"],
      },
    ];
    const setVideos = (updater) => {
      videos = typeof updater === "function" ? updater(videos) : updater;
    };
    const notify = vi.fn();
    window.electronAPI = {
      metadata: {
        restoreReview: vi.fn().mockResolvedValue({
          updates: { fp1: { reviewState: "reviewed", rating: 4 } },
        }),
      },
    };
    const { result } = renderHook(() =>
      useMetadataActions({
        selectedFingerprints: ["fp1"],
        setVideos,
        setAvailableTags: noop,
        notify,
      })
    );

    let restoreResult;
    await act(async () => {
      restoreResult = await result.current.handleRestoreReviewMetadata([
        {
          fingerprint: "fp1",
          reviewState: "reviewed",
          rating: 4,
          tags: ["must-not-cross-the-boundary"],
        },
      ]);
    });

    expect(window.electronAPI.metadata.restoreReview).toHaveBeenCalledWith([
      { fingerprint: "fp1", reviewState: "reviewed", rating: 4 },
    ]);
    expect(restoreResult).toMatchObject({ success: true });
    expect(videos[0]).toMatchObject({
      reviewState: "reviewed",
      rating: 4,
      tags: ["keep-me"],
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("returns a structured failure when atomic review restore fails", async () => {
    const notify = vi.fn();
    window.electronAPI = {
      metadata: {
        restoreReview: vi.fn().mockResolvedValue({ error: "profile changed" }),
      },
    };
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() =>
      useMetadataActions({
        selectedFingerprints: ["fp1"],
        setVideos: noop,
        setAvailableTags: noop,
        notify,
      })
    );

    let restoreResult;
    await act(async () => {
      restoreResult = await result.current.handleRestoreReviewMetadata([
        { fingerprint: "fp1", reviewState: "reviewed", rating: 4 },
      ]);
    });

    expect(restoreResult.success).toBe(false);
    expect(notify).toHaveBeenCalledWith("Failed to undo review change", "error");
    consoleSpy.mockRestore();
  });
});
