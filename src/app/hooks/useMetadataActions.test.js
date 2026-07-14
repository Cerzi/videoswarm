import { renderHook, act } from "@testing-library/react";
import { useMetadataActions } from "./useMetadataActions";

const noop = () => {};

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
