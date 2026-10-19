import { describe, expect, it } from "vitest";
import {
  companionCardChips,
  companionQuickActions,
  createCompanionChipCache,
  createCompanionQuickActionCache,
  withQuickShortcuts,
} from "./companionCard";

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

describe("companion one-click buttons", () => {
  const app = (overrides = {}) => ({
    id: "c1",
    name: "Helper",
    status: "online",
    actions: [
      { id: "polish", label: "Polish", send: "Send to polish", hint: "", quick: true },
      { id: "enlarge", label: "Enlarge", send: "Send to enlarge", hint: "", quick: false },
    ],
    entries: new Map([
      [1, { actions: { polish: { phase: "not-sent" }, enlarge: { phase: "not-sent" } } }],
      [2, { actions: { polish: { phase: "under-way" } } }],
    ]),
    ...overrides,
  });

  it("offers each quick action the app says the clip has not been sent for", () => {
    expect(companionQuickActions([app()], 1)).toEqual([
      { key: "c1/polish", companionId: "c1", actionId: "polish", label: "Polish", title: "Send to polish" },
    ]);
    // Already under way, not answered for, or the app is offline: nothing.
    expect(companionQuickActions([app()], 2)).toEqual([]);
    expect(companionQuickActions([app()], 3)).toEqual([]);
    expect(companionQuickActions([app({ status: "offline" })], 1)).toEqual([]);
  });

  it("names the app when several are connected, and keeps a card's array while it reads the same", () => {
    const second = app({ id: "c2", name: "Editor" });
    expect(companionQuickActions([app(), second], 1).map((button) => button.title)).toEqual([
      "Send to polish · Helper",
      "Send to polish · Editor",
    ]);
    const buttonsFor = createCompanionQuickActionCache();
    const first = buttonsFor([app()], 1);
    expect(buttonsFor([app()], 1)).toBe(first);
    expect(buttonsFor([app()], 2)).toEqual([]);
  });
});

describe("quick action keys on buttons", () => {
  const button = (companionId, actionId) => ({
    key: `${companionId}/${actionId}`,
    companionId,
    actionId,
    label: actionId,
    title: actionId,
  });
  const actions = [
    { id: "polish", companionId: "c1", quick: true },
    { id: "enlarge", companionId: "c1", quick: false },
    { id: "polish", companionId: "c2", quick: true },
    { id: "caption", companionId: "c2", quick: true },
  ];

  it("names Shift+1 and Shift+2 by the quick actions' order across apps", () => {
    const named = withQuickShortcuts(
      [button("c2", "polish"), button("c2", "caption"), button("c1", "polish")],
      actions
    );
    expect(named.map((entry) => entry.shortcut ?? null)).toEqual(["Shift+2", null, "Shift+1"]);
  });

  it("keeps a clip's key even when the first action is already sent", () => {
    // c1/polish was sent, so its button is gone; c2/polish is still Shift+2.
    expect(withQuickShortcuts([button("c2", "polish")], actions)[0].shortcut).toBe("Shift+2");
    expect(withQuickShortcuts([], actions)).toEqual([]);
  });
});
