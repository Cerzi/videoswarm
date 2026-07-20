import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  METADATA_INSPECTOR_MODES,
  normalizeMetadataInspectorMode,
} = require("../metadata-inspector-settings");

describe("metadata inspector profile settings", () => {
  it("preserves the two allowed presentation modes", () => {
    expect(normalizeMetadataInspectorMode("floating")).toBe(
      METADATA_INSPECTOR_MODES.FLOATING
    );
    expect(normalizeMetadataInspectorMode("docked")).toBe(
      METADATA_INSPECTOR_MODES.DOCKED
    );
  });

  it("defaults malformed values to the bounded floating mode", () => {
    expect(normalizeMetadataInspectorMode("window")).toBe("floating");
    expect(normalizeMetadataInspectorMode(true)).toBe("floating");
    expect(normalizeMetadataInspectorMode(null)).toBe("floating");
  });
});
