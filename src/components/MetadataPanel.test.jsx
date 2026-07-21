import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import MetadataPanel from "./MetadataPanel";

const rect = (left, top, width, height) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
  x: left,
  y: top,
});

const defaultGeometry = {
  resolveContainerRect: () => rect(0, 0, 1100, 760),
  resolveBoundsRect: () => rect(0, 0, 1100, 760),
  resolveAnchorRect: () => rect(480, 110, 180, 160),
};

const panelProps = (props = {}) => ({
  isOpen: true,
  onClose: vi.fn(),
  selectionCount: props.selectionCount ?? props.selectedVideos?.length ?? 0,
  selectedVideos: props.selectedVideos ?? [],
  availableTags: [],
  anchorId: "selected-clip",
  ...defaultGeometry,
  ...props,
});

const renderPanel = (props = {}) =>
  render(<MetadataPanel {...panelProps(props)} />);

const readPosition = (element) => {
  const match = element.style.transform.match(
    /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/
  );
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
};

const dispatchPointer = (target, type, properties) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.entries(properties).forEach(([key, value]) => {
    Object.defineProperty(event, key, { configurable: true, value });
  });
  fireEvent(target, event);
};

describe("MetadataPanel floating shell", () => {
  it("renders nothing while closed or when the selection is empty", () => {
    const closed = render(
      <MetadataPanel
        {...panelProps({
          isOpen: false,
          selectedVideos: [{ name: "clip-one.mp4" }],
        })}
      />
    );
    expect(closed.container.firstChild).toBeNull();
    closed.unmount();

    const empty = render(
      <MetadataPanel {...panelProps({ selectedVideos: [], selectionCount: 0 })} />
    );
    expect(empty.container.firstChild).toBeNull();
  });

  it("is a named non-modal complementary surface with an explicit close button", () => {
    const onClose = vi.fn();
    renderPanel({
      selectedVideos: [{ name: "clip-one.mp4" }],
      onClose,
    });

    expect(
      screen.getByRole("complementary", { name: "Selection details" })
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Close selection details" })
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers an optional dock action without changing the floating shell", () => {
    const onDock = vi.fn();
    const { rerender } = renderPanel({
      selectedVideos: [{ name: "clip-one.mp4" }],
      onDock,
    });

    const dockButton = screen.getByRole("button", {
      name: "Dock selection details in sidebar",
    });
    expect(dockButton).toHaveClass("metadata-panel__button", "metadata-panel__button--dock");
    expect(dockButton.querySelector("svg")).toBeInTheDocument();
    fireEvent.click(dockButton);
    expect(onDock).toHaveBeenCalledOnce();

    rerender(
      <MetadataPanel
        {...panelProps({ selectedVideos: [{ name: "clip-one.mp4" }] })}
      />
    );
    expect(
      screen.queryByRole("button", {
        name: "Dock selection details in sidebar",
      })
    ).toBeNull();
  });

  it("closes on Escape only when keyboard events come from inside it", () => {
    const onClose = vi.fn();
    renderPanel({
      selectedVideos: [{ name: "clip-one.mp4" }],
      onClose,
    });

    const input = screen.getByPlaceholderText("Add tag and press Enter");
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("updates its content and clears stale tag input with the selection", () => {
    const { rerender } = renderPanel({
      selectionKey: "first",
      selectedVideos: [{ name: "first.mp4" }],
    });
    const input = screen.getByPlaceholderText("Add tag and press Enter");
    fireEvent.change(input, { target: { value: "unfinished" } });

    rerender(
      <MetadataPanel
        {...panelProps({
          selectionKey: "second",
          selectedVideos: [{ name: "second.mp4" }],
        })}
      />
    );

    expect(screen.queryByText("first.mp4")).not.toBeInTheDocument();
    expect(screen.getByText("second.mp4")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Add tag and press Enter")).toHaveValue("");
  });

  it("does not steal focus on a passive open but honors an explicit focus token", () => {
    const { rerender } = renderPanel({
      selectionKey: "first",
      selectedVideos: [{ name: "first.mp4" }],
      focusToken: 7,
    });
    const input = screen.getByPlaceholderText("Add tag and press Enter");
    expect(input).not.toHaveFocus();

    rerender(
      <MetadataPanel
        {...panelProps({
          selectionKey: "first",
          selectedVideos: [{ name: "first.mp4" }],
          focusToken: 8,
        })}
      />
    );
    expect(input).toHaveFocus();

    rerender(
      <MetadataPanel
        {...panelProps({
          isOpen: false,
          selectionKey: "first",
          selectedVideos: [{ name: "first.mp4" }],
          focusToken: 8,
        })}
      />
    );
    rerender(
      <MetadataPanel
        {...panelProps({
          selectionKey: "first",
          selectedVideos: [{ name: "first.mp4" }],
          focusToken: 8,
        })}
      />
    );
    expect(screen.getByPlaceholderText("Add tag and press Enter")).not.toHaveFocus();
  });

  it("moves in bounded keyboard steps and Home restores automatic placement", () => {
    renderPanel({ selectedVideos: [{ name: "clip-one.mp4" }] });
    const titlebar = screen.getByRole("group", { name: "Move selection details" });
    const panel = document.querySelector(".metadata-panel__container");
    const initial = readPosition(panel);

    fireEvent.keyDown(titlebar, { key: "ArrowRight" });
    const arrowPosition = readPosition(panel);
    expect(arrowPosition.x - initial.x).toBe(16);

    fireEvent.keyDown(titlebar, { key: "ArrowDown", shiftKey: true });
    const shiftedPosition = readPosition(panel);
    expect(shiftedPosition.y - arrowPosition.y).toBe(48);

    fireEvent.keyDown(titlebar, { key: "Home" });
    expect(readPosition(panel)).toEqual(initial);
  });

  it("coalesces pointer dragging, commits the bounded result, and cleans up", () => {
    const { unmount } = renderPanel({
      selectedVideos: [{ name: "clip-one.mp4" }],
    });
    const titlebar = screen.getByRole("group", { name: "Move selection details" });
    const panel = document.querySelector(".metadata-panel__container");
    const initial = readPosition(panel);

    dispatchPointer(titlebar, "pointerdown", {
      pointerId: 3,
      pointerType: "mouse",
      button: 0,
      isPrimary: true,
      clientX: 500,
      clientY: 130,
    });
    expect(document.body).toHaveClass("metadata-panel-drag-active");
    dispatchPointer(window, "pointermove", {
      pointerId: 3,
      clientX: 620,
      clientY: 210,
    });
    dispatchPointer(window, "pointerup", {
      pointerId: 3,
      clientX: 620,
      clientY: 210,
    });

    const moved = readPosition(panel);
    expect(moved.x).toBeGreaterThan(initial.x);
    expect(moved.y).toBeGreaterThan(initial.y);
    expect(document.body).not.toHaveClass("metadata-panel-drag-active");

    dispatchPointer(titlebar, "pointerdown", {
      pointerId: 4,
      pointerType: "mouse",
      button: 0,
      isPrimary: true,
      clientX: 620,
      clientY: 210,
    });
    unmount();
    expect(document.body).not.toHaveClass("metadata-panel-drag-active");
  });

  it("uses a non-draggable bottom sheet in a narrow gallery", () => {
    renderPanel({
      selectedVideos: [{ name: "clip-one.mp4" }],
      resolveContainerRect: () => rect(0, 0, 500, 600),
      resolveBoundsRect: () => rect(0, 0, 500, 600),
      resolveAnchorRect: () => rect(120, 80, 180, 160),
    });

    const inspector = screen.getByRole("complementary", {
      name: "Selection details",
    });
    const titlebar = screen.getByRole("group", { name: "Move selection details" });
    const panel = document.querySelector(".metadata-panel__container");
    expect(inspector).toHaveClass("metadata-panel--sheet");
    expect(titlebar).toHaveAttribute("aria-disabled", "true");
    expect(panel).toHaveAttribute("data-placement-side", "sheet");
    expect(panel.style.width).toBe("484px");

    const initial = panel.style.transform;
    fireEvent.keyDown(titlebar, { key: "ArrowRight" });
    expect(panel.style.transform).toBe(initial);
  });
});

describe("MetadataPanel single-selection info", () => {
  const formatExpectedDate = (value) =>
    new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(value);

  it("shows filename, creation date with seconds, and resolution", () => {
    const createdDate = new Date("2023-04-05T14:03:02Z");
    renderPanel({
      selectedVideos: [
        {
          name: "clip-one.mp4",
          metadata: { dateCreated: createdDate.toISOString() },
          dimensions: { width: 1920, height: 1080 },
        },
      ],
    });

    expect(screen.getByText("clip-one.mp4")).toBeInTheDocument();
    expect(screen.getByText(formatExpectedDate(createdDate))).toBeInTheDocument();
    expect(screen.getByText("1920×1080")).toBeInTheDocument();
    expect(screen.queryByText("Filename")).not.toBeInTheDocument();
  });

  it("formats the raw created timestamp used by cached folder previews", () => {
    const createdDate = new Date("2024-06-07T08:09:10Z");
    renderPanel({
      selectedVideos: [
        {
          name: "cached-clip.mp4",
          createdMs: createdDate.getTime(),
          dimensions: { width: 512, height: 288 },
        },
      ],
    });

    expect(screen.getByText(formatExpectedDate(createdDate))).toBeInTheDocument();
  });

  it("omits unavailable identifying details and hides them for a batch", () => {
    const { rerender } = renderPanel({
      selectedVideos: [{ metadata: {}, dimensions: { width: 0, height: 0 } }],
    });
    expect(document.querySelector(".metadata-panel__info-line")).toBeNull();

    rerender(
      <MetadataPanel
        {...panelProps({
          selectionCount: 2,
          selectedVideos: [
            { name: "one.mp4", dimensions: { width: 1920, height: 1080 } },
            { name: "two.mp4", dimensions: { width: 1280, height: 720 } },
          ],
        })}
      />
    );
    expect(document.querySelector(".metadata-panel__info-line")).toBeNull();
  });
});

describe("MetadataPanel tag input", () => {
  it("autocompletes to the closest existing tag on Tab", () => {
    const handleAddTag = vi.fn();
    renderPanel({
      selectedVideos: [{ name: "clip-one.mp4" }],
      availableTags: [
        { name: "dog", usageCount: 5 },
        { name: "doughnut", usageCount: 2 },
      ],
      onAddTag: handleAddTag,
    });

    const input = screen.getByPlaceholderText("Add tag and press Enter");
    fireEvent.change(input, { target: { value: "do" } });
    fireEvent.keyDown(input, { key: "Tab", code: "Tab" });
    expect(handleAddTag).toHaveBeenCalledWith(["dog"]);
    expect(input).toHaveValue("");
  });

  it("does not create a new tag when Tab has no match", () => {
    const handleAddTag = vi.fn();
    renderPanel({
      selectedVideos: [{ name: "clip-one.mp4" }],
      availableTags: [{ name: "cat", usageCount: 1 }],
      onAddTag: handleAddTag,
    });

    const input = screen.getByPlaceholderText("Add tag and press Enter");
    fireEvent.change(input, { target: { value: "do" } });
    fireEvent.keyDown(input, { key: "Tab", code: "Tab" });
    expect(handleAddTag).not.toHaveBeenCalled();
    expect(input).toHaveValue("do");
  });
});

describe("MetadataPanel review state", () => {
  it("shows a mixed batch and applies a pick to the selection", () => {
    const onSetReviewState = vi.fn();
    renderPanel({
      selectedVideos: [
        { name: "one.mp4", reviewState: "pick" },
        { name: "two.mp4", reviewState: "reject" },
      ],
      onSetReviewState,
    });

    expect(screen.getByText("Mixed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(onSetReviewState).toHaveBeenCalledWith("pick");
  });

  it("defaults old records to unreviewed", () => {
    renderPanel({ selectedVideos: [{ name: "one.mp4" }] });
    expect(screen.getByText("Rating")).toHaveAttribute(
      "title",
      expect.stringContaining("marks an Unreviewed clip as Reviewed")
    );
    const unreviewed = screen.getByRole("button", { name: "Unreviewed" });
    expect(unreviewed).toHaveAttribute("aria-pressed", "true");
    expect(unreviewed).toHaveAttribute(
      "title",
      expect.stringContaining("clears rating, keeps tags")
    );
  });
});

describe("MetadataPanel generation metadata", () => {
  it("shows bounded extracted generation fields for one clip", () => {
    renderPanel({
      selectedVideos: [{ name: "one.mp4", instanceId: 7 }],
      generationMetadataState: {
        loading: false,
        found: true,
        cached: true,
        metadata: {
          prompt: "a bee flying over a city",
          seed: "9007199254740993",
          models: ["wan2.2"],
          samplers: ["euler"],
          generationRun: "run-42",
        },
        onRefresh: vi.fn(),
      },
    });

    expect(screen.getByText("a bee flying over a city")).toBeInTheDocument();
    expect(screen.getByText("9007199254740993")).toBeInTheDocument();
    expect(screen.getByText("wan2.2")).toBeInTheDocument();
    expect(screen.getByText("Cached")).toBeInTheDocument();
  });

  it("reports missing embedded and adjacent metadata without guessing across the folder", () => {
    renderPanel({
      selectedVideos: [{ name: "one.mp4", instanceId: 7 }],
      generationMetadataState: { loading: false, found: false, metadata: null },
    });
    expect(
      screen.getByText(
        "No embedded generation metadata or adjacent JSON sidecar was found."
      )
    ).toBeInTheDocument();
  });
});
