import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import VideoCard from "./VideoCard";
import { createMediaSlotScheduler } from "../../services/mediaSlotScheduler";

const baseProps = () => {
  const scheduler = createMediaSlotScheduler({ maxLoaders: 1, maxResident: 1 });
  return {
    selected: false,
    video: { id: "clip", name: "clip.mp4", fullPath: "/clip.mp4", isElectronFile: true },
    isPlaying: false,
    isLoaded: false,
    isLoading: false,
    isVisible: false,
    showFilenames: false,
    scrollRootRef: { current: null },
    scheduleInit: vi.fn(),
    reserveLoadSlot: (id, options) => scheduler.reserveLoader(id, options),
    queueLoadSlot: (id, options, onGranted) => scheduler.queueLoader(id, options, onGranted),
    cancelQueuedLoadSlot: (lease) => scheduler.cancelQueuedLoader(lease),
    finishLoadSlot: () => true,
    releaseMediaSlot: () => true,
  };
};

afterEach(cleanup);

describe("VideoCard generation versions badge", () => {
  it("shows nothing for a clip with one version", () => {
    render(<VideoCard {...baseProps()} versionCount={1} />);
    expect(screen.queryByText(/versions/)).toBeNull();
  });

  it("shows the version count and says whether a higher-resolution version exists", () => {
    const { rerender } = render(<VideoCard {...baseProps()} versionCount={3} />);
    const badge = screen.getByText("3 versions");
    expect(badge.getAttribute("title")).toMatch(/no higher-resolution version exists/);
    expect(badge.className).not.toMatch(/superseded/);

    rerender(<VideoCard {...baseProps()} versionCount={3} versionSuperseded />);
    const superseded = screen.getByText("3 versions");
    expect(superseded.getAttribute("title")).toMatch(/a higher-resolution version exists/);
    expect(superseded.className).toMatch(/video-item-versions--superseded/);
  });

  it("moves below the review pill when both are shown", () => {
    const props = baseProps();
    render(
      <VideoCard
        {...props}
        video={{ ...props.video, reviewState: "pick" }}
        versionCount={2}
      />
    );
    expect(screen.getByText("2 versions").className).toMatch(/with-review/);
  });
});
