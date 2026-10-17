import { describe, expect, it } from "vitest";
import {
  companionFilterCount,
  matchesCompanionFilters,
  normalizeCompanionFilters,
} from "./companionFilters";

const entry = (polish, enlarge) => ({
  actions: {
    ...(polish ? { polish: { phase: polish } } : {}),
    ...(enlarge ? { enlarge: { phase: enlarge } } : {}),
  },
});

describe("companion filters", () => {
  it("keeps only well-formed action filters", () => {
    expect(
      normalizeCompanionFilters({ polish: "sent", "Bad Id": "done", enlarge: "sideways" })
    ).toEqual({ polish: "sent" });
    expect(normalizeCompanionFilters(null)).toEqual({});
    expect(normalizeCompanionFilters(["sent"])).toEqual({});
  });

  it("matches a phase per action, with sent covering under way, done and stopped", () => {
    expect(matchesCompanionFilters(entry("not-sent"), { polish: "not-sent" })).toBe(true);
    expect(matchesCompanionFilters(entry("done"), { polish: "not-sent" })).toBe(false);
    for (const phase of ["under-way", "done", "stopped"]) {
      expect(matchesCompanionFilters(entry(phase), { polish: "sent" })).toBe(true);
    }
    expect(matchesCompanionFilters(entry("n/a"), { polish: "sent" })).toBe(false);
    expect(
      matchesCompanionFilters(entry("not-sent", "done"), { polish: "not-sent", enlarge: "done" })
    ).toBe(true);
  });

  it("hides a clip sent for any action, even one that was later stopped", () => {
    expect(matchesCompanionFilters(entry("not-sent", "stopped"), {}, true)).toBe(false);
    expect(matchesCompanionFilters(entry("not-sent", "n/a"), {}, true)).toBe(true);
  });

  it("lets a clip the companion has not answered for through", () => {
    expect(matchesCompanionFilters(undefined, { polish: "done" }, true)).toBe(true);
    expect(matchesCompanionFilters(entry(null, "done"), { polish: "done" })).toBe(true);
  });

  it("counts each action filter and the hide-sent switch", () => {
    expect(
      companionFilterCount({ companionFilters: { polish: "sent" }, companionHideSent: true })
    ).toBe(2);
    expect(companionFilterCount({})).toBe(0);
  });
});
