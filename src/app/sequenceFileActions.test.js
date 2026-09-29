import { describe, expect, it } from "vitest";
import {
  describeSequenceBlocker,
  missingSequencePositions,
} from "./sequenceFileActions";

const sequence = (present) => ({
  entries: present.map((isPresent, index) => ({
    id: index + 1,
    video: isPresent ? { id: `/clips/${index}.mp4` } : null,
  })),
});

describe("sequence file-action blockers", () => {
  it("lists missing positions counting from one", () => {
    expect(missingSequencePositions(sequence([true, false, true, false]))).toEqual([2, 4]);
    expect(missingSequencePositions(null)).toEqual([]);
  });

  it("refuses an export or renumber while entries are missing, naming them", () => {
    expect(describeSequenceBlocker(sequence([true, false]), "export")).toBe(
      "Cannot export while clips are missing: position 2. Restore them or remove them from the sequence first."
    );
    expect(describeSequenceBlocker(sequence([false, false, true]), "renumber")).toMatch(
      /^Cannot renumber while clips are missing: positions 1, 2\./
    );
    expect(describeSequenceBlocker(sequence([true, true]))).toBeNull();
    expect(describeSequenceBlocker(sequence([]))).toBe("This sequence has no clips yet");
  });
});
