import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import useTrashIntegration from "./useTrashIntegration";
import useSelectionState from "../selection/useSelectionState";

function createStateHarness(initialValue) {
  let current = initialValue;
  const setter = (update) => {
    current = typeof update === "function" ? update(current) : update;
    return current;
  };
  return {
    get: () => current,
    set: setter,
  };
}

describe("useTrashIntegration", () => {
  it("prunes removed ids from selection while retaining survivors", () => {
    const videos = createStateHarness([
      { id: "keep" },
      { id: "trash" },
    ]);
    const selected = createStateHarness(new Set(["keep", "trash"]));
    const loaded = createStateHarness(new Set(["keep", "trash"]));
    const playing = createStateHarness(new Set(["keep"]));
    const visible = createStateHarness(new Set(["keep", "trash"]));
    const loading = createStateHarness(new Set(["trash"]));

    const { result } = renderHook(() =>
      useTrashIntegration({
        electronAPI: undefined,
        notify: () => {},
        confirm: () => true,
        releaseVideoHandlesForAsync: () => Promise.resolve(),
        setVideos: videos.set,
        setSelected: selected.set,
        setLoadedIds: loaded.set,
        setPlayingIds: playing.set,
        setVisibleIds: visible.set,
        setLoadingIds: loading.set,
      })
    );

    act(() => {
      result.current.onItemsRemoved(new Set(["trash"]));
    });

    expect(videos.get()).toEqual([{ id: "keep" }]);
    expect(Array.from(selected.get())).toEqual(["keep"]);
    expect(Array.from(loaded.get())).toEqual(["keep"]);
    expect(Array.from(playing.get())).toEqual(["keep"]);
    expect(Array.from(visible.get())).toEqual(["keep"]);
    expect(Array.from(loading.get())).toEqual([]);
  });

  it("syncs with useSelectionState selections", () => {
    const { result: selection } = renderHook(() => useSelectionState());
    const videos = createStateHarness([
      { id: "keep" },
      { id: "trash" },
    ]);

    act(() => {
      selection.current.setSelected(() => new Set(["keep", "trash"]));
    });

    const { result: integration } = renderHook(() =>
      useTrashIntegration({
        electronAPI: undefined,
        notify: () => {},
        confirm: () => true,
        releaseVideoHandlesForAsync: () => Promise.resolve(),
        setVideos: videos.set,
        setSelected: selection.current.setSelected,
        setLoadedIds: () => {},
        setPlayingIds: () => {},
        setVisibleIds: () => {},
        setLoadingIds: () => {},
      })
    );

    act(() => {
      integration.current.onItemsRemoved(new Set(["trash"]));
    });

    expect(Array.from(selection.current.selected)).toEqual(["keep"]);
    expect(selection.current.size).toBe(1);
    expect(videos.get()).toEqual([{ id: "keep" }]);
  });
});
