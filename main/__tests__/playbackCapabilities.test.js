const {
  applyPlaybackModeScheduling,
  createPlaybackCapabilities,
  isHardwareDecodeDetected,
  normalizePlaybackMode,
  normalizeVideoDecodeStatus,
} = require("../playback-capabilities");

describe("playback capabilities", () => {
  test.each([
    ["enabled", true],
    ["enabled-on", true],
    ["hardware accelerated", true],
    ["disabled_software", false],
    ["unavailable", false],
    [undefined, false],
  ])("maps video decode state %s without claiming a guarantee", (value, detected) => {
    expect(isHardwareDecodeDetected(value)).toBe(detected);
  });

  test("normalizes Chromium status strings", () => {
    expect(normalizeVideoDecodeStatus(" Disabled Software ")).toBe(
      "disabled_software"
    );
  });

  test.each([
    ["balanced", "balanced"],
    ["ADAPTIVE-MOTION", "adaptive-motion"],
    ["ALL-MOTION", "all-motion"],
    ["static-hover", "static-hover"],
    ["legacy", "balanced"],
    [null, "balanced"],
  ])("normalizes playback mode %s", (value, expected) => {
    expect(normalizePlaybackMode(value)).toBe(expected);
  });

  test("returns bounded hardware facts and always marks acceleration unguaranteed", () => {
    expect(
      createPlaybackCapabilities({
        platform: "linux",
        gpuFeatureStatus: { video_decode: "enabled" },
        logicalCores: 0,
        totalMemoryMB: -5,
        proxyAvailable: false,
      })
    ).toEqual({
      platform: "linux",
      logicalCores: 1,
      totalMemoryMB: 0,
      videoDecodeStatus: "enabled",
      hardwareDecodeDetected: true,
      hardwareDecodeGuaranteed: false,
      proxyAvailable: false,
    });
  });

  test("disables Chromium background throttling only for explicit All Motion", () => {
    const webContents = {
      isDestroyed: () => false,
      setBackgroundThrottling: vi.fn(),
    };

    expect(applyPlaybackModeScheduling(webContents, "all-motion")).toEqual({
      success: true,
      mode: "all-motion",
      backgroundThrottling: false,
    });
    expect(applyPlaybackModeScheduling(webContents, "adaptive-motion")).toEqual({
      success: true,
      mode: "adaptive-motion",
      backgroundThrottling: true,
    });
    expect(webContents.setBackgroundThrottling.mock.calls).toEqual([
      [false],
      [true],
    ]);
  });

  test("does not touch destroyed renderer scheduling state", () => {
    const webContents = {
      isDestroyed: () => true,
      setBackgroundThrottling: vi.fn(),
    };
    expect(applyPlaybackModeScheduling(webContents, "all-motion")).toMatchObject({
      success: false,
      mode: "all-motion",
      error: "WEB_CONTENTS_UNAVAILABLE",
    });
    expect(webContents.setBackgroundThrottling).not.toHaveBeenCalled();
  });
});
