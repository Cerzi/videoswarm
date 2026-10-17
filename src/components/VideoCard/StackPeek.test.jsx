import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StackPeek from "./StackPeek";
import { createMediaSlotScheduler } from "../../services/mediaSlotScheduler";

const still = {
  id: "member",
  src: "data:image/jpeg;base64,AAAA",
  instanceId: 7,
  sourceUrl: "videoswarm-media://instance/7?v=peek",
};

const PROXY = "videoswarm-media://proxy/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?g=1";

describe("StackPeek", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete window.electronAPI;
  });

  it("plays the clip in the auxiliary lane, over its still, and gives the lane back", async () => {
    const scheduler = createMediaSlotScheduler({ maxAuxiliaryDecoders: 1 });
    const onPlayingChange = vi.fn();
    const { container, unmount } = render(
      <StackPeek still={still} scheduler={scheduler} onPlayingChange={onPlayingChange} />
    );
    await act(async () => {});
    const video = container.querySelector("video");
    expect(scheduler.getAuxiliaryDecoderLease("stack-peek:member")).toBeTruthy();
    expect(video.getAttribute("src")).toBe(still.sourceUrl);
    expect(video.muted).toBe(true);
    expect(container.querySelector("img").getAttribute("src")).toBe(still.src);
    expect(container.firstChild.className).not.toMatch(/is-playing/u);

    await act(async () => video.dispatchEvent(new Event("playing")));
    expect(container.firstChild.className).toMatch(/is-playing/u);
    expect(onPlayingChange).toHaveBeenLastCalledWith(true);

    unmount();
    expect(scheduler.getAuxiliaryDecoderLease("stack-peek:member")).toBeNull();
    expect(onPlayingChange).toHaveBeenLastCalledWith(false);
  });

  it("plays the proxy when proxies are on, with sound when hover audio is", async () => {
    const resolveSource = vi.fn(async () => ({ sourceUrl: PROXY, status: "ready" }));
    window.electronAPI = { playback: { resolveSource } };
    const scheduler = createMediaSlotScheduler({ maxAuxiliaryDecoders: 1 });
    const { container } = render(
      <StackPeek still={still} scheduler={scheduler} proxyPlaybackEnabled audible />
    );
    await act(async () => {});
    expect(resolveSource).toHaveBeenCalledWith({ instanceId: 7, sourceUrl: still.sourceUrl, enabled: true });
    const video = container.querySelector("video");
    expect(video.getAttribute("src")).toBe(PROXY);
    expect(video.muted).toBe(false);
  });

  it("shows only the still when the lane is taken or there is nothing to play", async () => {
    const scheduler = createMediaSlotScheduler({ maxAuxiliaryDecoders: 1 });
    const busy = scheduler.reserveAuxiliaryDecoder("frame-capture:1");
    const { container, rerender } = render(<StackPeek still={still} scheduler={scheduler} />);
    await act(async () => {});
    expect(container.querySelector("video").getAttribute("src")).toBeNull();
    expect(container.querySelector("img")).toBeTruthy();
    scheduler.releaseDecoder(busy);

    rerender(<StackPeek still={{ id: "web", src: null, sourceUrl: null }} scheduler={scheduler} />);
    await act(async () => {});
    expect(scheduler.getAuxiliaryDecoderLease("stack-peek:web")).toBeNull();
  });
});
