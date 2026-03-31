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
  renderLimitStep: 2,
  renderLimitLabel: "200",
  renderLimitMaxStep: 10,
  handleRenderLimitChange: vi.fn(),
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
};

describe("HeaderBar hover audio control", () => {
  it("renders as icon toggle in right interaction cluster, not left checkbox text", () => {
    const { container } = render(<HeaderBar {...baseProps} />);

    const hoverAudioButton = screen.getByRole("button", {
      name: "Play audio on hover",
    });
    expect(hoverAudioButton).toBeInTheDocument();
    expect(hoverAudioButton).toHaveAttribute("title", "Play audio on hover");

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

    const button = screen.getByRole("button", { name: "Play audio on hover" });
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

    const activeButton = screen.getByRole("button", { name: "Play audio on hover" });
    expect(activeButton).toHaveAttribute("aria-pressed", "true");
    expect(activeButton.className).toContain("active");
  });
});
