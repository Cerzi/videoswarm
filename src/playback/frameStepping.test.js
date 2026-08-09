import { describe, expect, it } from "vitest";
import {
  FALLBACK_FRAME_RATE,
  formatFramePosition,
  frameCountFor,
  frameHoldDelay,
  frameIndexAt,
  frameStartTime,
  lastFrameIndexFor,
  resolveFrameRate,
  resolveFrameStep,
} from "./frameStepping";

describe("frame stepping arithmetic", () => {
  it("falls back to a usable rate for unprobed or absurd values", () => {
    expect(resolveFrameRate(30)).toBe(30);
    expect(resolveFrameRate(undefined)).toBe(FALLBACK_FRAME_RATE);
    expect(resolveFrameRate(0)).toBe(FALLBACK_FRAME_RATE);
    expect(resolveFrameRate(-5)).toBe(FALLBACK_FRAME_RATE);
    expect(resolveFrameRate(Number.NaN)).toBe(FALLBACK_FRAME_RATE);
    expect(resolveFrameRate(0.2)).toBe(1);
    expect(resolveFrameRate(100_000)).toBe(1000);
  });

  it("reports the frame displayed at a position", () => {
    expect(frameIndexAt(0, 25)).toBe(0);
    expect(frameIndexAt(0.02, 25)).toBe(0);
    expect(frameIndexAt(0.04, 25)).toBe(1);
    expect(frameIndexAt(1, 25)).toBe(25);
    expect(frameIndexAt(-1, 25)).toBe(0);
  });

  it("seeks to the middle of a frame so boundary rounding cannot decide it", () => {
    // 1/25 = 0.04, so frame 1 spans [0.04, 0.08) and its midpoint is 0.06.
    expect(frameStartTime(1, 25)).toBeCloseTo(0.06, 6);
    // The seeked position must still report the frame that was asked for.
    expect(frameIndexAt(frameStartTime(7, 25), 25)).toBe(7);
    expect(frameIndexAt(frameStartTime(0, 30), 30)).toBe(0);
  });

  it("never seeks to or past the duration", () => {
    const duration = 1;
    const time = frameStartTime(999, 25, duration);
    expect(time).toBeLessThan(duration);
    expect(frameIndexAt(time, 25)).toBe(lastFrameIndexFor(duration, 25));
  });

  it("counts frames from duration and tolerates an unknown duration", () => {
    expect(frameCountFor(2, 25)).toBe(50);
    expect(frameCountFor(0, 25)).toBe(0);
    expect(frameCountFor(undefined, 25)).toBe(0);
    expect(lastFrameIndexFor(2, 25)).toBe(49);
    expect(lastFrameIndexFor(0, 25)).toBe(0);
  });

  it("steps forward and back one frame at a time", () => {
    const base = { duration: 2, frameRate: 25 };
    const forward = resolveFrameStep({ ...base, currentTime: 0, direction: 1 });
    expect(forward.index).toBe(1);
    expect(frameIndexAt(forward.time, 25)).toBe(1);

    const back = resolveFrameStep({
      ...base,
      currentTime: forward.time,
      direction: -1,
    });
    expect(back.index).toBe(0);
    expect(frameIndexAt(back.time, 25)).toBe(0);
  });

  it("survives repeated stepping without drifting off by a frame", () => {
    const frameRate = 30;
    const duration = 5;
    let time = 0;
    for (let expected = 1; expected <= 60; expected += 1) {
      const step = resolveFrameStep({
        currentTime: time,
        duration,
        frameRate,
        direction: 1,
      });
      expect(step.index).toBe(expected);
      time = step.time;
      // The decoder reports the seeked position back; it must agree.
      expect(frameIndexAt(time, frameRate)).toBe(expected);
    }
  });

  it("clamps at both ends instead of wrapping", () => {
    expect(
      resolveFrameStep({ currentTime: 0, duration: 2, frameRate: 25, direction: -1 })
    ).toBeNull();
    const lastTime = frameStartTime(49, 25, 2);
    expect(
      resolveFrameStep({
        currentTime: lastTime,
        duration: 2,
        frameRate: 25,
        direction: 1,
      })
    ).toBeNull();
  });

  it("still steps forward when the duration is unknown", () => {
    const step = resolveFrameStep({
      currentTime: 0,
      duration: 0,
      frameRate: 25,
      direction: 1,
    });
    expect(step.index).toBe(1);
  });

  it("waits out a tap before repeating, then accelerates to a floor", () => {
    const threshold = frameHoldDelay(0);
    // A tap must never turn into a scrub, so the first gap is the longest one.
    expect(threshold).toBeGreaterThanOrEqual(300);
    expect(frameHoldDelay(1)).toBeLessThan(threshold);

    const gaps = Array.from({ length: 40 }, (_, index) =>
      frameHoldDelay(index + 1)
    );
    for (let index = 1; index < gaps.length; index += 1) {
      expect(gaps[index]).toBeLessThanOrEqual(gaps[index - 1]);
    }
    // It settles at a sustainable rate rather than converging on zero.
    expect(gaps.at(-1)).toBeGreaterThan(0);
    expect(gaps.at(-1)).toBeLessThan(gaps[0]);
    expect(gaps.at(-1)).toBe(frameHoldDelay(1_000));

    // A hold reaches its top rate quickly enough to feel like scrubbing.
    const toTopSpeed = gaps.findIndex((gap) => gap === gaps.at(-1)) + 1;
    expect(toTopSpeed).toBeLessThanOrEqual(15);

    expect(frameHoldDelay(-3)).toBe(threshold);
    expect(frameHoldDelay(Number.NaN)).toBe(threshold);
    expect(frameHoldDelay(undefined)).toBe(threshold);
  });

  it("formats a one-based readout and omits an unknown total", () => {
    expect(formatFramePosition(0, 121)).toBe("1 / 121");
    expect(formatFramePosition(41, 121)).toBe("42 / 121");
    expect(formatFramePosition(3, 0)).toBe("4");
  });
});
