import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAYBACK_MODE,
  PLAYBACK_MODES,
  buildPlaybackPriority,
  derivePlaybackSafetyCap,
  isPlaybackEligible,
  nextPlaybackDecision,
  normalizePlaybackMode,
} from "./playbackPolicy";

const healthy = {
  frameDelayMs: 16,
  longTaskRate: 0,
  droppedFrameRatio: 0,
  workingSetDeltaMB: 0,
  availableMemoryMB: 4096,
};

describe("playback policy", () => {
  it("normalizes persisted mode values", () => {
    expect(normalizePlaybackMode(PLAYBACK_MODES.ADAPTIVE_MOTION)).toBe(
      PLAYBACK_MODES.ADAPTIVE_MOTION
    );
    expect(normalizePlaybackMode(PLAYBACK_MODES.ALL_MOTION)).toBe(
      PLAYBACK_MODES.ALL_MOTION
    );
    expect(normalizePlaybackMode(PLAYBACK_MODES.STATIC_HOVER)).toBe(
      PLAYBACK_MODES.STATIC_HOVER
    );
    expect(normalizePlaybackMode("obsolete-mode")).toBe(DEFAULT_PLAYBACK_MODE);
    expect(normalizePlaybackMode(null)).toBe(DEFAULT_PLAYBACK_MODE);
  });

  it("keeps a weak two-core Linux Balanced target at two or below", () => {
    const decision = nextPlaybackDecision(null, {
      mode: PLAYBACK_MODES.BALANCED,
      platform: "linux",
      visibleCount: 120,
      hardwareConcurrency: 2,
      systemMemoryMB: 4096,
      availableMemoryMB: 2048,
      averagePixelArea: 1280 * 720,
      ...healthy,
    });

    expect(decision.safetyCap).toBeLessThanOrEqual(2);
    expect(decision.target).toBeLessThanOrEqual(2);
    expect(decision.target).toBeGreaterThan(0);
  });

  it("reduces quickly on decode and event-loop pressure", () => {
    const previous = { target: 10, cleanWindows: 2 };
    const decision = nextPlaybackDecision(previous, {
      mode: PLAYBACK_MODES.BALANCED,
      platform: "linux",
      visibleCount: 40,
      hardwareConcurrency: 16,
      systemMemoryMB: 32768,
      availableMemoryMB: 16000,
      averagePixelArea: 640 * 360,
      frameDelayMs: 145,
      longTaskRate: 0.24,
      droppedFrameRatio: 0.14,
      workingSetDeltaMB: 300,
    });

    expect(decision.health).toBe("critical");
    expect(decision.target).toBeLessThanOrEqual(6);
    expect(decision.cleanWindows).toBe(0);
    expect(decision.reasons).toEqual(
      expect.arrayContaining(["dropped-frames", "frame-delay"])
    );
  });

  it("recovers by at most one only after consecutive clean windows", () => {
    const input = {
      mode: PLAYBACK_MODES.BALANCED,
      platform: "linux",
      visibleCount: 30,
      hardwareConcurrency: 12,
      systemMemoryMB: 32768,
      averagePixelArea: 640 * 360,
      ...healthy,
      availableMemoryMB: 16000,
    };
    let decision = { target: 3, cleanWindows: 0 };

    decision = nextPlaybackDecision(decision, input);
    expect(decision.target).toBe(3);
    decision = nextPlaybackDecision(decision, input);
    expect(decision.target).toBe(3);
    decision = nextPlaybackDecision(decision, input);
    expect(decision.target).toBe(4);
    expect(decision.cleanWindows).toBe(0);

    decision = nextPlaybackDecision(decision, input);
    expect(decision.target).toBe(4);
  });

  it("Adaptive Motion raises the budget but retains an explicit safety cap", () => {
    const balanced = derivePlaybackSafetyCap({
      mode: PLAYBACK_MODES.BALANCED,
      platform: "linux",
      visibleCount: 1000,
      hardwareConcurrency: 8,
      systemMemoryMB: 16384,
      availableMemoryMB: 8192,
      averagePixelArea: 1280 * 720,
    });
    const adaptiveMotion = nextPlaybackDecision(null, {
      mode: PLAYBACK_MODES.ADAPTIVE_MOTION,
      platform: "linux",
      visibleCount: 1000,
      hardwareConcurrency: 8,
      systemMemoryMB: 16384,
      availableMemoryMB: 8192,
      averagePixelArea: 1280 * 720,
    });

    expect(adaptiveMotion.target).toBe(adaptiveMotion.safetyCap);
    expect(adaptiveMotion.target).toBeGreaterThan(balanced);
    expect(adaptiveMotion.target).toBeLessThan(1000);
    expect(adaptiveMotion.target).toBeLessThanOrEqual(64);
  });

  it("All Motion restores the uncapped visible set despite health pressure", () => {
    const decision = nextPlaybackDecision(
      { mode: PLAYBACK_MODES.BALANCED, target: 2, cleanWindows: 0 },
      {
        mode: PLAYBACK_MODES.ALL_MOTION,
        platform: "linux",
        visibleCount: 1000,
        hardwareConcurrency: 2,
        systemMemoryMB: 4096,
        availableMemoryMB: 100,
        averagePixelArea: 3840 * 2160,
        frameDelayMs: 180,
        longTaskRate: 0.4,
        droppedFrameRatio: 0.3,
        workingSetDeltaMB: 512,
      }
    );

    expect(decision).toMatchObject({
      mode: PLAYBACK_MODES.ALL_MOTION,
      target: 1000,
      safetyCap: 1000,
      health: "unrestricted",
      cleanWindows: 0,
    });
  });

  it("returns a zero target while suspended", () => {
    expect(
      nextPlaybackDecision({ target: 8, cleanWindows: 2 }, {
        visibleCount: 20,
        suspended: true,
      })
    ).toMatchObject({
      target: 0,
      safetyCap: 0,
      health: "suspended",
    });
  });

  it("applies a newly selected mode immediately", () => {
    const decision = nextPlaybackDecision(
      {
        mode: PLAYBACK_MODES.BALANCED,
        target: 2,
        cleanWindows: 0,
      },
      {
        mode: PLAYBACK_MODES.ALL_MOTION,
        platform: "linux",
        visibleCount: 100,
        hardwareConcurrency: 8,
        systemMemoryMB: 16384,
        availableMemoryMB: 8192,
        averagePixelArea: 640 * 360,
      }
    );

    expect(decision.target).toBe(decision.safetyCap);
    expect(decision.target).toBeGreaterThan(2);
  });
});

