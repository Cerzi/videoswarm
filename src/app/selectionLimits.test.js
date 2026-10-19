import { createRequire } from "module";
import { describe, expect, it } from "vitest";
import { LARGE_SELECTION, SELECTION_LIMITS, selectionWarning } from "./selectionLimits";
import { METADATA_BATCH } from "./hooks/useMetadataActions";

const require = createRequire(import.meta.url);

describe("selection limits", () => {
  it("say what a large selection cannot do at once", () => {
    expect(selectionWarning(LARGE_SELECTION)).toBeNull();
    expect(selectionWarning(20_000)).toBeNull();
    expect(selectionWarning(20_001)).toBe("Too many to trash at once (20,000 at most)");
    expect(selectionWarning(50_001)).toBe("Too many to move or copy at once (50,000 at most)");
  });

  it("match what main accepts", () => {
    const { ACCEPTED_COPY_MAX_MEDIA } = require("../../main/review-export-scope");
    const { DEFAULT_MAX_TRASH_ITEMS } = require("../../main/ipc-trash");
    const { IPC_LIMITS } = require("../../main/ipc-security");
    expect(SELECTION_LIMITS.transfer).toBe(ACCEPTED_COPY_MAX_MEDIA);
    expect(SELECTION_LIMITS.trash).toBe(DEFAULT_MAX_TRASH_ITEMS);
    // Metadata changes are batched to what main takes per request.
    expect(METADATA_BATCH).toBe(IPC_LIMITS.maxArrayEntries);
  });
});
