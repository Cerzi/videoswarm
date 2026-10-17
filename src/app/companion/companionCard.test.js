import { describe, expect, it } from "vitest";
import { companionCardChips, createCompanionChipCache } from "./companionCard";

const session = (id, name, entries) => ({
  id,
  name,
  actions: [{ id: "polish", label: "Polish" }],
  entries: new Map(entries),
});
const entry = (label, phase, why = "") => ({
  chip: label ? { label, tone: "progress" } : null,
  actions: { polish: { phase, why } },
});

describe("companion card chips", () => {
  it("gives one chip per app with something to say, naming the app when there are several", () => {
    const helper = session("c1", "Helper", [[7, entry("Waiting #2", "under-way", "Second in line")]]);
    const editor = session("c2", "Editor", [[7, entry("In a video", "done")], [8, entry(null, "done")]]);
    expect(companionCardChips([helper], 7)).toEqual([
      { key: "c1", label: "Waiting #2", tone: "progress", title: "Polish: Second in line" },
    ]);
    expect(companionCardChips([helper, editor], 7)).toEqual([
      { key: "c1", label: "Waiting #2", tone: "progress", title: "Helper\nPolish: Second in line" },
      { key: "c2", label: "In a video", tone: "progress", title: "Editor\nPolish: Done" },
    ]);
    expect(companionCardChips([helper, editor], 8)).toHaveLength(0);
  });

  it("hands back the same chips while they read the same", () => {
    const chipsFor = createCompanionChipCache();
    const before = [session("c1", "Helper", [[7, entry("Waiting #2", "under-way")]])];
    const first = chipsFor(before, 7);
    const again = chipsFor([session("c1", "Helper", [[7, entry("Waiting #2", "under-way")]])], 7);
    expect(again).toBe(first);
    const changed = chipsFor([session("c1", "Helper", [[7, entry("Done", "done")]])], 7);
    expect(changed).not.toBe(first);
    expect(chipsFor([], 7)).toBe(chipsFor([], 9));
  });
});