describe("playback priority", () => {
  const common = {
    visibleIds: new Set(["edge", "selected", "hover", "center"]),
    loadedIds: new Set(["edge", "selected", "hover", "center"]),
    centerOrderedIds: ["center", "selected", "hover", "edge"],
    selectedIds: new Set(["selected"]),
    hoveredId: "hover",
  };

  it("orders hover, selection, then viewport-center candidates", () => {
    expect(
      buildPlaybackPriority({
        ...common,
        mode: PLAYBACK_MODES.BALANCED,
      })
    ).toEqual(["hover", "selected", "center", "edge"]);
  });

  it("limits Static + Hover eligibility to hovered or selected cards", () => {
    const priority = buildPlaybackPriority({
      ...common,
      mode: PLAYBACK_MODES.STATIC_HOVER,
    });
    expect(priority).toEqual(["hover", "selected"]);
    expect(
      isPlaybackEligible({
        ...common,
        id: "center",
        mode: PLAYBACK_MODES.STATIC_HOVER,
      })
    ).toBe(false);
    expect(
      isPlaybackEligible({
        ...common,
        id: "selected",
        mode: PLAYBACK_MODES.STATIC_HOVER,
      })
    ).toBe(true);
  });

  it("filters invisible and unloaded priority entries", () => {
    expect(
      buildPlaybackPriority({
        ...common,
        visibleIds: new Set(["hover", "selected", "center"]),
        loadedIds: new Set(["hover", "center"]),
        mode: PLAYBACK_MODES.BALANCED,
      })
    ).toEqual(["hover", "center"]);
  });
});
