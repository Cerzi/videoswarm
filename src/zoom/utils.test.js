import { createRequire } from "module";
import { describe, expect, it } from "vitest";
import { ZOOM_LEVEL_STEP, ZOOM_LEVELS, ZOOM_MAX_INDEX, ZOOM_MIN_INDEX } from "./config";
import {
  calculateSafeZoom,
  clampZoomIndex,
  getTileWidthForZoomLevel,
  zoomClassForLevel,
} from "./utils";

const mainZoom = createRequire(import.meta.url)("../../main/zoom-settings.js");

describe("zoom levels", () => {
  it("keeps historic integer and half-step widths", () => {
    expect(getTileWidthForZoomLevel(0)).toBe(150);
    expect(getTileWidthForZoomLevel(1)).toBe(200);
    expect(getTileWidthForZoomLevel(4)).toBe(650);
    expect(getTileWidthForZoomLevel(0.5)).toBe(175);
    expect(getTileWidthForZoomLevel(1.5)).toBe(250);
    expect(getTileWidthForZoomLevel(3.5)).toBe(525);
  });

  it("goes on past the historic largest size in quarter steps", () => {
    expect(ZOOM_LEVEL_STEP).toBe(0.25);
    expect(ZOOM_MAX_INDEX).toBe(8);
    expect(getTileWidthForZoomLevel(4.25)).toBe(700);
    expect(getTileWidthForZoomLevel(5)).toBe(850);
    expect(getTileWidthForZoomLevel(8)).toBe(1900);
    expect(ZOOM_LEVELS).toHaveLength(33);
    // From the historic largest size up, each step is a similar ratio.
    const widths = ZOOM_LEVELS.filter((level) => level >= 4).map(getTileWidthForZoomLevel);
    for (let index = 1; index < widths.length; index += 1) {
      const ratio = widths[index] / widths[index - 1];
      expect(ratio).toBeGreaterThan(1.05);
      expect(ratio).toBeLessThan(1.1);
    }
  });

  it("normalizes arbitrary input to a supported level", () => {
    expect(clampZoomIndex(1.12)).toBe(1);
    expect(clampZoomIndex(1.13)).toBe(1.25);
    expect(clampZoomIndex(-10)).toBe(0);
    expect(clampZoomIndex(20)).toBe(8);
    expect(clampZoomIndex("invalid")).toBe(1);
    expect(zoomClassForLevel(1.5)).toBe("zoom-large");
    expect(zoomClassForLevel(4)).toBe("zoom-xxlarge");
    expect(zoomClassForLevel(7.5)).toBe("zoom-xxlarge");
  });

  it("lets the safety estimator choose an intermediate level", () => {
    expect(calculateSafeZoom(6000, 1000, 1000)).toBe(0.25);
  });

  it("matches the range and step that saved settings keep", () => {
    expect(mainZoom.ZOOM_MIN_LEVEL).toBe(ZOOM_MIN_INDEX);
    expect(mainZoom.ZOOM_MAX_LEVEL).toBe(ZOOM_MAX_INDEX);
    expect(mainZoom.ZOOM_LEVEL_STEP).toBe(ZOOM_LEVEL_STEP);
  });
});
