import { describe, expect, it } from "vitest";
import {
  hasLibrarySearchCriteria,
  librarySearchCriteria,
  librarySearchKey,
} from "./librarySearch";

describe("library search criteria", () => {
  it("is tags, a rating, or both", () => {
    expect(librarySearchCriteria({ includeTags: [" keeper "], includeTagsMode: "any" })).toEqual({
      tags: ["keeper"],
      matchMode: "any",
      minRating: null,
      exactRating: null,
      promptQuery: "",
      mightBe: "",
    });
    expect(librarySearchCriteria({ minRating: 4 })).toMatchObject({ minRating: 4, exactRating: null });
    // An exact rating wins over a minimum, and "unrated" is no search.
    expect(librarySearchCriteria({ minRating: 2, exactRating: 5 })).toMatchObject({
      minRating: null,
      exactRating: 5,
    });
    expect(hasLibrarySearchCriteria(librarySearchCriteria({ exactRating: 0 }))).toBe(false);
    expect(hasLibrarySearchCriteria(librarySearchCriteria({ minRating: 3 }))).toBe(true);
    expect(hasLibrarySearchCriteria(librarySearchCriteria({}))).toBe(false);
    // Prompt words alone are a search too.
    expect(hasLibrarySearchCriteria(librarySearchCriteria({ promptQuery: " lighthouse " }))).toBe(true);
    expect(librarySearchCriteria({ promptQuery: " lighthouse " }).promptQuery).toBe("lighthouse");
    // And so is a tag the clips might be.
    expect(hasLibrarySearchCriteria(librarySearchCriteria({ mightBe: " dance " }))).toBe(true);
    expect(librarySearchKey(librarySearchCriteria({ mightBe: "dance" }))).not.toBe(
      librarySearchKey(librarySearchCriteria({ mightBe: "sea" }))
    );
  });

  it("changes its key when the rating changes", () => {
    const four = librarySearchKey(librarySearchCriteria({ minRating: 4 }));
    const five = librarySearchKey(librarySearchCriteria({ minRating: 5 }));
    expect(four).not.toBe(five);
  });
});
