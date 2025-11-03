import React, { useState } from "react";
import { renderHook, act } from "@testing-library/react";
import { useZoomControls } from "./useZoomControls";

describe("useZoomControls", () => {
  const originalInnerWidth = window.innerWidth;
  const originalInnerHeight = window.innerHeight;
  let warnSpy;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    window.innerWidth = 3000;
    window.innerHeight = 2000;
    window.electronAPI = {
      saveSettingsPartial: vi.fn(),
      isElectron: false,
    };
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete window.electronAPI;
    window.innerWidth = originalInnerWidth;
    window.innerHeight = originalInnerHeight;
  });

  it("clamps zoom changes to minimum and persists settings", () => {
    const setZoomClass = vi.fn();
    const scheduleLayout = vi.fn();
    const runWithStableAnchor = vi.fn((_, fn) => fn());
    const withLayoutHold = vi.fn((fn) => fn());

    const { result } = renderHook(() => {
      const [zoomLevel, setZoomLevel] = useState(0);
      const controls = useZoomControls({
        zoomLevel,
        setZoomLevel,
        orderedVideoCount: 220,
        recursiveMode: false,
        renderLimitStep: 8,
        showFilenames: true,
        setZoomClass,
        scheduleLayout,
        runWithStableAnchor,
        withLayoutHold,
        zoomAnchorOptions: {},
      });
      return { zoomLevel, ...controls };
    });

    act(() => {
      result.current.handleZoomChangeSafe(0);
    });

    expect(result.current.zoomLevel).toBe(2);
    expect(window.electronAPI.saveSettingsPartial).toHaveBeenCalledWith({
      zoomLevel: 2,
      recursiveMode: false,
      renderLimitStep: 8,
      showFilenames: true,
    });
    expect(setZoomClass).toHaveBeenCalledWith(2);
    expect(scheduleLayout).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("applies zoom from settings without persisting", () => {
    const setZoomClass = vi.fn();
    const scheduleLayout = vi.fn();

    const { result } = renderHook(() => {
      const [zoomLevel, setZoomLevel] = useState(1);
      const controls = useZoomControls({
        zoomLevel,
        setZoomLevel,
        orderedVideoCount: 10,
        recursiveMode: false,
        renderLimitStep: 4,
        showFilenames: true,
        setZoomClass,
        scheduleLayout,
        runWithStableAnchor: (_, fn) => fn(),
        withLayoutHold: (fn) => fn(),
        zoomAnchorOptions: {},
      });
      return { zoomLevel, ...controls };
    });

    act(() => {
      result.current.applyZoomFromSettings(4);
    });

    expect(result.current.zoomLevel).toBe(4);
    expect(window.electronAPI.saveSettingsPartial).not.toHaveBeenCalled();
    expect(setZoomClass).toHaveBeenLastCalledWith(4);
    expect(scheduleLayout).toHaveBeenCalled();
  });
});
