import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useRenderCap } from "./useRenderCap";

describe("useRenderCap", () => {
  beforeEach(() => {
    window.electronAPI = {
      getSettings: vi.fn().mockResolvedValue({ renderCap: 300 }),
      saveSettingsPartial: vi.fn().mockResolvedValue({ success: true }),
    };
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it("uses the persisted cap when within dataset bounds", async () => {
    const { result } = renderHook(({ count }) => useRenderCap({ datasetCount: count }), {
      initialProps: { count: 500 },
    });

    await waitFor(() => expect(result.current.cap).toBe(300));
    expect(result.current.clampedCap).toBe(300);
    expect(result.current.max).toBe(500);
  });

  it("clamps the effective cap to the dataset size when cap exceeds it", async () => {
    const { result, rerender } = renderHook(
      ({ count }) => useRenderCap({ datasetCount: count }),
      {
        initialProps: { count: 500 },
      }
    );

    await waitFor(() => expect(result.current.cap).toBe(300));

    rerender({ count: 200 });
    expect(result.current.cap).toBe(300);
    expect(result.current.clampedCap).toBe(200);
    expect(result.current.max).toBe(200);
  });

  it("honors the minimum cap while reporting the effective dataset size", async () => {
    window.electronAPI.getSettings.mockResolvedValueOnce({ renderCap: 100 });

    const { result } = renderHook(() => useRenderCap({ datasetCount: 50 }));
    await waitFor(() => expect(result.current.cap).toBe(100));

    expect(result.current.max).toBe(100);
    expect(result.current.clampedCap).toBe(50);
  });

  it("reclamps automatically when the dataset shrinks", async () => {
    window.electronAPI.getSettings.mockResolvedValueOnce({ renderCap: 800 });

    const { result, rerender } = renderHook(
      ({ count }) => useRenderCap({ datasetCount: count }),
      {
        initialProps: { count: 1000 },
      }
    );

    await waitFor(() => expect(result.current.cap).toBe(800));
    expect(result.current.clampedCap).toBe(800);

    rerender({ count: 400 });
    expect(result.current.cap).toBe(800);
    expect(result.current.clampedCap).toBe(400);
    expect(result.current.max).toBe(400);
  });

  it("persists changes to the cap", async () => {
    const { result } = renderHook(() => useRenderCap({ datasetCount: 600 }));
    await waitFor(() => expect(result.current.cap).toBe(300));

    act(() => {
      result.current.setCap(450);
    });

    await waitFor(() =>
      expect(window.electronAPI.saveSettingsPartial).toHaveBeenCalledWith({
        renderCap: 450,
      })
    );
    expect(result.current.cap).toBe(450);
    expect(result.current.clampedCap).toBe(450);
  });
});
