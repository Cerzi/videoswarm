import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { thumbService } from "./thumbService";

const makeCanvasContext = () => ({
  save: vi.fn(),
  restore: vi.fn(),
  beginPath: vi.fn(),
  closePath: vi.fn(),
  clip: vi.fn(),
  drawImage: vi.fn(),
  fill: vi.fn(),
  stroke: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  quadraticCurveTo: vi.fn(),
  roundRect: vi.fn(),
  fillStyle: "",
  strokeStyle: "",
  lineWidth: 1,
});

const makeVideo = ({ controlledFrame = false } = {}) => {
  const element = document.createElement("video");
  Object.defineProperties(element, {
    readyState: { configurable: true, value: 4 },
    paused: { configurable: true, value: false },
    videoWidth: { configurable: true, value: 320 },
    videoHeight: { configurable: true, value: 180 },
  });
  document.body.appendChild(element);

  let frameCallback = null;
  if (controlledFrame) {
    element.requestVideoFrameCallback = vi.fn((callback) => {
      frameCallback = callback;
      return 17;
    });
    element.cancelVideoFrameCallback = vi.fn();
  }

  return {
    element,
    triggerFrame: () => frameCallback?.(performance.now(), {}),
  };
};

const request = (path, signature, videoElement) =>
  thumbService.requestCapture({
    path,
    signature,
    videoElement,
    isVisible: () => true,
    reason: "test",
  });

describe("thumbService work suspension", () => {
  let previousElectronApi;
  let getThumbnail;
  let putThumbnail;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    previousElectronApi = window.electronAPI;
    getThumbnail = vi.fn(() => ({ ok: true, available: false }));
    putThumbnail = vi.fn(() => ({ ok: true }));
    window.electronAPI = {
      thumbs: {
        get: getThumbnail,
        put: putThumbnail,
      },
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      makeCanvasContext()
    );
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/png;base64,dGh1bWI="
    );
    thumbService.setSuspended(false);
    thumbService.resetGeneration();
  });

  afterEach(() => {
    thumbService.setSuspended(true);
    thumbService.resetGeneration();
    document.body.replaceChildren();
    if (previousElectronApi === undefined) {
      delete window.electronAPI;
    } else {
      window.electronAPI = previousElectronApi;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rejects new work while suspended and resumes with a fresh request", async () => {
    const { element } = makeVideo();
    thumbService.noteVideoMetadata("/clips/a.mp4", "a-v1");

    thumbService.setSuspended(true);
    expect(request("/clips/a.mp4", "a-v1", element)).toBe(false);
    await vi.runAllTimersAsync();
    expect(putThumbnail).not.toHaveBeenCalled();
    expect(thumbService.getDebugSnapshot()).toMatchObject({
      suspended: true,
      queued: 0,
      active: false,
      pendingStates: 0,
    });

    thumbService.setSuspended(false);
    expect(request("/clips/a.mp4", "a-v1", element)).toBe(true);
    await vi.runAllTimersAsync();
    expect(putThumbnail).toHaveBeenCalledOnce();
    expect(thumbService.getDebugSnapshot()).toMatchObject({
      suspended: false,
      queued: 0,
      active: false,
      pendingStates: 0,
    });
  });

  it("cancels delayed queued captures and clears their pending ownership", async () => {
    const first = makeVideo();
    const delayed = makeVideo();
    thumbService.noteVideoMetadata("/clips/first.mp4", "first-v1");
    thumbService.noteVideoMetadata("/clips/delayed.mp4", "delayed-v1");

    expect(request("/clips/first.mp4", "first-v1", first.element)).toBe(true);
    await vi.runAllTimersAsync();
    expect(putThumbnail).toHaveBeenCalledOnce();

    expect(
      request("/clips/delayed.mp4", "delayed-v1", delayed.element)
    ).toBe(true);
    expect(thumbService.getDebugSnapshot()).toMatchObject({
      queued: 1,
      delayed: true,
      pendingStates: 1,
    });

    thumbService.setSuspended(true);
    expect(thumbService.getDebugSnapshot()).toMatchObject({
      queued: 0,
      delayed: false,
      active: false,
      pendingStates: 0,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(putThumbnail).toHaveBeenCalledOnce();

    thumbService.setSuspended(false);
    expect(
      request("/clips/delayed.mp4", "delayed-v1", delayed.element)
    ).toBe(true);
    await vi.runAllTimersAsync();
    expect(putThumbnail).toHaveBeenCalledTimes(2);
  });

  it("invalidates an in-flight frame wait before it can write natively", async () => {
    const first = makeVideo({ controlledFrame: true });
    thumbService.noteVideoMetadata("/clips/in-flight.mp4", "flight-v1");

    expect(
      request("/clips/in-flight.mp4", "flight-v1", first.element)
    ).toBe(true);
    expect(first.element.requestVideoFrameCallback).toHaveBeenCalledOnce();
    expect(thumbService.getDebugSnapshot().active).toBe(true);

    thumbService.setSuspended(true);
    expect(first.element.cancelVideoFrameCallback).toHaveBeenCalledWith(17);
    first.triggerFrame();
    await Promise.resolve();
    await Promise.resolve();
    expect(putThumbnail).not.toHaveBeenCalled();
    expect(thumbService.getDebugSnapshot()).toMatchObject({
      active: false,
      queued: 0,
      pendingStates: 0,
    });

    thumbService.setSuspended(false);
    const replacement = makeVideo({ controlledFrame: true });
    expect(
      request("/clips/in-flight.mp4", "flight-v1", replacement.element)
    ).toBe(true);
    replacement.triggerFrame();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(putThumbnail).toHaveBeenCalledOnce();
  });

  it("resetGeneration drops generation-owned metadata and stale captures", async () => {
    const stale = makeVideo({ controlledFrame: true });
    thumbService.noteVideoMetadata("/clips/stale.mp4", "stale-v1");
    expect(request("/clips/stale.mp4", "stale-v1", stale.element)).toBe(true);

    const previousGeneration = thumbService.getDebugSnapshot().generation;
    const nextGeneration = thumbService.resetGeneration();
    expect(nextGeneration).toBeGreaterThan(previousGeneration);
    expect(thumbService.getDebugSnapshot()).toMatchObject({
      queued: 0,
      active: false,
      pendingStates: 0,
      memoryEntries: 0,
      metadataEntries: 0,
    });

    stale.triggerFrame();
    await vi.runAllTimersAsync();
    expect(putThumbnail).not.toHaveBeenCalled();

    const current = makeVideo({ controlledFrame: true });
    thumbService.noteVideoMetadata("/clips/current.mp4", "current-v1");
    expect(
      request("/clips/current.mp4", "current-v1", current.element)
    ).toBe(true);
    current.triggerFrame();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(putThumbnail).toHaveBeenCalledOnce();
  });
});
