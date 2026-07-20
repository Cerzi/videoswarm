import React, { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MetadataInspectorContent from "./MetadataInspectorContent";

const singleVideo = {
  id: "clip-one",
  instanceId: 7,
  name: "clip-one.mp4",
  fingerprint: "fingerprint-one",
  dimensions: { width: 1280, height: 720 },
  rating: 3,
  reviewState: "pick",
  tags: ["favorite"],
};

describe("MetadataInspectorContent", () => {
  it("renders the extracted details body and forwards rating and review actions", () => {
    const onSetRating = vi.fn();
    const onClearRating = vi.fn();
    const onSetReviewState = vi.fn();

    render(
      <MetadataInspectorContent
        selectionCount={1}
        selectedVideos={[singleVideo]}
        selectionKey="clip-one"
        onSetRating={onSetRating}
        onClearRating={onClearRating}
        onSetReviewState={onSetReviewState}
      />
    );

    expect(screen.getByText("clip-one.mp4")).toBeVisible();
    expect(screen.getByText("1280×720")).toBeVisible();
    expect(screen.getByText("3 / 5")).toBeVisible();
    expect(screen.getByRole("button", { name: "Accept" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    fireEvent.click(screen.getByRole("button", { name: "Rate 5 stars" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    expect(onSetRating).toHaveBeenCalledWith(5);
    expect(onClearRating).toHaveBeenCalledOnce();
    expect(onSetReviewState).toHaveBeenCalledWith("reject");
  });

  it("forwards controlled generation disclosure and the bounded suggestion limit", () => {
    const onGenerationExpandedChange = vi.fn();
    const props = {
      selectionCount: 1,
      selectedVideos: [{ ...singleVideo, tags: [] }],
      selectionKey: "clip-one",
      suggestionLimit: 2,
      availableTags: [
        { name: "highest", usageCount: 9 },
        { name: "second", usageCount: 7 },
        { name: "hidden", usageCount: 5 },
      ],
      generationMetadataState: {
        found: true,
        metadata: { prompt: "A prompt that starts collapsed" },
      },
      generationExpanded: false,
      onGenerationExpandedChange,
    };
    const rendered = render(<MetadataInspectorContent {...props} />);

    expect(screen.queryByText("A prompt that starts collapsed")).toBeNull();
    expect(screen.getByText("Popular tags (up to 2)")).toBeVisible();
    expect(screen.getByText("#highest")).toBeVisible();
    expect(screen.getByText("#second")).toBeVisible();
    expect(screen.queryByText("#hidden")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Expand Generation details" })
    );
    expect(onGenerationExpandedChange).toHaveBeenCalledWith(true);
    expect(screen.queryByText("A prompt that starts collapsed")).toBeNull();

    rendered.rerender(
      <MetadataInspectorContent {...props} generationExpanded />
    );
    expect(screen.getByText("A prompt that starts collapsed")).toBeVisible();
  });

  it("preserves mixed batch semantics and exposes the tag input ref", () => {
    const inputRef = createRef();
    const onApplyTagToSelection = vi.fn();
    render(
      <MetadataInspectorContent
        ref={inputRef}
        selectionCount={2}
        selectedVideos={[
          { ...singleVideo, tags: ["shared", "partial"] },
          {
            ...singleVideo,
            id: "clip-two",
            name: "clip-two.mp4",
            rating: null,
            reviewState: "reject",
            tags: ["shared"],
          },
        ]}
        availableTags={[{ name: "popular", usageCount: 2 }]}
        onApplyTagToSelection={onApplyTagToSelection}
      />
    );

    expect(screen.getAllByText("Mixed")).toHaveLength(2);
    expect(screen.queryByText("clip-one.mp4")).toBeNull();
    expect(screen.queryByRole("button", {
      name: /Generation details/,
    })).toBeNull();
    expect(inputRef.current).toBe(
      screen.getByPlaceholderText("Add tag and press Enter")
    );

    fireEvent.click(screen.getByTitle("Apply to all (1/2)"));
    expect(onApplyTagToSelection).toHaveBeenCalledWith("partial");
  });
});
