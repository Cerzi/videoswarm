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
