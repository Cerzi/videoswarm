import { describe, expect, it } from "vitest";
import {
  buildPromptStacks,
  chooseStackCover,
  collapsePromptStacks,
  createStackSelectionUnits,
  neighbouringStack,
  stackOrderOf,
  unreviewedStackFingerprints,
} from "./promptStacks";

const PK_A = `pk1-${"a".repeat(32)}`;
const PK_B = `pk1-${"b".repeat(32)}`;
const PK_C = `pk1-${"c".repeat(32)}`;

const clip = (id, promptKey, extra = {}) => ({
  id,
  fingerprint: `f-${id}`,
  promptKey,
  reviewState: "unreviewed",
  rating: null,
  createdMs: 1000,
  ...extra,
});

describe("chooseStackCover", () => {
  it("prefers a pick, then rating, resolution and recency, and avoids rejects", () => {
    const hd = { dimensions: { width: 1920, height: 1080 } };
    expect(
      chooseStackCover([
        clip("a", PK_A, { reviewState: "reject", rating: 5, ...hd }),
        clip("b", PK_A, { createdMs: 5 }),
        clip("c", PK_A, { createdMs: 9 }),
      ]).id
    ).toBe("c");
    expect(
      chooseStackCover([
        clip("a", PK_A, { rating: 4 }),
        clip("b", PK_A, { reviewState: "pick" }),
        clip("c", PK_A, hd),
      ]).id
    ).toBe("b");
    expect(chooseStackCover([clip("a", PK_A), clip("b", PK_A, { rating: 2 })]).id).toBe("b");
    expect(chooseStackCover([clip("a", PK_A), clip("b", PK_A, hd)]).id).toBe("b");
    // A tie keeps the first run in grid order.
    expect(chooseStackCover([clip("a", PK_A), clip("b", PK_A)]).id).toBe("a");
    expect(chooseStackCover([])).toBeNull();
  });
});

describe("buildPromptStacks", () => {
  it("stacks two or more runs of a prompt and leaves the rest alone", () => {
    const videos = [
      clip("a1", PK_A),
      clip("b1", PK_B),
      clip("a2", PK_A),
      clip("none", null),
      clip("a3", PK_A),
    ];
    const { stacks, keyById } = buildPromptStacks(videos);
    expect([...stacks.keys()]).toEqual([PK_A]);
    expect(stacks.get(PK_A).members.map((video) => video.id)).toEqual(["a1", "a2", "a3"]);
    expect(stacks.get(PK_A).total).toBe(3);
    expect(keyById.has("b1")).toBe(false);
    expect(keyById.has("none")).toBe(false);
  });

  it("counts runs hidden by filters in the total only", () => {
    const all = [clip("a1", PK_A), clip("a2", PK_A), clip("a3", PK_A), clip("b1", PK_B)];
    const visible = [all[0], all[2], all[3]];
    const { stacks } = buildPromptStacks(visible, all);
    expect(stacks.get(PK_A).members).toHaveLength(2);
    expect(stacks.get(PK_A).total).toBe(3);
    // One visible run is not a stack, however many are hidden.
    expect(buildPromptStacks([all[0]], all).stacks.size).toBe(0);
  });
});

describe("collapsePromptStacks", () => {
  it("keeps each stack's cover in place and drops its other runs", () => {
    const videos = [
      clip("a1", PK_A),
      clip("b1", PK_B),
      clip("a2", PK_A, { reviewState: "pick" }),
      clip("b2", PK_B),
      clip("solo", PK_C),
    ];
    const stacks = buildPromptStacks(videos);
    expect(collapsePromptStacks(videos, stacks).map((video) => video.id)).toEqual([
      "b1",
      "a2",
      "solo",
    ]);
    const none = buildPromptStacks([clip("x", null)]);
    const plain = [clip("x", null)];
    expect(collapsePromptStacks(plain, none)).toBe(plain);
  });
});

describe("stack selection units and order", () => {
  it("maps every run to its stack and the stack to its cover", () => {
    const videos = [clip("a1", PK_A), clip("a2", PK_A, { rating: 3 }), clip("solo", PK_C)];
    const units = createStackSelectionUnits(buildPromptStacks(videos));
    expect(units.unitOf("a1")).toBe(PK_A);
    expect(units.unitOf("solo")).toBeNull();
    expect(units.membersOf(PK_A)).toEqual(["a1", "a2"]);
    expect(units.representativeOf(PK_A)).toBe("a2");
    expect(createStackSelectionUnits(buildPromptStacks([clip("x", null)]))).toBeNull();
  });

  it("walks stacks in grid order and skips ones that are gone", () => {
    const videos = [clip("a1", PK_A), clip("a2", PK_A), clip("b1", PK_B), clip("b2", PK_B)];
    const built = buildPromptStacks(videos);
    const order = stackOrderOf(collapsePromptStacks(videos, built), built);
    expect(order).toEqual([PK_A, PK_B]);
    expect(neighbouringStack(order, PK_A, 1, built.stacks)).toBe(PK_B);
    expect(neighbouringStack(order, PK_A, -1, built.stacks)).toBeNull();
    expect(neighbouringStack([PK_A, PK_C, PK_B], PK_A, 1, built.stacks)).toBe(PK_B);
    expect(neighbouringStack(order, PK_C, 1, built.stacks)).toBeNull();
  });

  it("lists the runs still waiting for a decision, once per content", () => {
    const stack = {
      members: [
        clip("a1", PK_A),
        clip("a2", PK_A, { reviewState: "pick" }),
        clip("a3", PK_A, { reviewState: "reviewed", rating: 2 }),
        clip("a4", PK_A, { reviewState: "reject" }),
        { ...clip("a5", PK_A), fingerprint: "f-a1" },
        clip("a6", PK_A),
      ],
    };
    expect(unreviewedStackFingerprints(stack)).toEqual(["f-a1", "f-a6"]);
  });
});
