import { describe, expect, it } from "vitest";
import { archivedTreeState } from "./useArchivedFolders";

describe("archivedTreeState", () => {
  it("tells a folder archived itself from one under an archived folder", () => {
    expect(archivedTreeState("old", ["old"])).toBe("own");
    expect(archivedTreeState("old/deep", ["old"])).toBe("covered");
    expect(archivedTreeState("older", ["old"])).toBeNull();
    expect(archivedTreeState("", [""])).toBe("own");
    expect(archivedTreeState("any", [""])).toBe("covered");
    expect(archivedTreeState("", [], true)).toBe("covered");
    expect(archivedTreeState("new", [])).toBeNull();
  });
});
