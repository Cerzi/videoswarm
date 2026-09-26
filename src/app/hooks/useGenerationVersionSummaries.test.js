import { act, renderHook } from "@testing-library/react";
import useGenerationVersionSummaries, {
  GENERATION_SUMMARY_DEBOUNCE_MS,
} from "./useGenerationVersionSummaries";

const key = (n) => `gk1-${n.toString(16).padStart(32, "0")}`;

async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(GENERATION_SUMMARY_DEBOUNCE_MS + 1);
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

describe("useGenerationVersionSummaries", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    delete window.electronAPI;
  });

  it("reads summaries for the collection's keys and refetches only when they change", async () => {
    const summaries = vi.fn(async (keys) => ({
      success: true,
      summaries: Object.fromEntries(keys.map((k) => [k, { versionCount: 2, maxPixels: 100 }])),
    }));
    window.electronAPI = { generationVersions: { summaries } };
    const first = [{ id: "a", generationKey: key(1) }, { id: "b", generationKey: key(1) }, { id: "c" }];
    const { result, rerender } = renderHook(({ videos }) => useGenerationVersionSummaries(videos), {
      initialProps: { videos: first },
    });
    await settle();
    expect(summaries).toHaveBeenCalledWith([key(1)]);
    expect(result.current.summaries).toEqual({ [key(1)]: { versionCount: 2, maxPixels: 100 } });

    rerender({ videos: first.map((video) => ({ ...video, tags: ["x"] })) });
    await settle();
    expect(summaries).toHaveBeenCalledTimes(1);

    act(() => result.current.refresh());
    await settle();
    expect(summaries).toHaveBeenCalledTimes(2);
  });

  it("chunks large key sets", async () => {
    const summaries = vi.fn(async () => ({ success: true, summaries: {} }));
    window.electronAPI = { generationVersions: { summaries } };
    const videos = Array.from({ length: 4097 }, (_, n) => ({ id: `v${n}`, generationKey: key(n) }));
    renderHook(() => useGenerationVersionSummaries(videos));
    await settle();
    expect(summaries.mock.calls.map(([keys]) => keys.length)).toEqual([4096, 1]);
  });
});
