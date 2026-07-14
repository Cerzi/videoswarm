import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import VideoCard from "./VideoCard";
import { createMediaSlotScheduler } from "../../services/mediaSlotScheduler";

const nativeCreateElement = document.createElement.bind(document);

const makeScrollRootRef = () => ({
  current: {
    getBoundingClientRect: () => ({
      top: 0,
      bottom: 1000,
      left: 0,
      right: 1600,
      width: 1600,
      height: 1000,
    }),
  },
});

const schedulerProps = (scheduler) => ({
  reserveLoadSlot: (id, options) => scheduler.reserveLoader(id, options),
  queueLoadSlot: (id, options, onGranted) =>
    scheduler.queueLoader(id, options, onGranted),
  cancelQueuedLoadSlot: (lease) => scheduler.cancelQueuedLoader(lease),
  finishLoadSlot: (lease, { ready }) =>
    ready ? scheduler.markLoaderReady(lease) : scheduler.failLoader(lease),
  releaseMediaSlot: (lease) => scheduler.releaseMedia(lease),
});

const cardProps = (scheduler, overrides = {}) => {
  const { video: videoOverride = {}, ...otherOverrides } = overrides;
  return {
    selected: false,
    video: {
      id: "video",
      name: "video.mp4",
      fullPath: "/video.mp4",
      isElectronFile: true,
      sourceUrl: "videoswarm-media://instance/1?v=scheduler-test",
      ...videoOverride,
    },
    isPlaying: false,
    isLoaded: false,
    isLoading: false,
    isVisible: true,
    showFilenames: false,
    scrollRootRef: makeScrollRootRef(),
    scheduleInit: (start) => start(),
    onStartLoading: vi.fn(),
    onStopLoading: vi.fn(),
    onVideoLoad: vi.fn(),
    onVideoPlay: vi.fn(() => true),
    onVideoPause: vi.fn(() => true),
    onPlayError: vi.fn(() => true),
    ...schedulerProps(scheduler),
    ...otherOverrides,
  };
};

