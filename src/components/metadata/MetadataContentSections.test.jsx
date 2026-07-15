import React, { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  MetadataFileFactsSection,
  MetadataGenerationSection,
  MetadataTagsSection,
} from "./MetadataContentSections";

describe("reusable metadata content sections", () => {
  it("renders optional relative file context without requiring the inspector shell", () => {
    render(
      <MetadataFileFactsSection
        includeRelativePath
        info={{
          filename: "clip.mp4",
          relativePath: "run-a/clip.mp4",
          resolution: "512×288",
        }}
      />
    );
    expect(screen.getByText("clip.mp4")).toBeInTheDocument();
    expect(screen.getByText("run-a/clip.mp4")).toBeInTheDocument();
    expect(screen.getByText("512×288")).toBeInTheDocument();
  });

  it("renders generation state and delegates refresh", () => {
    const onRefresh = vi.fn();
    render(
      <MetadataGenerationSection
        state={{
          found: true,
          cached: true,
          metadata: { prompt: "A fox", model: "wan2.2", seed: "9" },
          onRefresh,
        }}
      />
    );
    expect(screen.getByText("A fox")).toBeInTheDocument();
    expect(screen.getByText("wan2.2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("forwards its editor ref and keeps explicit tag targets", () => {
    const inputRef = createRef();
    const onAddTag = vi.fn();
    const onRemoveTag = vi.fn();
    const onApplyTagToSelection = vi.fn();
    render(
      <MetadataTagsSection
        ref={inputRef}
        selectedVideos={[
          { tags: ["shared", "some"] },
          { tags: ["shared"] },
        ]}
        selectionCount={2}
        availableTags={[{ name: "popular", usageCount: 8 }]}
        resetKey="selection-a"
        onAddTag={onAddTag}
        onRemoveTag={onRemoveTag}
        onApplyTagToSelection={onApplyTagToSelection}
      />
    );

    expect(inputRef.current).toBe(
      screen.getByPlaceholderText("Add tag and press Enter")
    );
    fireEvent.click(screen.getByText("#shared"));
    fireEvent.click(screen.getByText("#some"));
    fireEvent.click(screen.getByText("#popular"));
    expect(onRemoveTag).toHaveBeenCalledWith("shared");
    expect(onApplyTagToSelection).toHaveBeenCalledWith("some");
    expect(onApplyTagToSelection).toHaveBeenCalledWith("popular");

    fireEvent.change(inputRef.current, { target: { value: "new, second" } });
    fireEvent.keyDown(inputRef.current, { key: "Enter" });
    expect(onAddTag).toHaveBeenCalledWith(["new", "second"]);
  });

  it("keeps the ordinary inspector suggestion set capped at 15", () => {
    const availableTags = Array.from({ length: 20 }, (_, index) => ({
      name: `tag-${String(index).padStart(2, "0")}`,
      usageCount: 20 - index,
    }));
    const { container } = render(
      <MetadataTagsSection
        selectedVideos={[{ tags: [] }]}
        selectionCount={1}
        availableTags={availableTags}
      />
    );

    expect(screen.getByText("Popular tags (up to 15)")).toBeInTheDocument();
    expect(container.querySelectorAll(".metadata-panel__suggestion")).toHaveLength(
      15
    );
    expect(screen.getByText("#tag-00")).toBeInTheDocument();
    expect(screen.queryByText("#tag-15")).not.toBeInTheDocument();
  });
});
