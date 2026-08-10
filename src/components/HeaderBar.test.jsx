import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import HeaderBar from "./HeaderBar";

const baseProps = {
  isLoadingFolder: false,
  handleFolderSelect: vi.fn(),
  handleWebFileSelection: vi.fn(),
  recursiveMode: false,
  toggleRecursive: vi.fn(),
  showFilenames: true,
  toggleFilenames: vi.fn(),
  zoomLevel: 1,
  handleZoomChangeSafe: vi.fn(),
  getMinimumZoomLevel: vi.fn(() => 0),
  sortKey: "name",
  sortSelection: "name-asc",
  groupByFolders: true,
  onSortChange: vi.fn(),
  onGroupByFoldersToggle: vi.fn(),
  onReshuffle: vi.fn(),
  recentFolders: [],
  onRecentOpen: vi.fn(),
  hasOpenFolder: true,
  onFiltersToggle: vi.fn(),
  filtersActiveCount: 0,
  filtersAreOpen: false,
  filtersButtonRef: { current: null },
  hoverAudioEnabled: false,
  onHoverAudioToggle: vi.fn(),
  reviewModeEnabled: true,
  onReviewModeToggle: vi.fn(),
  playbackMode: "balanced",
  onPlaybackModeChange: vi.fn(),
  playbackDecision: { target: 2, safetyCap: 4, health: "healthy" },
  playbackCapabilityStatus:
    "Linux: acceleration detected, not guaranteed.",
  proxyPlaybackEnabled: false,
  onProxyPlaybackToggle: vi.fn(),
  proxyPlaybackAvailable: true,
  isRefreshingFolder: false,
  onHotkeyHelp: vi.fn(),
};

describe("HeaderBar hover audio control", () => {
  it("renders beside the filename toggle in the right interaction cluster", () => {
    const { container } = render(<HeaderBar {...baseProps} />);

    const hoverAudioButton = screen.getByRole("button", {
      name: "Player audio on hover",
    });
    expect(hoverAudioButton).toBeInTheDocument();
    expect(hoverAudioButton).toHaveAttribute("title", "Enable player audio on hover");
    expect(hoverAudioButton.previousElementSibling).toBe(
      screen.getByTitle("Show/hide filenames")
    );

    const navLeft = container.querySelector(".nav-left");
    expect(navLeft).toBeTruthy();
    expect(within(navLeft).queryByText("Hover audio")).toBeNull();
  });

  it("click toggles callback and active state is reflected", () => {
    const onHoverAudioToggle = vi.fn();
    const { rerender } = render(
      <HeaderBar
        {...baseProps}
        hoverAudioEnabled={false}
        onHoverAudioToggle={onHoverAudioToggle}
      />
    );

    const button = screen.getByRole("button", { name: "Player audio on hover" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button.className).not.toContain("active");

    fireEvent.click(button);
    expect(onHoverAudioToggle).toHaveBeenCalledTimes(1);

    rerender(
      <HeaderBar
        {...baseProps}
        hoverAudioEnabled={true}
        onHoverAudioToggle={onHoverAudioToggle}
      />
    );

    const activeButton = screen.getByRole("button", { name: "Player audio on hover" });
    expect(activeButton).toHaveAttribute("aria-pressed", "true");
    expect(activeButton.className).toContain("active");
  });
});

describe("HeaderBar review mode control", () => {
  it("exposes a compact persisted-mode toggle beside the view controls", () => {
    const onReviewModeToggle = vi.fn();
    render(
      <HeaderBar
        {...baseProps}
        reviewModeEnabled={false}
        onReviewModeToggle={onReviewModeToggle}
      />
    );
    const button = screen.getByRole("button", { name: "Review mode" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveAttribute("title", "Enable review mode");
    fireEvent.click(button);
    expect(onReviewModeToggle).toHaveBeenCalledOnce();
  });
});

describe("HeaderBar zoom control", () => {
  it("offers intermediate zoom levels without changing historic endpoints", () => {
    const handleZoomChangeSafe = vi.fn();
    render(
      <HeaderBar
        {...baseProps}
        zoomLevel={1}
        handleZoomChangeSafe={handleZoomChangeSafe}
      />
    );

    const zoom = screen.getByRole("slider", { name: "Grid zoom" });
    expect(zoom).toHaveAttribute("min", "0");
    expect(zoom).toHaveAttribute("max", "4");
    expect(zoom).toHaveAttribute("step", "0.5");
    expect(zoom).toHaveAttribute("aria-valuetext", "200px cards");

    fireEvent.change(zoom, { target: { value: "1.5" } });
    expect(handleZoomChangeSafe).toHaveBeenCalledWith(1.5);
  });
});

describe("HeaderBar playback policy control", () => {
  it("renders adaptive mode, target, Linux caveat, and proxy opt-in", () => {
    render(<HeaderBar {...baseProps} />);
    expect(screen.getByRole("combobox", { name: "Playback mode" })).toHaveValue(
      "balanced"
    );
    expect(screen.getByLabelText(/Playback target/)).toHaveTextContent(
      "2/4 decoders"
    );
    expect(screen.getByText(/detected, not guaranteed/i)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Use generated playback proxies" })
    );
    expect(baseProps.onProxyPlaybackToggle).toHaveBeenCalledOnce();
  });
});

describe("HeaderBar keyboard help and background refresh", () => {
  it("opens the shortcut guide from an accessible help button", () => {
    const onHotkeyHelp = vi.fn();
    render(<HeaderBar {...baseProps} onHotkeyHelp={onHotkeyHelp} />);

    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(onHotkeyHelp).toHaveBeenCalledOnce();
  });

  it("shows a subtle status while a cached folder is revalidated", () => {
    render(<HeaderBar {...baseProps} isRefreshingFolder />);
    expect(screen.getByRole("status")).toHaveTextContent("Refreshing index");
  });
});

describe("HeaderBar filter clearing", () => {
  it("offers no clear control until a filter is set", () => {
    render(<HeaderBar {...baseProps} filtersActiveCount={0} />);
    expect(screen.queryByRole("button", { name: /Clear .* filter/i })).toBeNull();
  });

  it("clears filters without opening the popover", () => {
    const onFiltersClear = vi.fn();
    const onFiltersToggle = vi.fn();
    render(
      <HeaderBar
        {...baseProps}
        onFiltersToggle={onFiltersToggle}
        onFiltersClear={onFiltersClear}
        filtersActiveCount={3}
      />
    );

    const clear = screen.getByRole("button", { name: "Clear 3 active filters" });
    fireEvent.click(clear);
    expect(onFiltersClear).toHaveBeenCalledTimes(1);
    // It is a sibling of the filters button, not nested inside it, so opening
    // the popover is not a side effect of clearing.
    expect(onFiltersToggle).not.toHaveBeenCalled();
  });

  it("singularises the label for one active filter", () => {
    render(
      <HeaderBar
        {...baseProps}
        onFiltersClear={vi.fn()}
        filtersActiveCount={1}
      />
    );
    expect(
      screen.getByRole("button", { name: "Clear 1 active filter" })
    ).toBeInTheDocument();
  });
});
