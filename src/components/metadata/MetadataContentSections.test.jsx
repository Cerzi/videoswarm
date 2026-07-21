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
          sourceKind: "embedded",
          quality: "direct",
          metadata: {
            prompt: "A fox",
            negativePrompt: "blurry",
            model: "wan2.2",
            seed: "9",
            loras: [
              { name: "detail.safetensors", strengthModel: 0.8, strengthClip: 1 },
            ],
            sampling: { scheduler: "normal", steps: 20, cfg: 4.5 },
          },
          onRefresh,
        }}
      />
    );
    expect(screen.getByText("A fox")).toBeInTheDocument();
    expect(screen.getByText("blurry")).toBeInTheDocument();
    expect(screen.getByText("wan2.2")).toBeInTheDocument();
    expect(screen.getByText("Embedded")).toBeInTheDocument();
    expect(screen.getByText("Direct")).toBeInTheDocument();
    expect(
      screen.getByText("detail.safetensors (model 0.8, CLIP 1)")
    ).toBeInTheDocument();
    expect(screen.getByText("20")).toBeInTheDocument();
    const reread = screen.getByRole("button", { name: "Re-read" });
    expect(reread).toHaveClass("metadata-panel__button");
    expect(reread.querySelector("svg")).toBeInTheDocument();
    fireEvent.click(reread);
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("defaults generation details open and keeps header actions available while collapsed", () => {
    const onRefresh = vi.fn();
    render(
      <MetadataGenerationSection
        state={{
          found: true,
          cached: true,
          sourceKind: "embedded",
          metadata: { prompt: "A long generation prompt" },
          onRefresh,
        }}
      />
    );

    const collapse = screen.getByRole("button", {
      name: "Collapse Generation details",
    });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    expect(collapse).toHaveAttribute("aria-controls");
    expect(screen.getByText("A long generation prompt")).toBeInTheDocument();

    fireEvent.click(collapse);

    const expand = screen.getByRole("button", {
      name: "Expand Generation details",
    });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("A long generation prompt")).not.toBeInTheDocument();
    expect(screen.getByText("Embedded")).toBeInTheDocument();
    expect(screen.getByText("Cached")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Re-read" }));
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(screen.getByText("A long generation prompt")).toBeInTheDocument();
  });

  it("supports host-controlled generation disclosure state", () => {
    const onExpandedChange = vi.fn();
    const state = {
      found: true,
      metadata: { prompt: "Controlled prompt" },
    };
    const rendered = render(
      <MetadataGenerationSection
        state={state}
        expanded={false}
        onExpandedChange={onExpandedChange}
      />
    );

    const expand = screen.getByRole("button", {
      name: "Expand Generation details",
    });
    fireEvent.click(expand);
    expect(onExpandedChange).toHaveBeenCalledWith(true);
    expect(screen.queryByText("Controlled prompt")).not.toBeInTheDocument();

    rendered.rerender(
      <MetadataGenerationSection
        state={state}
        expanded
        onExpandedChange={onExpandedChange}
      />
    );
    expect(
      screen.getByRole("button", { name: "Collapse Generation details" })
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Controlled prompt")).toBeInTheDocument();
  });

  it("distinguishes unresolved embedded metadata from a true miss", () => {
    const { rerender } = render(
      <MetadataGenerationSection
        state={{ found: true, status: "unrecognized", metadata: {} }}
      />
    );
    expect(
      screen.getByText(
        "Generation metadata was found, but no supported fields could be resolved."
      )
    ).toBeInTheDocument();

    rerender(
      <MetadataGenerationSection
        state={{ found: false, status: "none", metadata: null }}
      />
    );
    expect(
      screen.getByText(
        "No embedded generation metadata or adjacent JSON sidecar was found."
      )
    ).toBeInTheDocument();
  });

  it("does not claim embedded metadata was absent when the reader is unavailable", () => {
    render(
      <MetadataGenerationSection
        state={{
          found: false,
          status: "none",
          readerAvailable: false,
          readerStatus: "unavailable",
          metadata: null,
        }}
      />
    );
    expect(
      screen.getByText(
        "Embedded metadata could not be checked on this system, and no adjacent JSON sidecar was found."
      )
    ).toBeInTheDocument();
  });

  it("explains a partial sidecar fallback without exposing native paths", () => {
    render(
      <MetadataGenerationSection
        state={{
          found: true,
          sourceKind: "sidecar",
          quality: "partial",
          readerAvailable: false,
          metadata: {
            promptFragments: [{
              text: "fragment one",
              role: "positive",
              classType: "CLIPTextEncode",
              nodeId: "17",
              composition: "conditioning-combine",
              confidence: "candidate",
            }],
            diagnostics: [{ code: "UNKNOWN_NODE_ON_PROMPT_PATH" }],
          },
        }}
      />
    );
    expect(screen.getByText("Sidecar fallback")).toBeInTheDocument();
    expect(screen.getByText("Partial")).toBeInTheDocument();
    expect(screen.getByText("fragment one")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Positive · CLIPTextEncode · node 17 · conditioning combine · candidate"
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The embedded metadata reader is unavailable; an adjacent sidecar was used."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/\/home\//)).not.toBeInTheDocument();
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
