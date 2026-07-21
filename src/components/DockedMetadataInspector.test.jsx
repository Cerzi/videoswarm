import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DockedMetadataInspector from "./DockedMetadataInspector";

const video = {
  id: "clip-a",
  name: "clip-a.mp4",
  fingerprint: "fingerprint-a",
  reviewState: "unreviewed",
  tags: [],
};

describe("DockedMetadataInspector", () => {
  it("renders the shared editor and dispatches exact selection actions", () => {
    const onSetReviewState = vi.fn();
    const onUndock = vi.fn();
    const onFocusSelection = vi.fn();
    render(
      <DockedMetadataInspector
        selectionCount={1}
        selectedVideos={[video]}
        onSetReviewState={onSetReviewState}
        onFocusSelection={onFocusSelection}
        onUndock={onUndock}
      />
    );

    expect(
      screen.getByRole("region", { name: "Docked selection details" })
    ).toHaveTextContent("clip-a.mp4");
    const focus = screen.getByRole("button", { name: "Focus selection in grid" });
    const undock = screen.getByRole("button", { name: "Undock selection details" });
    expect(focus).toHaveClass("metadata-panel__button", "metadata-panel__button--focus");
    expect(undock).toHaveClass("metadata-panel__button", "metadata-panel__button--dock");
    expect(focus.querySelector("svg")).toBeInTheDocument();
    expect(undock.querySelector("svg")).toBeInTheDocument();
    fireEvent.click(focus);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    fireEvent.click(undock);
    expect(onFocusSelection).toHaveBeenCalledOnce();
    expect(onSetReviewState).toHaveBeenCalledWith("pick");
    expect(onUndock).toHaveBeenCalledOnce();
  });

  it("does not retain an editor after selection clears", () => {
    const { container } = render(
      <DockedMetadataInspector selectionCount={0} selectedVideos={[]} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
