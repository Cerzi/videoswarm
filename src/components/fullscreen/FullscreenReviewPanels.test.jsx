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
  it("targets review, rating, undo, and contextual advance controls", () => {
    const onSetReviewState = vi.fn();
    const onSetRating = vi.fn();
    const onUndo = vi.fn();
    const onAdvanceAfterReviewingChange = vi.fn();
    const onAdvanceAfterRatingChange = vi.fn();
    const onAdvanceAfterSendingChange = vi.fn();
    render(
      <FullscreenReviewRail
        video={video}
        canUndo
        canSend
        onSetReviewState={onSetReviewState}
        onSetRating={onSetRating}
        onUndo={onUndo}
        onAdvanceAfterReviewingChange={onAdvanceAfterReviewingChange}
        onAdvanceAfterRatingChange={onAdvanceAfterRatingChange}
        onAdvanceAfterSendingChange={onAdvanceAfterSendingChange}
      />
    );

    expect(screen.getByRole("button", { name: "Accept (A)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reviewed (S)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject (D)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unreviewed (F)" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Accept (A)" }));
    fireEvent.click(screen.getByRole("button", { name: "Rate 4 stars" }));
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /advance after reviewing/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /advance after rating/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /advance after sending/i }));

    expect(onSetReviewState).toHaveBeenCalledWith("pick");
    expect(onSetRating).toHaveBeenCalledWith(4);
    expect(onUndo).toHaveBeenCalledOnce();
    expect(onAdvanceAfterReviewingChange).toHaveBeenCalledWith(true);
    expect(onAdvanceAfterRatingChange).toHaveBeenCalledWith(true);
    expect(onAdvanceAfterSendingChange).toHaveBeenCalledWith(true);
  });

  it("shows companion chips and one-click buttons for the clip on screen", () => {
    const onQuickAction = vi.fn();
    const chips = [{ key: "c1", label: "Waiting #2", tone: "progress", title: "Finish: second in line" }];
    const buttons = [
      { key: "c1/finish", companionId: "c1", actionId: "finish", label: "Finish", title: "Finish it", shortcut: "Shift+1" },
      { key: "c1/enlarge", companionId: "c1", actionId: "enlarge", label: "Enlarge", title: "Enlarge it" },
    ];
    const rail = (clip) => (
      <FullscreenReviewRail
        video={clip}
        companionChips={chips}
        quickActions={buttons}
        onQuickAction={onQuickAction}
      />
    );
    const { rerender } = render(rail(video));

    expect(screen.getByText("Waiting #2")).toHaveAttribute("title", "Finish: second in line");
    const finish = screen.getByRole("button", { name: "Finish" });
    expect(finish).toHaveAttribute("title", "Finish it, and accept it (Shift+1)");
    expect(finish.querySelector("kbd")?.textContent).toBe("⇧1");
    expect(screen.getByRole("button", { name: "Enlarge" }).querySelector("kbd")).toBeNull();

    // One click sends once; the next clip gets fresh buttons.
    fireEvent.click(finish);
    fireEvent.click(finish);
    expect(onQuickAction).toHaveBeenCalledTimes(1);
    expect(onQuickAction).toHaveBeenCalledWith("c1", "finish");
    expect(finish).toBeDisabled();
    rerender(rail({ ...video, id: "clip-2" }));
    expect(screen.getByRole("button", { name: "Finish" })).not.toBeDisabled();
  });

  it("shows no companion section with nothing to show", () => {
    render(<FullscreenReviewRail video={video} />);
    expect(screen.queryByLabelText("Companion apps")).toBeNull();
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
    expect(screen.queryByRole("checkbox", { name: /advance after reviewing/i })).toBeNull();
    expect(screen.getByRole("checkbox", { name: /advance after rating/i })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /advance after sending/i })).toBeNull();
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
    expect(screen.queryByText("Accept")).toBeNull();
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

  it("shows the same short popular-tag set as the other inspectors", () => {
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

    expect(screen.getByText(/Popular tags · type above to find any other/)).toBeTruthy();
    expect(container.querySelectorAll(".metadata-panel__suggestion")).toHaveLength(
      15
    );
    expect(screen.getByText("#tag-000")).toBeTruthy();
    expect(screen.queryByText("#tag-015")).toBeNull();
  });

  it("shows tag matches under the input in the fullscreen dock", () => {
    const onAddTags = vi.fn();
    render(
      <FullscreenDetailsDock
        video={{ id: "clip", name: "clip.mp4", tags: [] }}
        availableTags={[{ name: "favorite", usageCount: 5 }]}
        onAddTags={onAddTags}
        onRemoveTag={vi.fn()}
        onApplyTag={vi.fn()}
      />
    );
    const input = screen.getByPlaceholderText("Add tag and press Enter");
    fireEvent.change(input, { target: { value: "fav" } });
    // The matches belong to the tags section itself, which the dock never
    // shrinks, unlike the separate suggestions section.
    const list = screen.getByRole("listbox", { name: "Matching tags" });
    expect(list.closest(".metadata-panel__section--tags")).not.toBeNull();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAddTags).toHaveBeenCalledWith(["favorite"]);
  });
});
