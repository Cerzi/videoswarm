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

  it("offers Move/Copy for the selection in the docked pane", () => {
    const onTransferSelection = vi.fn();
    const second = { ...video, id: "clip-b", name: "clip-b.mp4" };
    render(
      <DockedMetadataInspector
        selectionCount={2}
        selectedVideos={[video, second]}
        onTransferSelection={onTransferSelection}
        onUndock={vi.fn()}
      />
    );

    const transfer = screen.getByRole("button", {
      name: "Move or copy 2 selected clips",
    });
    fireEvent.click(transfer);
    // The docked pane hands over the same selection the floating one does.
    expect(onTransferSelection).toHaveBeenCalledWith([video, second]);
  });

  it("omits Move/Copy when no transfer handler is supplied", () => {
    render(
      <DockedMetadataInspector
        selectionCount={1}
        selectedVideos={[video]}
        onUndock={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: /Move or copy/i })).toBeNull();
  });
});
