import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVideoStallWatchdog } from "./useVideoStallWatchdog";

const makeVideo = (playImpl = () => Promise.resolve()) => ({
  paused: false,
  readyState: 4,
  currentTime: 10,
  networkState: 1,
  currentSrc: "file:///clip.mp4",
  pause: vi.fn(),
  load: vi.fn(),
  play: vi.fn(playImpl),
});

describe("useVideoStallWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports rejected recovery instead of claiming success", async () => {
    const error = new Error("decoder restart failed");
    const video = makeVideo(() => Promise.reject(error));
    const onRecover = vi.fn();
    const onRecoveryError = vi.fn();
    const onRecoveryEnd = vi.fn();
    const teardown = useVideoStallWatchdog(
      { current: video },
      {
        id: "failed",
        tickMs: 100,
        ticksToStall: 2,
        onRecover,
        onRecoveryError,
        onRecoveryEnd,
      }
    );

    await vi.advanceTimersByTimeAsync(350);
    teardown();

    expect(video.play).toHaveBeenCalledOnce();
    expect(onRecover).not.toHaveBeenCalled();
    expect(onRecoveryError).toHaveBeenCalledWith(error);
  });

  it("keeps recovery single-flight and suppresses completion after teardown", async () => {
    let resolvePlay;
    const video = makeVideo(
      () => new Promise((resolve) => { resolvePlay = resolve; })
    );
    const onRecover = vi.fn();
    const onRecoveryError = vi.fn();
    const onRecoveryEnd = vi.fn();
    const teardown = useVideoStallWatchdog(
      { current: video },
      {
        id: "pending",
        tickMs: 100,
        ticksToStall: 1,
        onRecover,
        onRecoveryError,
        onRecoveryEnd,
      }
    );

    await vi.advanceTimersByTimeAsync(500);
    expect(video.play).toHaveBeenCalledOnce();

    teardown();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(onRecoveryEnd).toHaveBeenCalledOnce();
    resolvePlay();
    await Promise.resolve();
    expect(onRecover).not.toHaveBeenCalled();
    expect(onRecoveryError).not.toHaveBeenCalled();
  });

  it("does not let an old same-id teardown remove a newer subscription", async () => {
    const first = makeVideo();
    const second = makeVideo();
    const stopFirst = useVideoStallWatchdog(
      { current: first },
      { id: "same", tickMs: 100, ticksToStall: 1 }
    );
    const stopSecond = useVideoStallWatchdog(
      { current: second },
      { id: "same", tickMs: 100, ticksToStall: 1 }
    );

    stopFirst();
    await vi.advanceTimersByTimeAsync(250);

    expect(first.play).not.toHaveBeenCalled();
    expect(second.play).toHaveBeenCalledOnce();
    stopSecond();
  });

  it("bounds a play promise that never settles", async () => {
    const video = makeVideo(() => new Promise(() => {}));
    const onRecoveryError = vi.fn();
    const teardown = useVideoStallWatchdog(
      { current: video },
      {
        id: "timeout",
        tickMs: 100,
        ticksToStall: 1,
        recoveryTimeoutMs: 150,
        onRecoveryError,
      }
    );

    await vi.advanceTimersByTimeAsync(350);

    expect(onRecoveryError).toHaveBeenCalledOnce();
    expect(String(onRecoveryError.mock.calls[0][0])).toMatch(/timed out/i);
    teardown();
  });
});
