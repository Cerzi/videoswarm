import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import HeaderBar from "./HeaderBar";

describe("HeaderBar render cap control", () => {
  const baseProps = {
    isLoadingFolder: false,
    handleFolderSelect: vi.fn(),
    handleWebFileSelection: vi.fn(),
    recursiveMode: false,
    toggleRecursive: vi.fn(),
    showFilenames: true,
    toggleFilenames: vi.fn(),
    renderCapValue: 150,
    renderCapMin: 100,
    renderCapMax: 300,
    renderCapLabel: "Rendered: 150",
    onRenderCapChange: vi.fn(),
    renderCapDisabled: false,
    renderCapTooltip: "tooltip",
    zoomLevel: 2,
    handleZoomChangeSafe: vi.fn(),
    getMinimumZoomLevel: vi.fn(() => 0),
    sortKey: "name",
    sortSelection: "name-asc",
    groupByFolders: false,
    onSortChange: vi.fn(),
    onGroupByFoldersToggle: vi.fn(),
    onReshuffle: vi.fn(),
    recentFolders: [],
    onRecentOpen: vi.fn(),
    hasOpenFolder: false,
    onFiltersToggle: vi.fn(),
    filtersActiveCount: 0,
    filtersAreOpen: false,
    filtersButtonRef: { current: null },
    onOpenAbout: vi.fn(),
  };

  it("displays the render cap slider with correct bounds", () => {
    render(<HeaderBar {...baseProps} />);

    const slider = screen.getByLabelText("Maximum rendered cards");
    expect(slider).toHaveAttribute("min", "100");
    expect(slider).toHaveAttribute("max", "300");
    expect(slider).toHaveValue("150");
    expect(screen.getByText("Rendered: 150")).toBeInTheDocument();
  });

  it("calls the change handler with numeric values", () => {
    const onRenderCapChange = vi.fn();
    render(<HeaderBar {...baseProps} onRenderCapChange={onRenderCapChange} />);

    const slider = screen.getByLabelText("Maximum rendered cards");
    fireEvent.change(slider, { target: { value: "200" } });
    expect(onRenderCapChange).toHaveBeenCalledWith(200);
  });
});
