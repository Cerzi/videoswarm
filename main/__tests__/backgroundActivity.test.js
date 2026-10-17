import { createRequire } from "module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { ACTIVITY_KINDS, createBackgroundActivity } = require("../background-activity");

function fakeClock() {
  let now = 1000;
  const timers = [];
  return {
    now: () => now,
    setTimeout: (callback, delay) => {
      const timer = { callback, at: now + delay };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
    advance(ms) {
      now += ms;
      for (const timer of timers.filter((entry) => entry.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.callback();
      }
    },
  };
}

describe("background activity", () => {
  it("adds up jobs and queues per kind, in a fixed order, with counts only", () => {
    const clock = fakeClock();
    const activity = createBackgroundActivity({ clock });
    activity.queued("playback-proxies", 3);
    const reading = activity.begin("prompts", { total: 10 });
    reading.progress(4);
    activity.settled("playback-proxies");

    const { activities } = activity.snapshot();
    expect(activities).toEqual([
      { kind: "prompts", pausable: true, done: 4, total: 10, startedAt: 1000 },
      { kind: "playback-proxies", pausable: true, done: 1, total: 3, startedAt: 1000 },
    ]);
    expect(ACTIVITY_KINDS.map((entry) => entry.kind)).toEqual([
      "prompts",
      "playback-proxies",
      "stack-frames",
      "tag-suggestions",
    ]);
    expect(() => activity.begin("/home/someone/clip.mp4")).toThrow(TypeError);
  });

  it("forgets a kind once nothing is left, so its next batch counts from zero", () => {
    const clock = fakeClock();
    const activity = createBackgroundActivity({ clock });
    activity.queued("stack-frames", 2);
    activity.settled("stack-frames", 2);
    expect(activity.snapshot().activities).toEqual([]);

    clock.advance(5000);
    activity.queued("stack-frames");
    expect(activity.snapshot().activities).toEqual([
      { kind: "stack-frames", pausable: true, done: 0, total: 1, startedAt: 6000 },
    ]);

    const learning = activity.begin("tag-suggestions", { total: 2 });
    learning.finish();
    learning.finish();
    learning.progress(2);
    expect(activity.snapshot().activities.map((entry) => entry.kind)).toEqual(["stack-frames"]);
  });

  it("publishes the first change at once and the rest at most twice a second", () => {
    const clock = fakeClock();
    const activity = createBackgroundActivity({ clock });
    const listener = vi.fn();
    activity.subscribe(listener);

    activity.queued("playback-proxies");
    expect(listener).toHaveBeenCalledTimes(1);
    activity.queued("playback-proxies");
    activity.settled("playback-proxies");
    expect(listener).toHaveBeenCalledTimes(1);
    clock.advance(499);
    expect(listener).toHaveBeenCalledTimes(1);
    clock.advance(1);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.lastCall[0].activities[0]).toMatchObject({ done: 1, total: 2 });
  });

  it("holds pausable work until resumed and tells the producers", async () => {
    const clock = fakeClock();
    const activity = createBackgroundActivity({ clock });
    const producer = vi.fn();
    activity.onPauseChange(producer);
    await expect(activity.whenRunnable()).resolves.toBeUndefined();

    expect(activity.setPaused(true)).toMatchObject({ paused: true });
    expect(producer).toHaveBeenLastCalledWith(true);
    let resumed = false;
    const waiting = activity.whenRunnable().then(() => {
      resumed = true;
    });
    await Promise.resolve();
    expect(resumed).toBe(false);

    activity.setPaused(false);
    await waiting;
    expect(resumed).toBe(true);
    expect(producer).toHaveBeenLastCalledWith(false);
    expect(activity.snapshot().paused).toBe(false);
  });
});
