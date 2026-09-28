import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  METADATA_INSPECTOR_MODES,
  METADATA_INSPECTOR_REVISION,
  normalizeMetadataInspectorMode,
  resolveMetadataInspectorMode,
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

  it("defaults malformed values to the docked default", () => {
    expect(normalizeMetadataInspectorMode("window")).toBe("docked");
    expect(normalizeMetadataInspectorMode(true)).toBe("docked");
    expect(normalizeMetadataInspectorMode(null)).toBe("docked");
  });

  it("docks settings written before the docked default, once", () => {
    expect(resolveMetadataInspectorMode({ metadataInspectorMode: "floating" })).toBe("docked");
    expect(resolveMetadataInspectorMode({})).toBe("docked");
    expect(resolveMetadataInspectorMode(null)).toBe("docked");
    expect(
      resolveMetadataInspectorMode({
        metadataInspectorMode: "floating",
        metadataInspectorRevision: METADATA_INSPECTOR_REVISION,
      })
    ).toBe("floating");
    expect(
      resolveMetadataInspectorMode({
        metadataInspectorMode: "docked",
        metadataInspectorRevision: METADATA_INSPECTOR_REVISION,
      })
    ).toBe("docked");
  });
});
