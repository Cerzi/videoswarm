import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THUMB_SERVICE_LIMITS, thumbService } from "./thumbService";

const RATE_LIMIT_TEST_MS = 100;

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

const request = (path, signature, videoElement, owner = null) =>
  thumbService.requestCapture({
    path,
    signature,
    videoElement,
    isVisible: () => true,
    owner,
    reason: "test",
  });

const flushMicrotasks = async (count = 8) => {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
};

describe("thumbService work suspension", () => {
  let previousElectronApi;
  let getThumbnail;
  let putThumbnail;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    previousElectronApi = window.electronAPI;
    getThumbnail = vi.fn().mockResolvedValue({ ok: true, available: false });
    putThumbnail = vi.fn().mockResolvedValue({ ok: true });
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
    expect(request("/clips/a.mp4", "a-v1", element).accepted).toBe(false);
    await vi.runAllTimersAsync();
    expect(putThumbnail).not.toHaveBeenCalled();
    expect(thumbService.getDebugSnapshot()).toMatchObject({
      suspended: true,
      queued: 0,
      active: false,
      pendingStates: 0,
    });

    thumbService.setSuspended(false);
    expect(request("/clips/a.mp4", "a-v1", element).accepted).toBe(true);
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

    expect(
      request("/clips/first.mp4", "first-v1", first.element).accepted
    ).toBe(true);
    await vi.runAllTimersAsync();
    expect(putThumbnail).toHaveBeenCalledOnce();

    expect(
      request("/clips/delayed.mp4", "delayed-v1", delayed.element).accepted
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
      request("/clips/delayed.mp4", "delayed-v1", delayed.element).accepted
    ).toBe(true);
    await vi.runAllTimersAsync();
    expect(putThumbnail).toHaveBeenCalledTimes(2);
  });

  it("invalidates an in-flight frame wait before it can write natively", async () => {
    const first = makeVideo({ controlledFrame: true });
    thumbService.noteVideoMetadata("/clips/in-flight.mp4", "flight-v1");

    const firstRequest = request(
      "/clips/in-flight.mp4",
      "flight-v1",
      first.element
    );
    expect(firstRequest.accepted).toBe(true);
    await flushMicrotasks();
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
    const replacementRequest = request(
      "/clips/in-flight.mp4",
      "flight-v1",
      replacement.element
    );
    expect(replacementRequest.accepted).toBe(true);
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_TEST_MS);
    await flushMicrotasks();
    expect(replacement.element.requestVideoFrameCallback).toHaveBeenCalledOnce();
    replacement.triggerFrame();
    await expect(replacementRequest.done).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(putThumbnail).toHaveBeenCalledOnce();
  });

  it("resetGeneration drops generation-owned metadata and stale captures", async () => {
    const stale = makeVideo({ controlledFrame: true });
    thumbService.noteVideoMetadata("/clips/stale.mp4", "stale-v1");
    expect(
      request("/clips/stale.mp4", "stale-v1", stale.element).accepted
    ).toBe(true);

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
    const currentRequest = request(
      "/clips/current.mp4",
      "current-v1",
      current.element
    );
    expect(currentRequest.accepted).toBe(true);
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_TEST_MS);
    await flushMicrotasks();
    expect(current.element.requestVideoFrameCallback).toHaveBeenCalledOnce();
    current.triggerFrame();
    await expect(currentRequest.done).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(putThumbnail).toHaveBeenCalledOnce();
  });

  it("bounds the native lookup/capture lane and settles overflow plus cancellation", async () => {
    let releaseLookup;
    getThumbnail.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseLookup = resolve;
        })
    );
    const owner = {};
    const handles = [];

    for (let index = 0; index < THUMB_SERVICE_LIMITS.maxPending + 2; index += 1) {
      const path = `/clips/queued-${index}.mp4`;
      const signature = `queued-${index}-v1`;
      const { element } = makeVideo();
      thumbService.noteVideoMetadata(path, signature);
      handles.push(request(path, signature, element, owner));
    }

    expect(handles.filter((handle) => handle.accepted)).toHaveLength(
      THUMB_SERVICE_LIMITS.maxPending + 1
    );
    const overflow = handles.at(-1);
    expect(overflow.accepted).toBe(false);
    await expect(overflow.done).resolves.toMatchObject({
      status: "overflow",
      limit: THUMB_SERVICE_LIMITS.maxPending,
    });
    expect(getThumbnail).toHaveBeenCalledOnce();
    expect(thumbService.getDebugSnapshot()).toMatchObject({
      queued: THUMB_SERVICE_LIMITS.maxPending,
      active: true,
      trackedTasks: THUMB_SERVICE_LIMITS.maxPending + 1,
      ownerEntries: 1,
    });

    expect(thumbService.cancelOwner(owner)).toBe(
      THUMB_SERVICE_LIMITS.maxPending + 1
    );
    const results = await Promise.all(
      handles.filter((handle) => handle.accepted).map((handle) => handle.done)
    );
    expect(new Set(results.map((result) => result.status))).toEqual(
      new Set(["cancelled"])
    );
    expect(thumbService.getDebugSnapshot()).toMatchObject({
      queued: 0,
      active: false,
      trackedTasks: 0,
      ownerEntries: 0,
      pendingStates: 0,
      memoryEntries: 0,
      memoryBytes: 0,
    });

    releaseLookup?.({ ok: true, available: false });
    await vi.runAllTimersAsync();
    expect(putThumbnail).not.toHaveBeenCalled();
  });

  it("deduplicates async native lookups and ignores a late result after owner cancellation", async () => {
    let releaseLookup;
    getThumbnail.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseLookup = resolve;
        })
    );
    const owner = {};
    const { element } = makeVideo();
    thumbService.noteVideoMetadata("/clips/dedupe.mp4", "dedupe-v1");

    const first = request("/clips/dedupe.mp4", "dedupe-v1", element, owner);
    const duplicate = request(
      "/clips/dedupe.mp4",
      "dedupe-v1",
      element,
      owner
    );
    expect(first.accepted).toBe(true);
    expect(duplicate.accepted).toBe(false);
    await expect(duplicate.done).resolves.toMatchObject({
      status: "deduplicated",
    });
    expect(getThumbnail).toHaveBeenCalledOnce();

    expect(thumbService.cancelOwner(owner)).toBe(1);
    await expect(first.done).resolves.toMatchObject({ status: "cancelled" });
    releaseLookup({ ok: true, available: true });
    await vi.runAllTimersAsync();

    expect(putThumbnail).not.toHaveBeenCalled();
    expect(thumbService.metrics.nativeHits).toBe(0);
    expect(thumbService.getDebugSnapshot()).toMatchObject({
      trackedTasks: 0,
      ownerEntries: 0,
      pendingStates: 0,
    });
  });

  it("plateaus metadata across repeated A/B generations with no stale owners", async () => {
    const { maxMetadataEntries } = THUMB_SERVICE_LIMITS;
    for (let generationIndex = 0; generationIndex < 3; generationIndex += 1) {
      const owner = {};
      const path = `/switch/clip-${generationIndex}.mp4`;
      const { element } = makeVideo({ controlledFrame: true });
      thumbService.noteVideoMetadata(path, `${path}::A`);
      const handle = request(path, `${path}::A`, element, owner);
      expect(handle.accepted).toBe(true);

      thumbService.noteVideoMetadata(path, `${path}::B`);
      await expect(handle.done).resolves.toMatchObject({ status: "cancelled" });

      for (let index = 0; index < maxMetadataEntries + 128; index += 1) {
        const metadataPath = `/generation-${generationIndex}/clip-${index}.mp4`;
        thumbService.noteVideoMetadata(
          metadataPath,
          `${metadataPath}::${generationIndex % 2 ? "B" : "A"}`
        );
      }

      expect(thumbService.getDebugSnapshot()).toMatchObject({
        memoryEntries: 0,
        memoryBytes: 0,
        ownerEntries: 0,
        trackedTasks: 0,
      });
      expect(thumbService.getDebugSnapshot().metadataEntries).toBeLessThanOrEqual(
        maxMetadataEntries
      );
      expect(thumbService.getDebugSnapshot().signatureEntries).toBeLessThanOrEqual(
        maxMetadataEntries
      );

      thumbService.resetGeneration();
      expect(thumbService.getDebugSnapshot()).toMatchObject({
        queued: 0,
        pendingStates: 0,
        metadataEntries: 0,
        signatureEntries: 0,
        ownerEntries: 0,
        trackedTasks: 0,
      });
    }
  });
});
