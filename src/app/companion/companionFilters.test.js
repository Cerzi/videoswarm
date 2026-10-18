import { describe, expect, it } from "vitest";
import {
  companionFilterCount,
  matchesCompanionFilters,
  normalizeCompanionFilters,
  parseCompanionFilterKey,
} from "./companionFilters";

const entry = (polish, enlarge) => ({
  actions: {
    ...(polish ? { polish: { phase: polish } } : {}),
    ...(enlarge ? { enlarge: { phase: enlarge } } : {}),
  },
});

// Clip entries from two companions, by id.
const from = (c1, c2) => (id) => (id === "c1" ? c1 : id === "c2" ? c2 : undefined);
const ids = ["c1", "c2"];
const matches = (c1, filters, hideSent, c2) => matchesCompanionFilters(from(c1, c2), ids, filters, hideSent);

describe("companion filters", () => {
  it("keeps only well-formed filters, a plain action id belonging to the first companion", () => {
    expect(
      normalizeCompanionFilters({
        polish: "sent",
        "c2/enlarge": "done",
        "Bad Id": "done",
        "c2/upscale": "sideways",
        "x9/polish": "done",
      })
    ).toEqual({ "c1/polish": "sent", "c2/enlarge": "done" });
    expect(normalizeCompanionFilters(null)).toEqual({});
    expect(normalizeCompanionFilters(["sent"])).toEqual({});
    expect(parseCompanionFilterKey("c3/polish")).toEqual({ companionId: "c3", actionId: "polish" });
    expect(parseCompanionFilterKey("polish")).toBeNull();
  });

  it("finds what is left to finish: anything but done, where the action applies", () => {
    for (const phase of ["not-sent", "under-way", "stopped"]) {
      expect(matches(entry(phase), { "c1/polish": "not-done" })).toBe(true);
    }
    expect(matches(entry("done"), { "c1/polish": "not-done" })).toBe(false);
    expect(matches(entry("n/a"), { "c1/polish": "not-done" })).toBe(false);
    // Unanswered clips are shown, as for every companion filter.
    expect(matches(undefined, { "c1/polish": "not-done" })).toBe(true);
    expect(normalizeCompanionFilters({ "c1/polish": "not-done" })).toEqual({ "c1/polish": "not-done" });
  });

  it("matches a phase per companion action, with sent covering under way, done and stopped", () => {
    expect(matches(entry("not-sent"), { "c1/polish": "not-sent" })).toBe(true);
    expect(matches(entry("done"), { "c1/polish": "not-sent" })).toBe(false);
    for (const phase of ["under-way", "done", "stopped"]) {
      expect(matches(entry(phase), { "c1/polish": "sent" })).toBe(true);
    }
    expect(matches(entry("n/a"), { "c1/polish": "sent" })).toBe(false);
    expect(
      matches(entry("not-sent", "done"), { "c1/polish": "not-sent", "c1/enlarge": "done" })
    ).toBe(true);
    // Each companion is asked about its own actions only.
    expect(matches(entry("done"), { "c2/polish": "not-sent" }, false, entry("not-sent"))).toBe(true);
    expect(matches(entry("not-sent"), { "c2/polish": "not-sent" }, false, entry("done"))).toBe(false);
  });

  it("hides a clip sent for any action of any companion, even one later stopped", () => {
    expect(matches(entry("not-sent", "stopped"), {}, true)).toBe(false);
    expect(matches(entry("not-sent", "n/a"), {}, true)).toBe(true);
    expect(matches(entry("not-sent"), {}, true, entry("done"))).toBe(false);
  });

  it("lets a clip a companion has not answered for through", () => {
    expect(matches(undefined, { "c1/polish": "done" }, true)).toBe(true);
    expect(matches(entry(null, "done"), { "c1/polish": "done" })).toBe(true);
  });

  it("counts each action filter and the hide-sent switch", () => {
    expect(
      companionFilterCount({ companionFilters: { "c1/polish": "sent" }, companionHideSent: true })
    ).toBe(2);
    expect(companionFilterCount({})).toBe(0);
  });
});
