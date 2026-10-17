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

const stackKey = (promptKey, firstId) => `${promptKey}\u0000${firstId}`;

describe("buildPromptStacks", () => {
  it("stacks neighbouring runs of a prompt and leaves the rest alone", () => {
    const videos = [
      clip("a1", PK_A),
      clip("a2", PK_A),
      clip("a3", PK_A),
      clip("b1", PK_B),
      clip("none", null),
      clip("b2", PK_B),
    ];
    const { stacks, keyById } = buildPromptStacks(videos);
    const key = stackKey(PK_A, "a1");
    expect([...stacks.keys()]).toEqual([key]);
    expect(stacks.get(key).members.map((video) => video.id)).toEqual(["a1", "a2", "a3"]);
    expect(stacks.get(key)).toMatchObject({ total: 3, similar: false });
    // A clip without a key ends a run; b1 and b2 are not neighbours.
    expect(keyById.has("b1")).toBe(false);
    expect(keyById.has("none")).toBe(false);
  });

  // Far apart in the sort is grouping, not stacking.
  it("never stacks runs of one prompt that something else sits between", () => {
    const videos = [clip("a1", PK_A), clip("b1", PK_B), clip("a2", PK_A), clip("b2", PK_B)];
    expect(buildPromptStacks(videos).stacks.size).toBe(0);
  });

  it("counts clips hidden by filters in the total, without regrouping", () => {
    const all = [clip("a1", PK_A), clip("a2", PK_A), clip("a3", PK_A), clip("b1", PK_B)];
    const { stacks } = buildPromptStacks(all, { visible: new Set(["a1", "a3", "b1"]) });
    const stack = stacks.get(stackKey(PK_A, "a1"));
    expect(stack.members.map((video) => video.id)).toEqual(["a1", "a3"]);
    expect(stack.total).toBe(3);
    // One visible clip is not a stack, however many are hidden.
    expect(buildPromptStacks(all, { visible: new Set(["a1", "b1"]) }).stacks.size).toBe(0);
  });

  it("joins alike prompts to the run's first prompt, without drifting", () => {
    const alike = (a, b) =>
      (a === PK_A && b === PK_B) || (a === PK_B && b === PK_C);
    const videos = [clip("a1", PK_A), clip("b1", PK_B), clip("c1", PK_C), clip("c2", PK_C)];
    const { stacks, keyById } = buildPromptStacks(videos, { alike });
    // c1 is alike to b1 but not to a1, which opened the run.
    expect(stacks.get(stackKey(PK_A, "a1")).members.map((video) => video.id)).toEqual(["a1", "b1"]);
    expect(stacks.get(stackKey(PK_A, "a1")).similar).toBe(true);
    expect(keyById.get("c2")).toBe(stackKey(PK_C, "c1"));
  });

  it("does not run across folder groups", () => {
    const videos = [
      clip("a1", PK_A, { dirname: "x" }),
      clip("a2", PK_A, { dirname: "y" }),
      clip("a3", PK_A, { dirname: "y" }),
    ];
    const { stacks } = buildPromptStacks(videos, { folderOf: (video) => video.dirname });
    expect([...stacks.keys()]).toEqual([stackKey(PK_A, "a2")]);
  });
});

describe("collapsePromptStacks", () => {
  it("keeps each stack's cover in place and drops its other runs", () => {
    const videos = [
      clip("a1", PK_A),
      clip("a2", PK_A, { reviewState: "pick" }),
      clip("b1", PK_B),
      clip("b2", PK_B),
      clip("solo", PK_C),
    ];
    const stacks = buildPromptStacks(videos);
    expect(collapsePromptStacks(videos, stacks).map((video) => video.id)).toEqual([
      "a2",
      "b1",
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
    const key = stackKey(PK_A, "a1");
    expect(units.unitOf("a1")).toBe(key);
    expect(units.unitOf("solo")).toBeNull();
    expect(units.membersOf(key)).toEqual(["a1", "a2"]);
    expect(units.representativeOf(key)).toBe("a2");
    expect(createStackSelectionUnits(buildPromptStacks([clip("x", null)]))).toBeNull();
  });

  it("walks stacks in grid order and skips ones that are gone", () => {
    const videos = [clip("a1", PK_A), clip("a2", PK_A), clip("b1", PK_B), clip("b2", PK_B)];
    const built = buildPromptStacks(videos);
    const order = stackOrderOf(collapsePromptStacks(videos, built), built);
    const [a, b] = [stackKey(PK_A, "a1"), stackKey(PK_B, "b1")];
    expect(order).toEqual([a, b]);
    expect(neighbouringStack(order, a, 1, built.stacks)).toBe(b);
    expect(neighbouringStack(order, a, -1, built.stacks)).toBeNull();
    expect(neighbouringStack([a, "gone", b], a, 1, built.stacks)).toBe(b);
    expect(neighbouringStack(order, "gone", 1, built.stacks)).toBeNull();
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
