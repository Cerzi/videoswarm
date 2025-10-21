import { describe, expect, it } from "vitest";
import { resolveFeatureFlags } from "./featureFlags";

describe("resolveFeatureFlags", () => {
  it("enables full DOM masonry by default", () => {
    const flags = resolveFeatureFlags();
    expect(flags.fullDomMasonry).toBe(true);
  });

  it("respects explicit de-window flags in process env", () => {
    const flags = resolveFeatureFlags({
      processEnv: { VS_DEWINDOW: "0", VS_KEEP_WINDOWING: "1" },
    });
    expect(flags.fullDomMasonry).toBe(false);
  });

  it("enables de-windowing via Vite env", () => {
    const flags = resolveFeatureFlags({
      metaEnv: { VITE_VS_DEWINDOW: "true" },
    });
    expect(flags.fullDomMasonry).toBe(true);
  });

  it("allows process overrides to disable despite meta", () => {
    const flags = resolveFeatureFlags({
      processEnv: { VS_KEEP_WINDOWING: "true" },
      metaEnv: { VITE_VS_DEWINDOW: "true" },
    });
    expect(flags.fullDomMasonry).toBe(false);
  });
});
