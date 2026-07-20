import { describe, expect, it } from "vitest";
import {
  calculateSafeZoom,
  clampZoomIndex,
  getTileWidthForZoomLevel,
  zoomClassForLevel,
} from "./utils";

describe("zoom levels", () => {
  it("keeps historic integer widths and interpolates bounded half steps", () => {
    expect(getTileWidthForZoomLevel(0)).toBe(150);
    expect(getTileWidthForZoomLevel(1)).toBe(200);
    expect(getTileWidthForZoomLevel(4)).toBe(650);
    expect(getTileWidthForZoomLevel(0.5)).toBe(175);
    expect(getTileWidthForZoomLevel(1.5)).toBe(250);
    expect(getTileWidthForZoomLevel(3.5)).toBe(525);
  });

  it("normalizes arbitrary input to a supported level", () => {
    expect(clampZoomIndex(1.24)).toBe(1);
    expect(clampZoomIndex(1.26)).toBe(1.5);
    expect(clampZoomIndex(-10)).toBe(0);
    expect(clampZoomIndex(10)).toBe(4);
    expect(clampZoomIndex("invalid")).toBe(1);
    expect(zoomClassForLevel(1.5)).toBe("zoom-large");
  });

  it("lets the safety estimator choose an intermediate level", () => {
    expect(calculateSafeZoom(6000, 1000, 1000)).toBe(0.5);
  });
});
