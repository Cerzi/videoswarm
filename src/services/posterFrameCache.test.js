import { describe, expect, it, vi } from "vitest";
import { createPosterFrameCache } from "./posterFrameCache";

const makeVideo = ({ width = 544, height = 960, readyState = 4 } = {}) => {
  const element = document.createElement("video");
  Object.defineProperty(element, "videoWidth", { value: width });
  Object.defineProperty(element, "videoHeight", { value: height });
  Object.defineProperty(element, "readyState", { value: readyState });
  document.body.append(element);
  return element;
};

const flush = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

function setup(options = {}) {
  const idle = [];
  const canvases = [];
  let urlSequence = 0;
  const revoked = [];
  const cache = createPosterFrameCache({
    scheduleIdle: (callback) => idle.push(callback),
    createCanvas: (width, height) => {
      const canvas = {
        width,
        height,
        drawn: null,
        getContext: () => ({
          drawImage: (source, x, y, w, h) => {
            canvas.drawn = { source, w, h };
          },
        }),
        convertToBlob: vi.fn(async ({ type }) => ({
          size: options.blobSize ?? 1000,
          type,
        })),
      };
      canvases.push(canvas);
      return canvas;
    },
    createObjectURL: () => `blob:poster-${++urlSequence}`,
    revokeObjectURL: (url) => revoked.push(url),
    ...options,
  });
  const runIdle = async () => {
    while (idle.length) {
      idle.shift()();
      await flush();
    }
  };
  return { cache, canvases, revoked, runIdle, idle };
}

describe("posterFrameCache", () => {
  it("captures a scaled JPEG once per signature in idle time", async () => {
    const { cache, canvases, runIdle } = setup();
    const video = makeVideo();

    expect(cache.capture("sig-a", video)).toBe(true);
    expect(cache.capture("sig-a", video)).toBe(false);
    expect(cache.get("sig-a")).toBeNull();

    await runIdle();
    expect(cache.get("sig-a")).toBe("blob:poster-1");
    expect(canvases).toHaveLength(1);
    expect(canvases[0]).toMatchObject({ width: 480, height: 847 });
    expect(canvases[0].drawn).toMatchObject({ source: video, w: 480, h: 847 });
    expect(canvases[0].convertToBlob).toHaveBeenCalledWith({
      type: "image/jpeg",
      quality: 0.72,
    });

    expect(cache.capture("sig-a", video)).toBe(false);
  });

  it("skips detached or frameless elements", async () => {
    const { cache, runIdle } = setup();
    const detached = makeVideo();
    detached.remove();
    const empty = makeVideo({ readyState: 1 });

    cache.capture("detached", detached);
    cache.capture("empty", empty);
    await runIdle();

    expect(cache.get("detached")).toBeNull();
    expect(cache.get("empty")).toBeNull();
  });

  it("evicts least recently used frames by count and bytes, revoking them", async () => {
    const { cache, revoked, runIdle } = setup({ maxEntries: 2, blobSize: 1000 });
    for (const signature of ["a", "b"]) {
      cache.capture(signature, makeVideo());
      await runIdle();
    }
    expect(cache.get("a")).toBe("blob:poster-1"); // a is now most recent

    cache.capture("c", makeVideo());
    await runIdle();
    expect(cache.get("b")).toBeNull();
    expect(revoked).toEqual(["blob:poster-2"]);
    expect(cache.getSnapshot()).toMatchObject({ entries: 2, bytes: 2000 });

    const bytes = setup({ maxBytes: 2500, blobSize: 1000 });
    for (const signature of ["x", "y", "z"]) {
      bytes.cache.capture(signature, makeVideo());
      await bytes.runIdle();
    }
    expect(bytes.cache.getSnapshot()).toMatchObject({ entries: 2, bytes: 2000 });
    expect(bytes.cache.get("x")).toBeNull();
  });

  it("bounds pending captures, keeping the newest", async () => {
    const { cache, runIdle } = setup({ maxPending: 2 });
    cache.capture("first", makeVideo());
    cache.capture("second", makeVideo());
    cache.capture("third", makeVideo());
    expect(cache.getSnapshot().pending).toBe(2);

    await runIdle();
    expect(cache.get("first")).toBeNull();
    expect(cache.get("second")).not.toBeNull();
    expect(cache.get("third")).not.toBeNull();
  });

  it("captures a bigger card's frame wider, replacing the smaller one", async () => {
    const { cache, canvases, revoked, runIdle } = setup({ blobSize: 1000 });
    const original = makeVideo({ width: 1920, height: 1080 });

    cache.capture("sig", original);
    await runIdle();
    expect(canvases[0]).toMatchObject({ width: 480, height: 270 });

    // A card asking for no more than it has is already served.
    expect(cache.capture("sig", original, 400)).toBe(false);

    expect(cache.capture("sig", original, 1120)).toBe(true);
    await runIdle();
    expect(canvases[1]).toMatchObject({ width: 1120, height: 630 });
    expect(cache.get("sig")).toBe("blob:poster-2");
    expect(revoked).toEqual(["blob:poster-1"]);
    expect(cache.getSnapshot()).toMatchObject({ entries: 1, bytes: 1000 });

    // Never wider than the largest width; a smaller card keeps the big frame.
    expect(cache.capture("sig", original, 4000)).toBe(true);
    await runIdle();
    expect(canvases[2]).toMatchObject({ width: 1280, height: 720 });
    expect(cache.capture("sig", original, 480)).toBe(false);
  });

  it("lets the original replace a frame taken from a smaller proxy", async () => {
    const { cache, canvases, runIdle } = setup();
    const proxy = makeVideo({ width: 405, height: 720 });
    const original = makeVideo({ width: 1080, height: 1920 });

    cache.capture("sig", proxy, 640);
    await runIdle();
    expect(canvases[0]).toMatchObject({ width: 405, height: 720 });
    expect(cache.capture("sig", proxy, 640)).toBe(false);

    expect(cache.capture("sig", original, 640)).toBe(true);
    await runIdle();
    expect(canvases[1]).toMatchObject({ width: 640, height: 1138 });
  });

  it("widens a queued capture instead of queueing it twice", async () => {
    const { cache, canvases, runIdle } = setup();
    const video = makeVideo({ width: 1920, height: 1080 });
    cache.capture("sig", video);
    expect(cache.capture("sig", video, 480)).toBe(false);
    expect(cache.capture("sig", video, 960)).toBe(true);
    expect(cache.getSnapshot().pending).toBe(1);
    await runIdle();
    expect(canvases).toHaveLength(1);
    expect(canvases[0].width).toBe(960);
  });

  it("does no capture work while suspended and drops a cleared generation", async () => {
    const { cache, runIdle, canvases, idle } = setup();
    cache.capture("queued", makeVideo());
    cache.setSuspended(true);
    expect(cache.capture("refused", makeVideo())).toBe(false);
    await runIdle();
    expect(canvases).toHaveLength(0);
    expect(cache.getSnapshot().pending).toBe(0);

    cache.setSuspended(false);
    cache.capture("late", makeVideo());
    idle.shift()(); // the capture starts; its encode is still in flight
    cache.clear();
    await flush();
    expect(canvases).toHaveLength(1);
    expect(cache.get("late")).toBeNull();
    expect(cache.getSnapshot().entries).toBe(0);
  });
});
