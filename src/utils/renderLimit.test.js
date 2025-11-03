import {
  RENDER_LIMIT_MIN,
  RENDER_LIMIT_STEPS,
  clampRenderLimitStep,
  resolveRenderLimit,
  formatRenderLimitLabel,
  inferRenderLimitStepFromLegacy,
} from "./renderLimit";

describe("renderLimit utilities", () => {
  test("clampRenderLimitStep bounds values", () => {
    expect(clampRenderLimitStep(-5)).toBe(0);
    expect(clampRenderLimitStep(RENDER_LIMIT_STEPS + 5)).toBe(RENDER_LIMIT_STEPS);
    expect(clampRenderLimitStep(3.4)).toBe(3);
    expect(clampRenderLimitStep(NaN)).toBe(RENDER_LIMIT_STEPS);
  });

  test("resolveRenderLimit returns null at max step when videos present", () => {
    expect(resolveRenderLimit(RENDER_LIMIT_STEPS, 400)).toBeNull();
  });

  test("resolveRenderLimit falls back to zero when no videos", () => {
    expect(resolveRenderLimit(RENDER_LIMIT_STEPS, 0)).toBe(0);
    expect(resolveRenderLimit(0, 0)).toBe(0);
  });

  test("resolveRenderLimit scales linearly towards folder size", () => {
    const total = 600;
    const halfStep = Math.floor(RENDER_LIMIT_STEPS / 2);
    const limit = resolveRenderLimit(halfStep, total);
    const expectedRange = Math.max(0, total - RENDER_LIMIT_MIN);
    const expected = Math.min(
      Math.round(RENDER_LIMIT_MIN + (expectedRange * halfStep) / RENDER_LIMIT_STEPS),
      total
    );
    expect(limit).toBe(expected);
  });

  test("resolveRenderLimit never exceeds available videos", () => {
    expect(resolveRenderLimit(2, 80)).toBe(80);
  });

  test("formatRenderLimitLabel returns Max when unlimited", () => {
    expect(formatRenderLimitLabel(RENDER_LIMIT_STEPS, 450)).toBe("Max");
  });

  test("inferRenderLimitStepFromLegacy maps legacy extremes", () => {
    expect(inferRenderLimitStepFromLegacy(500)).toBe(RENDER_LIMIT_STEPS);
    expect(inferRenderLimitStepFromLegacy(10)).toBe(0);
  });

  test("inferRenderLimitStepFromLegacy maps mid-range proportionally", () => {
    const midLegacy = (10 + 500) / 2;
    const expectedStep = clampRenderLimitStep(Math.round(0.5 * RENDER_LIMIT_STEPS));
    expect(inferRenderLimitStepFromLegacy(midLegacy)).toBe(expectedStep);
  });

  test("inferRenderLimitStepFromLegacy handles invalid values", () => {
    expect(inferRenderLimitStepFromLegacy(undefined)).toBe(RENDER_LIMIT_STEPS);
    expect(inferRenderLimitStepFromLegacy(-20)).toBe(RENDER_LIMIT_STEPS);
  });

  test("formatRenderLimitLabel displays numeric limits", () => {
    expect(formatRenderLimitLabel(0, 120)).toBe(String(RENDER_LIMIT_MIN));
  });
});