describe("VideoCard scheduler integration", () => {
  let mediaElements;
  let originalRaf;
  let originalCaf;

  beforeEach(() => {
    mediaElements = [];
    originalRaf = globalThis.requestAnimationFrame;
    originalCaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => {
      callback(0);
      return 0;
    };
    globalThis.cancelAnimationFrame = vi.fn();
    vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
      const element = nativeCreateElement(tag, options);
      if (tag !== "video") return element;
      element.load = vi.fn();
      element.pause = vi.fn();
      element.play = vi.fn().mockResolvedValue(undefined);
      mediaElements.push(element);
      return element;
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCaf;
    vi.restoreAllMocks();
  });

  it("automatically advances a denied visible card when a loader frees", async () => {
    const scheduler = createMediaSlotScheduler({
      maxResident: 2,
      maxLoaders: 1,
      maxDecoders: 1,
    });

    render(
      <>
        <VideoCard
          {...cardProps(scheduler, {
            video: {
              id: "first",
              name: "first.mp4",
              fullPath: "/first.mp4",
              isElectronFile: true,
            },
          })}
        />
        <VideoCard
          {...cardProps(scheduler, {
            video: {
              id: "second",
              name: "second.mp4",
              fullPath: "/second.mp4",
              isElectronFile: true,
            },
          })}
        />
      </>
    );
    await act(async () => {});

    expect(mediaElements).toHaveLength(1);
    expect(scheduler.getSnapshot()).toMatchObject({
      loading: 1,
      queuedLoading: 1,
    });

    await act(async () => {
      mediaElements[0].dispatchEvent(new Event("loadeddata"));
      await Promise.resolve();
    });

    expect(mediaElements).toHaveLength(2);
    expect(mediaElements[1].dataset.videoId).toBe("second");
    expect(scheduler.getSnapshot()).toMatchObject({
      loading: 1,
      queuedLoading: 0,
      resident: 1,
    });
  });

  it("keeps the loader deadline after a card scrolls out of view", async () => {
    vi.useFakeTimers();
    const scheduler = createMediaSlotScheduler({
      maxResident: 1,
      maxLoaders: 1,
      maxDecoders: 1,
    });
    const onPlayError = vi.fn((_id, _error, _decoder, mediaLease) => {
      expect(scheduler.isCurrentMediaLease(mediaLease)).toBe(true);
      return true;
    });
    const initialProps = cardProps(scheduler, { onPlayError });
    const rendered = render(<VideoCard {...initialProps} />);
    await act(async () => {});
    const element = mediaElements[0];

    rendered.rerender(<VideoCard {...initialProps} isVisible={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_100);
    });

    expect(onPlayError).toHaveBeenCalledOnce();
    expect(scheduler.getSnapshot()).toMatchObject({
      loading: 0,
      resident: 0,
    });
    expect(element.getAttribute("src")).toBeNull();
    expect(element.pause).toHaveBeenCalled();
  });

  it("physically detaches resident media and releases its slot while work is suspended", async () => {
    const scheduler = createMediaSlotScheduler({
      maxResident: 1,
      maxLoaders: 1,
      maxDecoders: 1,
    });
    const onMediaInvalidated = vi.fn();
    const props = cardProps(scheduler, {
      video: {
        id: "suspended-card",
        name: "suspended-card.mp4",
        fullPath: "/suspended-card.mp4",
        isElectronFile: true,
      },
      onMediaInvalidated,
    });
    const rendered = render(<VideoCard {...props} />);
    await act(async () => {});
    const element = mediaElements[0];

    await act(async () => element.dispatchEvent(new Event("loadeddata")));
    expect(scheduler.getSnapshot()).toMatchObject({
      loading: 0,
      resident: 1,
    });
    expect(element.getAttribute("src")).not.toBeNull();

    rendered.rerender(<VideoCard {...props} workSuspended />);
    await act(async () => {});

    expect(element.pause).toHaveBeenCalled();
    expect(element.getAttribute("src")).toBeNull();
    expect(element.isConnected).toBe(false);
    expect(scheduler.getSnapshot()).toMatchObject({
      loading: 0,
      queuedLoading: 0,
      resident: 0,
      decoders: 0,
    });
    expect(onMediaInvalidated).toHaveBeenCalledWith("suspended-card");
    expect(mediaElements).toHaveLength(1);
  });

  it("rejects low-readiness runtime recovery before releasing its exact leases", async () => {
    const scheduler = createMediaSlotScheduler({
      maxResident: 1,
      maxLoaders: 1,
      maxDecoders: 1,
    });
    let decoderLease = null;
    const onPlayError = vi.fn((_id, _error, reportedDecoder, mediaLease) => {
      expect(reportedDecoder).toBe(decoderLease);
      expect(scheduler.getDecoderLease("runtime")).toBe(decoderLease);
      expect(scheduler.isCurrentMediaLease(mediaLease)).toBe(true);
      scheduler.requestDecoderStop(decoderLease);
      return true;
    });
    const initialProps = cardProps(scheduler, {
      video: {
        id: "runtime",
        name: "runtime.mp4",
        fullPath: "/runtime.mp4",
        isElectronFile: true,
      },
      onPlayError,
    });
    const rendered = render(<VideoCard {...initialProps} />);
    await act(async () => {});
    const element = mediaElements[0];
    await act(async () => element.dispatchEvent(new Event("loadeddata")));

    decoderLease = scheduler.reserveDecoder("runtime");
    rendered.rerender(
      <VideoCard
        {...initialProps}
        isLoaded
        isPlaying
        decoderLease={decoderLease}
      />
    );
    Object.defineProperty(element, "error", {
      configurable: true,
      value: { code: 2, message: "network read failed" },
    });

    await act(async () => {
      element.dispatchEvent(new Event("error"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onPlayError).toHaveBeenCalledOnce();
    expect(scheduler.getSnapshot()).toMatchObject({
      resident: 0,
      decoders: 0,
    });
    expect(element.getAttribute("src")).toBeNull();
  });

  it("cancels a same-id queued generation before granting its replacement", async () => {
    const scheduler = createMediaSlotScheduler({
      maxResident: 2,
      maxLoaders: 1,
      maxDecoders: 1,
    });
    const blocker = scheduler.reserveLoader("blocker");
    const oldVideo = {
      id: "same",
      name: "old.mp4",
      fullPath: "/old.mp4",
      isElectronFile: true,
      sourceUrl: "videoswarm-media://instance/2?v=old",
      size: 1,
      dateModified: 1,
    };
    const props = cardProps(scheduler, { video: oldVideo });
    const rendered = render(<VideoCard {...props} />);
    await act(async () => {});
    expect(scheduler.getSnapshot().queuedLoading).toBe(1);

    rendered.rerender(
      <VideoCard
        {...props}
        video={{
          ...oldVideo,
          name: "new.mp4",
          fullPath: "/new.mp4",
          sourceUrl: "videoswarm-media://instance/2?v=new",
          size: 2,
          dateModified: 2,
        }}
      />
    );
    await act(async () => {});
    expect(scheduler.getSnapshot().queuedLoading).toBe(1);

    await act(async () => {
      scheduler.markLoaderReady(blocker);
      await Promise.resolve();
    });

    expect(mediaElements).toHaveLength(1);
    expect(mediaElements[0].src).toContain("v=new");
    expect(mediaElements[0].src).not.toContain("v=old");
  });

  it("invalidates a same-file element when only its opaque source changes", async () => {
    const scheduler = createMediaSlotScheduler({
      maxResident: 2,
      maxLoaders: 1,
      maxDecoders: 1,
    });
    const initialVideo = {
      id: "same-source",
      name: "same.mp4",
      fullPath: "/same.mp4",
      isElectronFile: true,
      instanceId: 9,
      sourceUrl: "videoswarm-media://instance/9?v=old&g=1",
      size: 100,
      dateModified: 10,
    };
    const props = cardProps(scheduler, { video: initialVideo });
    const rendered = render(<VideoCard {...props} />);
    await act(async () => {});
    expect(mediaElements).toHaveLength(1);
    const oldElement = mediaElements[0];
    expect(oldElement.src).toContain("v=old");

    rendered.rerender(
      <VideoCard
        {...props}
        video={{
          ...initialVideo,
          sourceUrl: "videoswarm-media://instance/9?v=new&g=1",
        }}
      />
    );
    await act(async () => {});

    expect(oldElement.getAttribute("src")).toBeNull();
    expect(mediaElements).toHaveLength(2);
    expect(mediaElements[1].src).toContain("v=new");
  });

  it("pauses physically before acknowledging a decoder handoff", async () => {
    const scheduler = createMediaSlotScheduler({
      maxResident: 1,
      maxLoaders: 1,
      maxDecoders: 1,
    });
    let element = null;
    const onVideoPause = vi.fn((_id, lease) => {
      if (!lease) return false;
      expect(element.pause).toHaveBeenCalled();
      return scheduler.acknowledgeDecoderStopped(lease);
    });
    const props = cardProps(scheduler, {
      video: {
        id: "handoff",
        name: "handoff.mp4",
        fullPath: "/handoff.mp4",
        isElectronFile: true,
      },
      onVideoPause,
    });
    const rendered = render(<VideoCard {...props} />);
    await act(async () => {});
    element = mediaElements[0];
    await act(async () => element.dispatchEvent(new Event("loadeddata")));
    const decoderLease = scheduler.reserveDecoder("handoff");

    rendered.rerender(
      <VideoCard {...props} isLoaded isPlaying decoderLease={decoderLease} />
    );
    await act(async () => {});
    element.pause.mockClear();
    onVideoPause.mockClear();
    scheduler.requestDecoderStop(decoderLease);

    rendered.rerender(
      <VideoCard {...props} isLoaded isPlaying={false} decoderLease={decoderLease} />
    );
    await act(async () => {});

    expect(element.pause).toHaveBeenCalled();
    expect(onVideoPause).toHaveBeenCalledWith("handoff", decoderLease);
    expect(element.pause.mock.invocationCallOrder[0]).toBeLessThan(
      onVideoPause.mock.invocationCallOrder[0]
    );
    expect(scheduler.getSnapshot().decoders).toBe(0);
  });

  it("ignores a delayed pause event after a replacement decoder starts", async () => {
    const scheduler = createMediaSlotScheduler({
      maxResident: 1,
      maxLoaders: 1,
      maxDecoders: 1,
    });
    const onVideoPause = vi.fn((_id, lease) =>
      lease ? scheduler.acknowledgeDecoderStopped(lease) : false
    );
    const props = cardProps(scheduler, {
      video: {
        id: "pause-race",
        name: "pause-race.mp4",
        fullPath: "/pause-race.mp4",
        isElectronFile: true,
      },
      onVideoPause,
    });
    const rendered = render(<VideoCard {...props} />);
    await act(async () => {});
    const element = mediaElements[0];
    await act(async () => element.dispatchEvent(new Event("loadeddata")));

    const firstLease = scheduler.reserveDecoder("pause-race");
    rendered.rerender(
      <VideoCard {...props} isLoaded isPlaying decoderLease={firstLease} />
    );
    await act(async () => {});

    scheduler.requestDecoderStop(firstLease);
    rendered.rerender(
      <VideoCard
        {...props}
        isLoaded
        isPlaying={false}
        decoderLease={firstLease}
      />
    );
    await act(async () => {});
    expect(scheduler.getDecoderLease("pause-race")).toBeNull();

    const replacementLease = scheduler.reserveDecoder("pause-race");
    rendered.rerender(
      <VideoCard
        {...props}
        isLoaded
        isPlaying
        decoderLease={replacementLease}
      />
    );
    await act(async () => {});
    onVideoPause.mockClear();

    await act(async () => element.dispatchEvent(new Event("pause")));

    expect(onVideoPause).not.toHaveBeenCalled();
    expect(scheduler.getDecoderLease("pause-race")).toBe(replacementLease);
  });

  it("ignores a rejected play promise from a revoked decoder effect", async () => {
    const scheduler = createMediaSlotScheduler({
      maxResident: 1,
      maxLoaders: 1,
      maxDecoders: 1,
    });
    let rejectPlay;
    const onPlayError = vi.fn(() => true);
    const onVideoPause = vi.fn((_id, lease) =>
      lease ? scheduler.acknowledgeDecoderStopped(lease) : false
    );
    const props = cardProps(scheduler, {
      video: {
        id: "stale-play",
        name: "stale-play.mp4",
        fullPath: "/stale-play.mp4",
        isElectronFile: true,
      },
      onPlayError,
      onVideoPause,
    });
    const rendered = render(<VideoCard {...props} />);
    await act(async () => {});
    const element = mediaElements[0];
    await act(async () => element.dispatchEvent(new Event("loadeddata")));
    const decoderLease = scheduler.reserveDecoder("stale-play");
    element.play.mockImplementationOnce(
      () => new Promise((_, reject) => { rejectPlay = reject; })
    );

    rendered.rerender(
      <VideoCard {...props} isLoaded isPlaying decoderLease={decoderLease} />
    );
    await act(async () => {});
    scheduler.requestDecoderStop(decoderLease);
    rendered.rerender(
      <VideoCard {...props} isLoaded isPlaying={false} decoderLease={decoderLease} />
    );
    await act(async () => {});

    await act(async () => {
      rejectPlay(new Error("old decoder rejected"));
      await Promise.resolve();
    });

    expect(onPlayError).not.toHaveBeenCalled();
    expect(scheduler.getSnapshot().resident).toBe(1);
    expect(element.getAttribute("src")).not.toBeNull();
  });
});
