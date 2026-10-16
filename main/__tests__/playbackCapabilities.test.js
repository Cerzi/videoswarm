const {
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
      coverPauseAvailable: false,
      coverPauseUnavailableReason: "Not available on this system.",
    });
  });

  test("reports whether pausing while covered can work here", () => {
    expect(
      createPlaybackCapabilities({
        coverPauseAvailable: true,
        coverPauseUnavailableReason: "ignored when available",
      })
    ).toMatchObject({ coverPauseAvailable: true, coverPauseUnavailableReason: null });
    expect(
      createPlaybackCapabilities({
        coverPauseAvailable: false,
        coverPauseUnavailableReason: "Wayland does not report covered windows.",
      })
    ).toMatchObject({
      coverPauseAvailable: false,
      coverPauseUnavailableReason: "Wayland does not report covered windows.",
    });
  });

});
