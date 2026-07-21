import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionIds } from "../../hooks/actions/actions";
import {
  FullscreenDetailsDock,
  FullscreenHeaderActions,
  FullscreenHeaderContent,
  FullscreenReviewRail,
} from "./FullscreenReviewPanels";

const video = {
  id: "clip-1",
  name: "clip.mp4",
  relativePath: "run-a/clip.mp4",
  isElectronFile: true,
  fingerprint: "fp-1",
  reviewState: "unreviewed",
  rating: null,
  tags: ["candidate"],
};

describe("FullscreenReviewPanels", () => {
  it("targets review, rating, undo, and auto-advance controls", () => {
    const onSetReviewState = vi.fn();
    const onSetRating = vi.fn();
    const onUndo = vi.fn();
    const onAutoAdvanceChange = vi.fn();
    render(
      <FullscreenReviewRail
        video={video}
        canUndo
        onSetReviewState={onSetReviewState}
        onSetRating={onSetRating}
        onUndo={onUndo}
        onAutoAdvanceChange={onAutoAdvanceChange}
      />
    );

    expect(screen.getByRole("button", { name: "Accept (A)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reviewed (S)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject (D)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unreviewed (F)" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Accept (A)" }));
    fireEvent.click(screen.getByRole("button", { name: "Rate 4 stars" }));
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /advance after marking/i }));

    expect(onSetReviewState).toHaveBeenCalledWith("pick");
    expect(onSetRating).toHaveBeenCalledWith(4);
    expect(onUndo).toHaveBeenCalledOnce();
    expect(onAutoAdvanceChange).toHaveBeenCalledWith(true);
  });

  it("keeps rating available while review mode controls and status are hidden", () => {
    const onSetRating = vi.fn();
    render(
      <>
        <FullscreenHeaderContent video={video} reviewModeEnabled={false} />
        <FullscreenReviewRail
          video={video}
          reviewModeEnabled={false}
          onSetRating={onSetRating}
        />
      </>
    );

    expect(screen.queryByText("Unreviewed")).toBeNull();
    expect(screen.queryByRole("button", { name: "Accept (A)" })).toBeNull();
    expect(screen.queryByRole("button", { name: /undo/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Rate 4 stars" }));
    expect(onSetRating).toHaveBeenCalledWith(4);
  });

  it("offers only non-destructive utilities and renders catalog help", () => {
    const onSurfaceChange = vi.fn();
    const onSafeAction = vi.fn();
    const rendered = render(
      <FullscreenHeaderActions
        video={video}
        surface="actions"
        onSurfaceChange={onSurfaceChange}
        onSafeAction={onSafeAction}
        onRetry={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Copy path" }));
    expect(onSafeAction).toHaveBeenCalledWith(ActionIds.COPY_PATH);
    expect(screen.queryByText(/trash/i)).toBeNull();

    rendered.rerender(
      <FullscreenHeaderActions
        video={video}
        surface="help"
        onSurfaceChange={onSurfaceChange}
        onSafeAction={onSafeAction}
      />
    );
    expect(screen.getByRole("dialog", { name: "Fullscreen shortcuts" })).toBeTruthy();
    expect(screen.getByText("Review current clip")).toBeTruthy();
    expect(screen.getByText("Mute or enable audio")).toBeTruthy();
  });

  it("shows rating help without review-state help when review mode is off", () => {
    render(
      <FullscreenHeaderActions
        video={video}
        surface="help"
        onSurfaceChange={vi.fn()}
        onSafeAction={vi.fn()}
        reviewModeEnabled={false}
      />
    );

    expect(screen.getByText("Rate current clip")).toBeVisible();
    expect(screen.getByText("Set star rating")).toBeVisible();
    expect(screen.queryByText("Mark as Accept")).toBeNull();
  });

  it("reuses file, generation, and tag sections in the dock", () => {
    const onRemoveTag = vi.fn();
    render(
      <FullscreenDetailsDock
        video={video}
        availableTags={[{ name: "favorite", usageCount: 5 }]}
        generationMetadataState={{
          found: true,
          metadata: { prompt: "sunrise", model: "Wan2.2", seed: 42 },
        }}
        onAddTags={vi.fn()}
        onRemoveTag={onRemoveTag}
        onApplyTag={vi.fn()}
      />
    );

    expect(screen.getByText("run-a/clip.mp4")).toBeTruthy();
    expect(screen.getByText("sunrise")).toBeTruthy();
    expect(screen.getByText("Wan2.2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /candidate/i }));
    expect(onRemoveTag).toHaveBeenCalledWith("candidate");
  });

  it("offers a larger bounded popular-tag set in the details dock", () => {
    const availableTags = Array.from({ length: 120 }, (_, index) => ({
      name: `tag-${String(index).padStart(3, "0")}`,
      usageCount: 120 - index,
    }));
    const { container } = render(
      <FullscreenDetailsDock
        video={video}
        availableTags={availableTags}
        onAddTags={vi.fn()}
        onRemoveTag={vi.fn()}
        onApplyTag={vi.fn()}
      />
    );

    expect(screen.getByText("Popular tags (up to 100)")).toBeTruthy();
    expect(container.querySelectorAll(".metadata-panel__suggestion")).toHaveLength(
      100
    );
    expect(screen.getByText("#tag-000")).toBeTruthy();
    expect(screen.queryByText("#tag-100")).toBeNull();
  });
});
