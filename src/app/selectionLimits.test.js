import { createRequire } from "module";
import { describe, expect, it } from "vitest";
import { LARGE_SELECTION, SELECTION_LIMITS, selectionWarning } from "./selectionLimits";

const require = createRequire(import.meta.url);

describe("selection limits", () => {
  it("say what a large selection cannot do at once", () => {
    expect(selectionWarning(LARGE_SELECTION)).toBeNull();
    expect(selectionWarning(2_000)).toBeNull();
    expect(selectionWarning(2_001)).toBe("Too many to trash at once (2,000 at most)");
    expect(selectionWarning(48_213)).toBe("Too many to move, copy, tag or rate at once (20,000 at most)");
  });

  it("match what main accepts", () => {
    const { ACCEPTED_COPY_MAX_MEDIA } = require("../../main/review-export-scope");
    const { IPC_LIMITS } = require("../../main/ipc-security");
    expect(SELECTION_LIMITS.batch).toBe(ACCEPTED_COPY_MAX_MEDIA);
    expect(SELECTION_LIMITS.batch).toBe(IPC_LIMITS.maxArrayEntries);
  });
});
