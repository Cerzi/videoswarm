import { renderHook } from "@testing-library/react";
import {
  createDefaultFilters,
  formatMegapixelLabel,
  sanitizeMegapixels,
  videoMegapixels,
  normalizeTagList,
  sanitizeMinRating,
  sanitizeExactRating,
  formatStars,
  formatRatingLabel,
  useFiltersActiveCount,
} from "./filtersUtils";

describe("filtersUtils", () => {
  it("creates default filters", () => {
    expect(createDefaultFilters()).toEqual({
      includeTags: [],
      excludeTags: [],
      minRating: null,
      exactRating: null,
      reviewFilter: "any",
      includeTagsMode: "all",
      minMegapixels: null,
      maxMegapixels: null,
    });
  });

  it("normalizes tags", () => {
    expect(
      normalizeTagList(["  a  ", "B", "a", null, undefined, "b", ""]) // duplicates/spacing
    ).toEqual(["B", "a", "b"].sort((a, b) => a.localeCompare(b)));
  });

  it("sanitizes rating bounds", () => {
    expect(sanitizeMinRating(0)).toBe(1);
    expect(sanitizeExactRating(6)).toBe(5);
    expect(sanitizeExactRating("3")).toBe(3);
    expect(sanitizeExactRating("bad")).toBeNull();
  });

  it("formats stars", () => {
    expect(formatStars(3)).toBe("★★★☆☆");
    expect(formatStars(null)).toBe("☆☆☆☆☆");
  });

  it("formats rating labels", () => {
    expect(formatRatingLabel(4, "min")).toContain("≥");
    expect(formatRatingLabel(2, "exact")).toContain("=");
    expect(formatRatingLabel(null, "exact")).toBeNull();
  });

  it("counts active filters", () => {
    const filters = {
      includeTags: ["a"],
      excludeTags: [],
      minRating: 4,
      exactRating: null,
      reviewFilter: "pick",
    };
    const { result, rerender } = renderHook(({ value }) =>
      useFiltersActiveCount(value)
    , {
      initialProps: { value: filters },
    });
    expect(result.current).toBe(3);

    rerender({ value: { ...filters, minRating: null, exactRating: 5 } });
    expect(result.current).toBe(3);
  });

  describe("resolution", () => {
    it("reads megapixels from either dimension shape", () => {
      expect(videoMegapixels({ dimensions: { width: 1000, height: 1000 } })).toBe(1);
      expect(videoMegapixels({ width: 2000, height: 1000 })).toBe(2);
    });

    it("reports unmeasured or degenerate clips as unknown", () => {
      expect(videoMegapixels({})).toBeNull();
      expect(videoMegapixels({ dimensions: { width: 0, height: 1080 } })).toBeNull();
      expect(videoMegapixels({ width: "wide", height: 1080 })).toBeNull();
    });

    it("sanitizes a bound and rejects nonsense", () => {
      expect(sanitizeMegapixels(1.5)).toBe(1.5);
      expect(sanitizeMegapixels("2")).toBe(2);
      expect(sanitizeMegapixels(0)).toBeNull();
      expect(sanitizeMegapixels(-1)).toBeNull();
      expect(sanitizeMegapixels("nope")).toBeNull();
      expect(sanitizeMegapixels(99_999)).toBe(1000);
    });

    it("labels a bound in the direction it applies", () => {
      expect(formatMegapixelLabel(1, "max")).toBe("\u2264 1 MP");
      expect(formatMegapixelLabel(2, "min")).toBe("\u2265 2 MP");
      expect(formatMegapixelLabel(null, "max")).toBeNull();
    });
  });
});
