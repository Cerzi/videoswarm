import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { normalizeZoomLevel } = require("../zoom-settings");

describe("profile zoom settings", () => {
  it("preserves historic levels and keeps the larger ones and quarter steps", () => {
    expect(normalizeZoomLevel(0)).toBe(0);
    expect(normalizeZoomLevel(1)).toBe(1);
    expect(normalizeZoomLevel(1.5)).toBe(1.5);
    expect(normalizeZoomLevel(4)).toBe(4);
    expect(normalizeZoomLevel(4.75)).toBe(4.75);
    expect(normalizeZoomLevel(8)).toBe(8);
  });

  it("rounds arbitrary values to a bounded supported step", () => {
    expect(normalizeZoomLevel(1.12)).toBe(1);
    expect(normalizeZoomLevel(1.13)).toBe(1.25);
    expect(normalizeZoomLevel(-20)).toBe(0);
    expect(normalizeZoomLevel(20)).toBe(8);
    expect(normalizeZoomLevel("invalid", 2)).toBe(2);
  });
});
