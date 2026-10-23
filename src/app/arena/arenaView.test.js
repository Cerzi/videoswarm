import { describe, expect, it } from "vitest";
import {
  addArenaOutcomes,
  arenaCardLabel,
  arenaStreak,
  arenaSummary,
  buildArenaClips,
  emptyArenaStats,
  isTypingTarget,
  arenaKeyCommand,
  arenaRoundChanged,
  arenaRoundDone,
  stepArenaSelection,
} from "./arenaView";

describe("arena view", () => {
  it("labels New, ratings, and ratings changed in the round", () => {
    expect(arenaCardLabel({ role: "new", rating: null }, { rating: null })).toBe("New");
    expect(arenaCardLabel({ role: "new", rating: null }, { rating: 3 })).toBe("New → 3★");
    expect(arenaCardLabel({ role: "reference", rating: 5 }, { rating: 5 })).toBe("5★");
    expect(arenaCardLabel({ role: "check", rating: 4 }, { rating: 5 })).toBe("4★ → 5★");
    expect(arenaCardLabel({ role: "check", rating: 4 }, { rating: null })).toBe("4★ → unrated");
    expect(arenaCardLabel(null, {})).toBeNull();
  });

  it("ends Place once New is rated or rejected, and a first round once all are", () => {
    const place = { kind: "place", clips: [{ id: "n", role: "new" }, { id: "r", role: "reference", rating: 3 }] };
    const videos = { n: { rating: null }, r: { rating: 3 } };
    const lookup = (part) => videos[part.id];
    expect(arenaRoundDone(place, lookup)).toBe(false);
    videos.n = { rating: 2 };
    expect(arenaRoundDone(place, lookup)).toBe(true);
    videos.n = { rating: null, reviewState: "reject" };
    expect(arenaRoundDone(place, lookup)).toBe(true);

    const first = { kind: "first", clips: [{ id: "a", role: "new" }, { id: "b", role: "new" }] };
    const fresh = { a: { rating: 4 }, b: { rating: null } };
    expect(arenaRoundDone(first, (part) => fresh[part.id])).toBe(false);
    fresh.b = { rating: 1 };
    expect(arenaRoundDone(first, (part) => fresh[part.id])).toBe(true);

    const tier = { kind: "tier", clips: [{ id: "a", role: "check", rating: 3 }] };
    expect(arenaRoundDone(tier, () => ({ rating: 5 }))).toBe(false);
    expect(arenaRoundChanged(tier, () => ({ rating: 5 }))).toBe(true);
    expect(arenaRoundChanged(tier, () => ({ rating: 3 }))).toBe(false);
  });

  it("steps the selection round the clips", () => {
    expect(stepArenaSelection(["a", "b", "c"], "c", 1)).toBe("a");
    expect(stepArenaSelection(["a", "b", "c"], "a", -1)).toBe("c");
    expect(stepArenaSelection(["a", "b"], "gone", 1)).toBe("a");
    expect(stepArenaSelection([], "a", 1)).toBeNull();
  });

  it("keeps its own keys and leaves ratings, review keys and Z to the grid", () => {
    expect(arenaKeyCommand({ key: "Enter" })).toBe("next");
    expect(arenaKeyCommand({ key: "Enter", repeat: true })).toBe("swallow");
    expect(arenaKeyCommand({ key: "Backspace" })).toBe("swallow");
    expect(arenaKeyCommand({ key: "Delete" })).toBe("swallow");
    expect(arenaKeyCommand({ key: "Escape" })).toBe("close");
    expect(arenaKeyCommand({ key: "ArrowRight" })).toBe("next-clip");
    expect(arenaKeyCommand({ key: "w" })).toEqual({ tag: 1 });
    expect(arenaKeyCommand({ key: "T" })).toBe("type-tag");
    for (const key of ["1", "5", "0", "z", "a", "x"]) expect(arenaKeyCommand({ key })).toBeNull();
    expect(arenaKeyCommand({ key: "ArrowLeft", altKey: true })).toBeNull();
    expect(arenaKeyCommand({ key: "q", shiftKey: true })).toBeNull();
  });

  it("maps a round's parts to the collection's own clips or guests, New first then low to high", () => {
    const round = {
      kind: "place",
      clips: [
        { instanceId: 3, role: "reference", rating: 5 },
        { instanceId: 1, role: "new", rating: null },
        { instanceId: 2, role: "reference", rating: 1 },
        { instanceId: 9, role: "reference", rating: 3 },
      ],
    };
    const records = [
      { id: "r3", instanceId: 3, fingerprint: "f3" },
      { id: "r1", instanceId: 1, fingerprint: "f1" },
      { id: "r2", instanceId: 2, fingerprint: "f2" },
    ];
    const own = { id: "own-1", fingerprint: "f1" };
    const { members, guests, parts } = buildArenaClips(round, records, [own]);
    // A clip main no longer had a record for is left out.
    expect(members.map((video) => video.id)).toEqual(["own-1", "r2", "r3"]);
    expect(guests.map((video) => video.id)).toEqual(["r2", "r3"]);
    expect(parts.get("own-1").role).toBe("new");
    expect(buildArenaClips(null, records, [])).toMatchObject({ members: [], guests: [] });
  });

  it("counts a session's rounds, its streak and the toast on leaving", () => {
    let stats = emptyArenaStats();
    stats = addArenaOutcomes(stats, { placed: 1 });
    stats = addArenaOutcomes(stats, { held: 2, raised: 1, lowered: 1 });
    expect(stats).toMatchObject({ rounds: 2, placed: 1, held: 2, moved: 2 });
    expect(arenaSummary(stats, 1)).toBe("Arena: 2 rounds · 1 placed · 2 moved · 2 held · 1 tagged");
    expect(arenaSummary(emptyArenaStats(), 0)).toBeNull();
    const finished = [{ outcomes: { placed: 1 } }, { outcomes: { skipped: 1 } }, { outcomes: { held: 3 } }, { outcomes: { placed: 1 } }];
    expect(arenaStreak(finished)).toBe(2);
    expect(arenaStreak([])).toBe(0);
  });

  it("never takes keys typed into a field", () => {
    const input = document.createElement("input");
    const exempt = document.createElement("div");
    exempt.setAttribute("data-hotkey-exempt", "");
    const inside = document.createElement("span");
    exempt.appendChild(inside);
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(inside)).toBe(true);
    expect(isTypingTarget(document.body)).toBe(false);
  });
});
