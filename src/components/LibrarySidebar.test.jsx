import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildFolderTree } from "../library/folderModel";
import LibrarySidebar from "./LibrarySidebar";

const videos = [
  { id: "a", dirname: "run-a", rating: 4 },
  { id: "nested", dirname: "run-a/seed-1", reviewed: true },
  { id: "b", dirname: "run-b", rating: null },
];
const tree = buildFolderTree({
  rootName: "outputs",
  directorySummaries: [
    { relativePath: "", name: "outputs" },
    { relativePath: "run-a", name: "run-a" },
    { relativePath: "run-a/seed-1", name: "seed-1" },
    { relativePath: "run-b", name: "run-b" },
    { relativePath: "empty", name: "empty" },
  ],
  videos,
  matchingVideos: [videos[0], videos[2]],
});

const pinnedRoots = [
  {
    id: 1,
    rootPath: "/models/wan/outputs",
    label: "Wan outputs",
    pinned: true,
  },
  {
    id: 2,
    rootPath: "/models/hunyuan/outputs",
    label: "Hunyuan outputs",
    pinned: true,
  },
];

describe("LibrarySidebar", () => {
  it("renders profile-provided pinned roots and forwards path-only open/pin intent", () => {
    const onOpenRoot = vi.fn();
    const onTogglePin = vi.fn();
    render(
      <LibrarySidebar
        tree={tree}
        currentRoot={pinnedRoots[0]}
        pinnedRoots={pinnedRoots}
        expandedPaths={new Set([""])}
        onOpenRoot={onOpenRoot}
        onTogglePin={onTogglePin}
      />
    );

    expect(screen.getByText("Wan outputs")).toBeVisible();
    expect(screen.getByText("/models/wan/outputs")).toBeVisible();
    fireEvent.click(screen.getByText("Hunyuan outputs"));
    expect(onOpenRoot).toHaveBeenCalledWith(
      "/models/hunyuan/outputs",
      pinnedRoots[1]
    );

    fireEvent.click(screen.getByRole("button", { name: "Unpin Hunyuan outputs" }));
    expect(onTogglePin).toHaveBeenCalledWith(
      "/models/hunyuan/outputs",
      false
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Unpin current library root" })
    );
    expect(onTogglePin).toHaveBeenCalledWith("/models/wan/outputs", false);
  });

  it("offers an explicit pin action for an unpinned current root", () => {
    const onTogglePin = vi.fn();
    render(
      <LibrarySidebar
        currentRoot={{ rootPath: "/new/root", label: "New", pinned: false }}
        onTogglePin={onTogglePin}
      />
    );

    const pin = screen.getByRole("button", { name: "Pin current library root" });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(pin);
    expect(onTogglePin).toHaveBeenCalledWith("/new/root", true);
  });

  it("mounts only expanded branches and forwards controlled expansion", () => {
    const onToggleExpanded = vi.fn();
    const props = {
      tree,
      currentPath: "run-a",
      expandedPaths: new Set([""]),
      onToggleExpanded,
      onSelectFolder: vi.fn(),
    };
    const { rerender } = render(<LibrarySidebar {...props} />);

    expect(screen.getByText("run-a")).toBeVisible();
    expect(screen.getByText("run-b")).toBeVisible();
    expect(screen.queryByText("seed-1")).toBeNull();
    expect(screen.getByTitle("run-a")).toHaveAttribute(
      "aria-current",
      "location"
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand run-a" }));
    expect(onToggleExpanded).toHaveBeenCalledWith("run-a", true);
    expect(screen.queryByText("seed-1")).toBeNull();

    rerender(
      <LibrarySidebar
        {...props}
        expandedPaths={new Set(["", "run-a"])}
      />
    );
    expect(screen.getByText("seed-1")).toBeVisible();
    expect(screen.getByRole("button", { name: "Collapse run-a" })).toBeVisible();
  });

  it("shows subtree match and reviewed counts and forwards folder selection", () => {
    const onSelectFolder = vi.fn();
    render(
      <LibrarySidebar
        tree={tree}
        currentPath=""
        expandedPaths={new Set(["", "run-a"])}
        onSelectFolder={onSelectFolder}
      />
    );

    const runAButton = screen.getByTitle("run-a");
    expect(runAButton).toHaveTextContent("1 match");
    expect(runAButton).toHaveTextContent("2/2");
    expect(screen.getByTitle("empty")).toHaveTextContent("0 match");

    fireEvent.click(runAButton);
    expect(onSelectFolder).toHaveBeenCalledWith(
      "run-a",
      expect.objectContaining({ path: "run-a" })
    );
  });

  it("shows missing indexed-video counts when the catalog reports them", () => {
    const missingTree = buildFolderTree({
      directorySummaries: [
        { relativePath: "", name: "outputs" },
        { relativePath: "missing-run", name: "missing-run", missingCount: 2 },
      ],
    });
    render(
      <LibrarySidebar tree={missingTree} expandedPaths={new Set([""])} />
    );

    expect(screen.getByTitle("missing-run")).toHaveTextContent("2 missing");
  });

  it("saves, applies, and deletes smart views", async () => {
    const onSaveCurrentView = vi.fn().mockResolvedValue({ id: 2 });
    const onApplySavedView = vi.fn();
    const onDeleteSavedView = vi.fn();
    render(
      <LibrarySidebar
        tree={tree}
        savedViews={[{ id: 1, name: "Unreviewed picks" }]}
        onSaveCurrentView={onSaveCurrentView}
        onApplySavedView={onApplySavedView}
        onDeleteSavedView={onDeleteSavedView}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Unreviewed picks" }));
    expect(onApplySavedView).toHaveBeenCalledWith({
      id: 1,
      name: "Unreviewed picks",
    });

    fireEvent.click(screen.getByRole("button", { name: "Save current smart view" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Saved view name" }), {
      target: { value: "My pass" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaveCurrentView).toHaveBeenCalledWith("My pass"));

    fireEvent.click(
      screen.getByRole("button", { name: "Delete saved view Unreviewed picks" })
    );
    expect(onDeleteSavedView).toHaveBeenCalledWith(1, {
      id: 1,
      name: "Unreviewed picks",
    });
  });

  it("clearly disables smart views without an open collection", () => {
    render(
      <LibrarySidebar
        savedViews={[{ id: 1, name: "Unreviewed picks" }]}
        onApplySavedView={vi.fn()}
        onSaveCurrentView={vi.fn()}
        smartViewsEnabled={false}
      />
    );

    const apply = screen.getByRole("button", { name: "Unreviewed picks" });
    expect(apply).toBeDisabled();
    expect(apply).toHaveAttribute(
      "title",
      "Open a collection to apply this smart view"
    );
    expect(screen.getByRole("button", { name: "Save current smart view" })).toBeDisabled();
  });

  it("renders useful empty states without owning any Electron behavior", () => {
    render(<LibrarySidebar />);
    expect(screen.getByText("Pin frequently reviewed roots here.")).toBeVisible();
    expect(screen.getByText("Save filters for repeat review passes.")).toBeVisible();
    expect(screen.getByText("Open a folder to browse its tree.")).toBeVisible();
  });
});
