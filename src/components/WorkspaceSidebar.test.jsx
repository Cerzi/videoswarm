import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import WorkspaceSidebar, { buildWorkspacePanels } from "./WorkspaceSidebar";

const panels = (overrides = {}) =>
  buildWorkspacePanels({
    detailsDocked: true,
    libraryProps: { pinnedRoots: [] },
    detailsContent: <div>Clip facts</div>,
    selectionCount: 0,
    ...overrides,
  });

function ControlledSidebar({ initialOpen = true, panelList = panels() }) {
  const [open, setOpen] = useState(initialOpen);
  const [active, setActive] = useState("library");
  return (
    <WorkspaceSidebar
      panels={panelList}
      open={open}
      activePanel={active}
      onSelectPanel={(id) => {
        setOpen(true);
        setActive(id);
      }}
      onCollapse={() => setOpen(false)}
    />
  );
}

describe("WorkspaceSidebar", () => {
  it("is one landmark with a vertical rail linked to its panels", () => {
    render(
      <WorkspaceSidebar panels={panels({ selectionCount: 2 })} activePanel="library" open />
    );

    expect(screen.getAllByRole("complementary")).toHaveLength(1);
    const rail = screen.getByRole("tablist", { name: "Sidebar panels" });
    expect(rail).toHaveAttribute("aria-orientation", "vertical");
    const libraryTab = screen.getByRole("tab", { name: "Library" });
    const detailsTab = screen.getByRole("tab", { name: "Details 2 selected" });
    const libraryPanel = screen.getByRole("tabpanel", { name: "Library" });
    const detailsPanel = document.getElementById(detailsTab.getAttribute("aria-controls"));

    expect(rail).toContainElement(libraryTab);
    expect(libraryTab).toHaveAttribute("aria-controls", libraryPanel.id);
    expect(detailsPanel).toHaveAttribute("aria-labelledby", detailsTab.id);
    expect(libraryTab).toHaveAttribute("aria-selected", "true");
    expect(libraryTab).toHaveAttribute("title", "Hide Library");
    expect(detailsTab).toHaveAttribute("aria-selected", "false");
    expect(detailsTab).toHaveAttribute("tabindex", "-1");
    // Both panels stay mounted, so switching keeps their state.
    expect(detailsPanel).toHaveAttribute("hidden");
    expect(detailsPanel).toHaveTextContent("Clip facts");
  });

  it("opens a panel from its icon and collapses to the rail from the open one", () => {
    render(<ControlledSidebar />);

    fireEvent.click(screen.getByRole("tab", { name: "Details" }));
    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Details" })).toHaveTextContent("Clip facts");

    fireEvent.click(screen.getByRole("tab", { name: "Details" }));
    expect(screen.queryByRole("tabpanel")).toBeNull();
    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "Library" })).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    expect(screen.getByRole("tabpanel", { name: "Library" })).toBeVisible();
  });

  it("moves focus with the arrow keys without opening or collapsing anything", () => {
    render(<ControlledSidebar initialOpen={false} />);

    const libraryTab = screen.getByRole("tab", { name: "Library" });
    const detailsTab = screen.getByRole("tab", { name: "Details" });
    const generationTab = screen.getByRole("tab", { name: "Generation" });
    libraryTab.focus();
    fireEvent.keyDown(libraryTab, { key: "ArrowDown" });
    expect(detailsTab).toHaveFocus();
    expect(screen.queryByRole("tabpanel")).toBeNull();
    fireEvent.keyDown(detailsTab, { key: "ArrowDown" });
    expect(generationTab).toHaveFocus();
    fireEvent.keyDown(generationTab, { key: "ArrowDown" });
    expect(libraryTab).toHaveFocus();
    fireEvent.keyDown(libraryTab, { key: "ArrowUp" });
    expect(generationTab).toHaveFocus();
    fireEvent.keyDown(generationTab, { key: "Home" });
    expect(libraryTab).toHaveFocus();
    expect(screen.queryByRole("tabpanel")).toBeNull();
  });

  it("gives Generation its own panel while Details is docked", () => {
    render(<ControlledSidebar panelList={panels({ selectionCount: 2 })} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Library",
      "Details2",
      "Generation",
    ]);
    fireEvent.click(screen.getByRole("tab", { name: "Generation" }));
    expect(screen.getByRole("tabpanel", { name: "Generation" })).toHaveTextContent(
      "Select one clip to see how it was generated."
    );
  });

  it("leaves Details and Generation off the rail while Details floats", () => {
    render(<ControlledSidebar panelList={panels({ detailsDocked: false })} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Library"]);
  });

  it("puts Sequences on the rail in both Details modes, with an entry-count badge", () => {
    const sequencesContent = <div>Shot list</div>;
    const { rerender } = render(
      <ControlledSidebar
        panelList={panels({ sequencesContent, sequenceEntryCount: 12 })}
      />
    );
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Library",
      "Details",
      "Generation",
      "Sequences12",
    ]);
    expect(
      screen.getByRole("tab", { name: "Sequences 12 clips in the sequence" })
    ).toBeVisible();

    rerender(
      <ControlledSidebar
        panelList={panels({
          detailsDocked: false,
          sequencesContent,
          sequenceEntryCount: 0,
        })}
      />
    );
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Library",
      "Sequences",
    ]);
    fireEvent.click(screen.getByRole("tab", { name: "Sequences" }));
    expect(screen.getByRole("tabpanel", { name: "Sequences" })).toHaveTextContent(
      "Shot list"
    );
  });

  it("falls back to the first panel when the active one is gone", () => {
    render(
      <WorkspaceSidebar panels={panels({ detailsDocked: false })} activePanel="details" open />
    );
    expect(screen.getByRole("tab", { name: "Library" })).toHaveAttribute("aria-selected", "true");
  });

  it("shows a selection badge and an informative empty Details state", () => {
    render(
      <WorkspaceSidebar
        panels={buildWorkspacePanels({ detailsDocked: true, selectionCount: 3 })}
        activePanel="details"
        open
      />
    );
    expect(screen.getByRole("tab", { name: "Details 3 selected" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Details unavailable");
    expect(screen.getByRole("status")).toHaveTextContent("selected clips are ready");
  });

  it("blocks panel changes and disables nested library controls when disabled", () => {
    const onSelectPanel = vi.fn();
    const onCollapse = vi.fn();
    render(
      <WorkspaceSidebar
        panels={buildWorkspacePanels({
          detailsDocked: true,
          disabled: true,
          libraryProps: {
            currentRoot: { rootPath: "/root", pinned: false },
            onTogglePin: vi.fn(),
          },
        })}
        activePanel="library"
        open
        disabled
        onSelectPanel={onSelectPanel}
        onCollapse={onCollapse}
      />
    );
    expect(screen.getByRole("tab", { name: "Library" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Details" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pin current library root" })).toBeDisabled();
    expect(onSelectPanel).not.toHaveBeenCalled();
    expect(onCollapse).not.toHaveBeenCalled();
  });
});
