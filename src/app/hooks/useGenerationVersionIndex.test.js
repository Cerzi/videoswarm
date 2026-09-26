import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import useGenerationVersionIndex, {
  GENERATION_INDEX_SETTLE_MS,
  applyGenerationKeyUpdates,
  collectPendingGenerationKeys,
} from "./useGenerationVersionIndex";

const KEY_A = `gk1-${"a".repeat(32)}`;

const clip = (id, fingerprint, extra = {}) => ({
  id: `/library/${id}.mp4`,
  instanceId: id,
  fingerprint,
  ...extra,
});

function installApi() {
  let listener = null;
  let nextJob = 1;
  const api = {
    index: vi.fn(async () => ({ success: true, jobId: `gk-${nextJob++}`, scope: "collection", pending: 2 })),
    cancel: vi.fn(async () => ({ success: true })),
    onProgress: vi.fn((callback) => {
      listener = callback;
      return () => {
        listener = null;
      };
    }),
  };
  window.electronAPI = { generationVersions: api };
  return { api, emit: (payload) => listener?.(payload) };
}

function renderIndex(initialVideos, props = {}) {
  return renderHook(
    ({ collectionKey, busy }) => {
      const [videos, setVideos] = useState(initialVideos);
      const index = useGenerationVersionIndex({ videos, setVideos, collectionKey, busy });
      return { videos, setVideos, ...index };
    },
    { initialProps: { collectionKey: "root:/library", busy: false, ...props } }
  );
}

async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(GENERATION_INDEX_SETTLE_MS + 1);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("generation key helpers", () => {
  it("collects one instance per unevaluated content and skips attempts", () => {
    const videos = [
      clip(1, "fa"),
      clip(2, "fa"),
      clip(3, "fb", { generationKeyChecked: true }),
      clip(4, "fc"),
      { id: "web", fingerprint: "fw" },
    ];
    expect(collectPendingGenerationKeys(videos, new Set())).toEqual({
      instanceIds: [1, 4],
      fingerprints: ["fa", "fc"],
      pendingCount: 2,
    });
    expect(collectPendingGenerationKeys(videos, new Set(["fa"])).instanceIds).toEqual([4]);
    expect(collectPendingGenerationKeys(videos, new Set(), 1).instanceIds).toEqual([1]);
  });

  it("applies only checked updates and keeps identity when nothing changes", () => {
    const videos = [clip(1, "fa"), clip(2, "fb")];
    const next = applyGenerationKeyUpdates(videos, [
      { fingerprint: "fa", generationKey: KEY_A, checked: true },
      { fingerprint: "fb", generationKey: null, checked: false },
    ]);
    expect(next[0]).toMatchObject({ generationKey: KEY_A, generationKeyChecked: true });
    expect(next[1]).toBe(videos[1]);
    expect(applyGenerationKeyUpdates(next, [{ fingerprint: "fa", generationKey: KEY_A, checked: true }])).toBe(next);
    expect(applyGenerationKeyUpdates(videos, [{ fingerprint: "zz", checked: true }])).toBe(videos);
  });
});

describe("useGenerationVersionIndex", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.electronAPI;
  });

  it("requests pending content once the collection settles and applies results", async () => {
    const { api, emit } = installApi();
    const { result } = renderIndex([clip(1, "fa"), clip(2, "fb")]);
    expect(result.current.pendingCount).toBe(2);
    expect(api.index).not.toHaveBeenCalled();

    await settle();
    expect(api.index).toHaveBeenCalledWith({ instanceIds: [1, 2] });
    expect(result.current.status).toMatchObject({ running: true, total: 2 });

    act(() =>
      emit({
        jobId: "gk-1",
        scope: "collection",
        processed: 2,
        total: 2,
        done: true,
        updates: [
          { fingerprint: "fa", generationKey: KEY_A, checked: true },
          { fingerprint: "fb", generationKey: null, checked: false },
        ],
      })
    );
    expect(result.current.videos[0]).toMatchObject({ generationKey: KEY_A, generationKeyChecked: true });
    expect(result.current.pendingCount).toBe(1);
    expect(result.current.status).toMatchObject({ running: false, processed: 2 });

    // The transient miss was attempted for this collection and is not retried.
    await settle();
    expect(api.index).toHaveBeenCalledTimes(1);
  });

  it("ignores events from other jobs and replays an event that beat its reply", async () => {
    const { api, emit } = installApi();
    let resolveIndex;
    api.index.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveIndex = resolve;
        })
    );
    const { result } = renderIndex([clip(1, "fa")]);
    await settle();
    act(() => {
      emit({ jobId: "gk-9", updates: [{ fingerprint: "fa", generationKey: KEY_A, checked: true }] });
      emit({ jobId: "gk-1", done: true, processed: 1, total: 1, updates: [{ fingerprint: "fa", generationKey: KEY_A, checked: true }] });
    });
    expect(result.current.videos[0].generationKeyChecked).toBeUndefined();
    await act(async () => {
      resolveIndex({ success: true, jobId: "gk-1", scope: "collection", pending: 1 });
      await Promise.resolve();
    });
    expect(result.current.videos[0]).toMatchObject({ generationKey: KEY_A });
  });

  it("waits while a scan is running and cancels when the collection changes", async () => {
    const { api } = installApi();
    const { rerender } = renderIndex([clip(1, "fa")], { busy: true });
    await settle();
    expect(api.index).not.toHaveBeenCalled();

    rerender({ collectionKey: "root:/library", busy: false });
    await settle();
    expect(api.index).toHaveBeenCalledTimes(1);

    rerender({ collectionKey: "root:/other", busy: false });
    expect(api.cancel).toHaveBeenCalled();
  });

  it("does nothing without a collection or bridge", async () => {
    const { result } = renderIndex([clip(1, "fa")], { collectionKey: null });
    await settle();
    expect(result.current.status).toBeNull();
  });

  it("starts a library-wide job on request", async () => {
    const { api } = installApi();
    const { result } = renderIndex([], {});
    await act(async () => {
      await result.current.indexLibrary();
    });
    expect(api.index).toHaveBeenCalledWith({ library: true });
  });
});
