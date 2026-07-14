import {
  HOTKEY_SECTIONS,
  REVIEW_CLEAR_RATING_KEYS,
  REVIEW_PRIMARY_KEY_BY_STATE,
  REVIEW_RATING_BY_KEY,
  REVIEW_SHORTCUTS,
  REVIEW_STATE_BY_KEY,
  REVIEW_UNDO_KEYS,
} from "./shortcutCatalog";

describe("review shortcut catalog", () => {
  it("drives primary one-handed keys and compatibility aliases from one catalog", () => {
    expect(REVIEW_STATE_BY_KEY).toMatchObject({
      a: "pick",
      p: "pick",
      s: "reviewed",
      r: "reviewed",
      d: "reject",
      x: "reject",
      f: "unreviewed",
      u: "unreviewed",
    });
    expect(REVIEW_PRIMARY_KEY_BY_STATE).toEqual({
      pick: "A",
      reviewed: "S",
      reject: "D",
      unreviewed: "F",
    });
  });

  it("keeps numeric ratings, clear, undo, and help synchronized", () => {
    expect(REVIEW_RATING_BY_KEY).toEqual({
      1: 1,
      2: 2,
      3: 3,
      4: 4,
      5: 5,
    });
    expect(REVIEW_CLEAR_RATING_KEYS).toEqual(["0"]);
    expect(REVIEW_UNDO_KEYS).toEqual(["z"]);
    expect(
      HOTKEY_SECTIONS.find((section) => section.id === "review")?.shortcuts
    ).toBe(REVIEW_SHORTCUTS);
  });
});
