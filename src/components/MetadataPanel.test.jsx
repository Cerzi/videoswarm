import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MetadataPanel from "./MetadataPanel";

const buildBaseProps = (overrides = {}) => ({
  isOpen: true,
  onToggle: vi.fn(),
  selectionCount: 1,
  selectedVideos: [{ id: "1", tags: [] }],
  availableTags: [],
  onAddTag: vi.fn(),
  onRemoveTag: vi.fn(),
  onApplyTagToSelection: vi.fn(),
  onSetRating: vi.fn(),
  onClearRating: vi.fn(),
  focusToken: 0,
  ...overrides,
});

describe("MetadataPanel", () => {

  it("renders a focus button when selection is available", () => {
    const handleScroll = vi.fn();
    render(
      <MetadataPanel
        {...buildBaseProps()}
        onScrollToSelection={handleScroll}
      />
    );

    const focusButton = screen.getByRole("button", {
      name: "Focus selected video",
    });

    fireEvent.click(focusButton);
    expect(handleScroll).toHaveBeenCalledTimes(1);
  });

  it("updates focus button label when multiple videos selected", () => {
    const handleScroll = vi.fn();
    render(
      <MetadataPanel
        {...buildBaseProps({
          selectionCount: 3,
          selectedVideos: [
            { id: "1", tags: [] },
            { id: "2", tags: [] },
            { id: "3", tags: [] },
          ],
        })}
        onScrollToSelection={handleScroll}
      />
    );

    expect(
      screen.getByRole("button", {
        name: "Focus next selected video",
      })
    ).toBeInTheDocument();
  });

  it("omits focus button when selection missing", () => {
    render(
      <MetadataPanel
        {...buildBaseProps({ selectionCount: 0, selectedVideos: [] })}
        onScrollToSelection={vi.fn()}
      />
    );

    expect(
      screen.queryByRole("button", { name: /Focus selected video/i })
    ).toBeNull();
  });
});
