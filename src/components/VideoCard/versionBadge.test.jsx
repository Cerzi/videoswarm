import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  it("opens the versions side by side from the pill, without selecting the card", () => {
    const onOpenVersions = vi.fn();
    const onSelect = vi.fn();
    render(
      <VideoCard {...baseProps()} versionCount={3} onOpenVersions={onOpenVersions} onSelect={onSelect} />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Show the 3 versions of this generation side by side" })
    );
    expect(onOpenVersions).toHaveBeenCalledWith("clip");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows a version's size, and where it lives, in the versions view", () => {
    render(
      <VideoCard
        {...baseProps()}
        versionCount={3}
        versionLabel="Best · 1920×1080"
        versionLocation="finals/a.mp4"
      />
    );
    const pill = screen.getByText("Best · 1920×1080");
    expect(pill.getAttribute("title")).toBe("finals/a.mp4");
    expect(pill.tagName).toBe("DIV");
    expect(screen.queryByText("3 versions")).toBeNull();
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

describe("VideoCard companion chip", () => {
  it("shows the companion's own label, tone and reasons", () => {
    render(
      <VideoCard
        {...baseProps()}
        companionChips={[
          { key: "c1", label: "Waiting #3", tone: "progress", title: "Polish: Third in line" },
        ]}
      />
    );
    const chip = screen.getByText("Waiting #3");
    expect(chip.className).toMatch(/video-item-companion--progress/);
    expect(chip.getAttribute("title")).toBe("Polish: Third in line");
    expect(chip.style.top).toBe("8px");
  });

  it("sits below the review and version pills", () => {
    const props = baseProps();
    render(
      <VideoCard
        {...props}
        video={{ ...props.video, reviewState: "pick" }}
        versionCount={2}
        companionChips={[
          { key: "c1", label: "Done", tone: "done", title: "Done" },
          { key: "c2", label: "In a video", tone: "info", title: "In a video" },
        ]}
      />
    );
    expect(screen.getByText("Done").style.top).toBe("52px");
    // One chip per companion app, stacked.
    expect(screen.getByText("In a video").style.top).toBe("74px");
  });

  it("shows nothing without chips", () => {
    render(<VideoCard {...baseProps()} />);
    expect(document.querySelector(".video-item-companion")).toBeNull();
  });
});

describe("VideoCard stack strip", () => {
  const strip = [
    { id: "s1", src: "data:image/jpeg;base64,AAAA" },
    { id: "s2", src: null },
  ];

  it("shows the strip's stills and how many more, and opens the stack at a still", async () => {
    const onOpenStack = vi.fn();
    const { container } = render(
      <VideoCard {...baseProps()} stackCount={6} stackTotal={6} stackStrip={strip} onOpenStack={onOpenStack} />
    );
    const stills = screen.getAllByRole("button", { name: "Open the stack at this clip" });
    expect(stills).toHaveLength(2);
    expect(container.querySelectorAll(".video-item-stack-still img")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "+3" })).toBeInTheDocument();

    const { fireEvent } = await import("@testing-library/react");
    fireEvent.mouseEnter(stills[0]);
    // The still shows over the header until the clip plays (StackPeek).
    expect(container.querySelector(".video-item-stack-peek img")?.getAttribute("src")).toBe(strip[0].src);
    fireEvent.mouseLeave(container.querySelector(".video-item-stack-strip"));
    expect(container.querySelector(".video-item-stack-peek")).toBeNull();

    fireEvent.click(stills[1]);
    expect(onOpenStack).toHaveBeenCalledWith("clip", "s2");
    fireEvent.click(screen.getByRole("button", { name: "+3" }));
    expect(onOpenStack).toHaveBeenLastCalledWith("clip");
  });

  it("shows no strip on a card that is not a stack", () => {
    const { container } = render(<VideoCard {...baseProps()} stackStrip={strip} />);
    expect(container.querySelector(".video-item-stack-strip")).toBeNull();
  });
});

describe("VideoCard one-click companion buttons", () => {
  const quickActions = [
    { key: "c1/polish", companionId: "c1", actionId: "polish", label: "Polish", title: "Send to polish" },
  ];

  it("shows the buttons only while the pointer is over the card, and sends without selecting", () => {
    const onQuickAction = vi.fn();
    const onSelect = vi.fn();
    const { container } = render(
      <VideoCard {...baseProps()} quickActions={quickActions} onQuickAction={onQuickAction} onSelect={onSelect} />
    );
    const card = container.querySelector(".video-item");
    expect(screen.queryByRole("button", { name: "Polish" })).toBeNull();
    fireEvent.mouseEnter(card);
    const button = screen.getByRole("button", { name: "Polish" });
    expect(button).toHaveAttribute("title", "Send to polish");
    fireEvent.click(button);
    expect(onQuickAction).toHaveBeenCalledWith("clip", "c1", "polish");
    expect(onSelect).not.toHaveBeenCalled();
    // Clicked once: not again until the pointer comes back.
    expect(button).toBeDisabled();
    fireEvent.mouseLeave(card);
    expect(screen.queryByRole("button", { name: "Polish" })).toBeNull();
  });

  it("shows no buttons on a card without them", () => {
    const { container } = render(<VideoCard {...baseProps()} onQuickAction={vi.fn()} />);
    fireEvent.mouseEnter(container.querySelector(".video-item"));
    expect(container.querySelector(".video-item-quick")).toBeNull();
  });
});

describe("VideoCard clicks", () => {
  it("keeps a later single click single after its callbacks change", () => {
    vi.useFakeTimers();
    try {
      const onSelect = vi.fn();
      const props = baseProps();
      const { container, rerender } = render(
        <VideoCard {...props} onSelect={onSelect} cancelQueuedLoadSlot={vi.fn()} />
      );
      const card = container.querySelector(".video-item");
      fireEvent.click(card);
      // New callbacks re-run the card's cleanup while it stays mounted.
      rerender(<VideoCard {...props} onSelect={onSelect} cancelQueuedLoadSlot={vi.fn()} />);
      vi.advanceTimersByTime(400);
      fireEvent.click(card);
      expect(onSelect.mock.calls.map((call) => call[3])).toEqual([false, false]);
    } finally {
      vi.useRealTimers();
    }
  });
});
