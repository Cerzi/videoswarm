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

    await act(async () => {
      await result.current.handleSetReviewState(" PICK ");
    });

    expect(window.electronAPI.metadata.setReviewState).toHaveBeenCalledWith(
      ["fp1"],
      "pick"
    );
    expect(videos[0].reviewState).toBe("pick");
    expect(notify).toHaveBeenCalledWith("Marked 1 item(s) pick", "success");
  });
});
