import { act, renderHook, waitFor } from "@testing-library/react";
import { useGenerationMetadata } from "./useGenerationMetadata";

describe("useGenerationMetadata", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete window.electronAPI;
  });

  it("loads one instance on demand without retaining previous results", async () => {
    window.electronAPI = {
      metadata: {
        getGeneration: vi
          .fn()
          .mockResolvedValueOnce({
            success: true,
            found: true,
            cached: false,
            metadata: { prompt: "a bee", seed: "9007199254740993" },
          })
          .mockResolvedValueOnce({ success: true, found: false, metadata: null }),
      },
    };
    const { result, rerender } = renderHook(
      ({ instanceId }) => useGenerationMetadata({ instanceId, enabled: true }),
      { initialProps: { instanceId: 1 } }
    );
    await waitFor(() => expect(result.current.metadata?.prompt).toBe("a bee"));

    rerender({ instanceId: 2 });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.metadata).toBeNull();
    expect(window.electronAPI.metadata.getGeneration).toHaveBeenCalledTimes(2);
  });

  it("does not call native parsing while disabled", () => {
    window.electronAPI = { metadata: { getGeneration: vi.fn() } };
    const { result } = renderHook(() =>
      useGenerationMetadata({ instanceId: 1, enabled: false })
    );
    expect(result.current).toMatchObject({ loading: false, metadata: null });
    expect(window.electronAPI.metadata.getGeneration).not.toHaveBeenCalled();
  });

  it("debounces rapid selection changes and parses only the settled instance", async () => {
    vi.useFakeTimers();
    window.electronAPI = {
      metadata: {
        getGeneration: vi.fn().mockResolvedValue({
          success: true,
          found: false,
          metadata: null,
        }),
      },
    };
    const { rerender } = renderHook(
      ({ instanceId }) =>
        useGenerationMetadata({ instanceId, enabled: true, debounceMs: 50 }),
      { initialProps: { instanceId: 1 } }
    );

    rerender({ instanceId: 2 });
    rerender({ instanceId: 3 });
    expect(window.electronAPI.metadata.getGeneration).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(window.electronAPI.metadata.getGeneration).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.metadata.getGeneration).toHaveBeenCalledWith(
      3,
      expect.any(String)
    );
  });

  it("cancels an in-flight native parse when selection changes", async () => {
    vi.useFakeTimers();
    let resolveFirst;
    window.electronAPI = {
      metadata: {
        getGeneration: vi
          .fn()
          .mockReturnValueOnce(
            new Promise((resolve) => {
              resolveFirst = resolve;
            })
          )
          .mockResolvedValue({ success: true, found: false, metadata: null }),
        cancelGeneration: vi.fn().mockResolvedValue({
          success: true,
          cancelled: true,
        }),
      },
    };
    const { rerender } = renderHook(
      ({ instanceId }) =>
        useGenerationMetadata({ instanceId, enabled: true, debounceMs: 0 }),
      { initialProps: { instanceId: 1 } }
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const firstToken = window.electronAPI.metadata.getGeneration.mock.calls[0][1];

    rerender({ instanceId: 2 });
    expect(window.electronAPI.metadata.cancelGeneration).toHaveBeenCalledWith(
      firstToken
    );
    await act(async () => {
      resolveFirst({ success: false, code: "SIDECAR_CANCELLED" });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(window.electronAPI.metadata.getGeneration).toHaveBeenCalledTimes(2);
    expect(window.electronAPI.metadata.getGeneration.mock.calls[1][0]).toBe(2);
  });

  it("preserves source/provenance state and forces a real re-read", async () => {
    const getGeneration = vi.fn().mockResolvedValue({
      success: true,
      found: true,
      cached: true,
      status: "found",
      sourceKind: "embedded",
      sourceLabel: "Embedded · Comment",
      quality: "partial",
      readerAvailable: true,
      diagnostics: [{ code: "UNKNOWN_NODE_ON_PROMPT_PATH" }],
      metadata: { prompt: "a moth" },
    });
    window.electronAPI = { metadata: { getGeneration } };

    const { result } = renderHook(() =>
      useGenerationMetadata({ instanceId: 9, enabled: true, debounceMs: 0 })
    );
    await waitFor(() => expect(result.current.metadata?.prompt).toBe("a moth"));
    expect(result.current).toMatchObject({
      status: "found",
      sourceKind: "embedded",
      sourceLabel: "Embedded · Comment",
      quality: "partial",
      readerAvailable: true,
    });

    await act(async () => {
      await result.current.refresh();
    });
    expect(getGeneration).toHaveBeenLastCalledWith(
      9,
      expect.any(String),
      { force: true }
    );
  });

  it("keeps the native error code for actionable failure states", async () => {
    window.electronAPI = {
      metadata: {
        getGeneration: vi.fn().mockResolvedValue({
          success: false,
          code: "GENERATION_QUEUE_FULL",
          error: "Generation metadata queue is full",
        }),
      },
    };
    const { result } = renderHook(() =>
      useGenerationMetadata({ instanceId: 5, enabled: true, debounceMs: 0 })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({
      status: "error",
      errorCode: "GENERATION_QUEUE_FULL",
      error: "Generation metadata queue is full",
    });
  });
});
