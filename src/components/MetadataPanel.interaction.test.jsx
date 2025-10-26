import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import MetadataPanel from "./MetadataPanel";

function Harness({ selectionCount }) {
  return (
    <MetadataPanel
      isOpen
      onToggle={() => {}}
      selectionCount={selectionCount}
      selectedVideos={selectionCount ? [{ tags: [] }] : []}
      availableTags={[]}
      onAddTag={() => {}}
      onRemoveTag={() => {}}
      onApplyTagToSelection={() => {}}
      onSetRating={() => {}}
      onClearRating={() => {}}
      focusToken={0}
      onFocusSelection={() => {}}
    />
  );
}

describe("MetadataPanel input toggle", () => {
  it("re-enables input when selection returns", () => {
    const { rerender } = render(<Harness selectionCount={1} />);
    const input = screen.getByPlaceholderText("Add tag and press Enter");
    expect(input).not.toBeDisabled();

    rerender(<Harness selectionCount={0} />);
    expect(
      screen.queryByPlaceholderText("Add tag and press Enter")
    ).not.toBeInTheDocument();

    rerender(<Harness selectionCount={2} />);
    expect(screen.getByPlaceholderText("Add tag and press Enter")).not.toBeDisabled();
  });
});
