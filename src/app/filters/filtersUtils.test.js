import { renderHook } from "@testing-library/react";
import {
  createDefaultFilters,
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
    };
    const { result, rerender } = renderHook(({ value }) =>
      useFiltersActiveCount(value)
    , {
      initialProps: { value: filters },
    });
    expect(result.current).toBe(2);

    rerender({ value: { ...filters, minRating: null, exactRating: 5 } });
    expect(result.current).toBe(2);
  });
});
