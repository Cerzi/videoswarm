import { describe, expect, it } from "vitest";
import { emptyTagSearchMessage } from "./tagSearchMessage";

describe("emptyTagSearchMessage", () => {
  it("names the one tag that was searched for", () => {
    expect(emptyTagSearchMessage(["keeper"], "all")).toBe(
      'No clips carry "keeper"'
    );
  });

  it("does not name a tag when several were searched for", () => {
    expect(emptyTagSearchMessage(["keeper", "sleep"], "all")).toBe(
      "No clips carry all of those tags"
    );
    expect(emptyTagSearchMessage(["keeper", "sleep"], "any")).toBe(
      "No clips carry any of those tags"
    );
  });

  // An unfiltered library search is not a tag search, so blaming a tag for the
  // empty result would point the user at the wrong thing entirely.
  it("does not mention tags when none were selected", () => {
    expect(emptyTagSearchMessage([], "all")).toBe(
      "The library has no clips to show"
    );
    expect(emptyTagSearchMessage(undefined, "all")).toBe(
      "The library has no clips to show"
    );
  });

  it("ignores blank entries when deciding how to phrase it", () => {
    expect(emptyTagSearchMessage(["  ", "keeper"], "all")).toBe(
      'No clips carry "keeper"'
    );
    expect(emptyTagSearchMessage(["   "], "all")).toBe(
      "The library has no clips to show"
    );
  });
});
