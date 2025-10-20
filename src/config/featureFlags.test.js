import { describe, expect, it } from "vitest";
import { resolveFeatureFlags } from "./featureFlags";

describe("resolveFeatureFlags", () => {
  it("disables experimental layout projection by default", () => {
    const flags = resolveFeatureFlags();
    expect(flags.experimentalLayoutProjection).toBe(false);
  });

  it("enables experimental layout projection via process env", () => {
    const flags = resolveFeatureFlags({
      processEnv: { VS_EXP_LPM: "1" },
    });
    expect(flags.experimentalLayoutProjection).toBe(true);
  });

  it("enables experimental layout projection via meta env", () => {
    const flags = resolveFeatureFlags({
      metaEnv: { VITE_VS_EXP_LPM: "true" },
    });
    expect(flags.experimentalLayoutProjection).toBe(true);
  });

  it("prefers process env overrides when both provided", () => {
    const flags = resolveFeatureFlags({
      processEnv: { VS_EXP_LPM: "0" },
      metaEnv: { VS_EXP_LPM: "1" },
    });
    expect(flags.experimentalLayoutProjection).toBe(false);
  });
});
