import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import WorkspaceSidebar from "./WorkspaceSidebar";

function ControlledSidebar(props) {
  const [activeTab, setActiveTab] = useState("library");
  return (
    <WorkspaceSidebar
      {...props}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    />
  );
}

describe("WorkspaceSidebar", () => {
  it("owns one complementary landmark and correctly links its tabs and panels", () => {
    render(
      <WorkspaceSidebar
        activeTab="library"
        libraryProps={{ pinnedRoots: [] }}
        detailsContent={<div>Clip facts</div>}
        selectionCount={2}
      />
    );

    expect(screen.getAllByRole("complementary")).toHaveLength(1);
    const tablist = screen.getByRole("tablist", {
      name: "Workspace sidebar panels",
    });
    const libraryTab = screen.getByRole("tab", { name: "Library" });
    const detailsTab = screen.getByRole("tab", { name: "Details 2 selected" });
    const libraryPanel = screen.getByRole("tabpanel", { name: "Library" });
    const detailsPanel = document.getElementById(
      detailsTab.getAttribute("aria-controls")
    );

    expect(tablist).toContainElement(libraryTab);
    expect(libraryTab).toHaveAttribute("aria-controls", libraryPanel.id);
    expect(libraryPanel).toHaveAttribute("aria-labelledby", libraryTab.id);
    expect(detailsPanel).toHaveAttribute("aria-labelledby", detailsTab.id);
    expect(libraryTab).toHaveAttribute("aria-selected", "true");
    expect(libraryTab).toHaveAttribute("tabindex", "0");
    expect(detailsTab).toHaveAttribute("aria-selected", "false");
    expect(detailsTab).toHaveAttribute("tabindex", "-1");
    expect(detailsPanel).toHaveAttribute("hidden");
  });

  it("switches and focuses tabs with click, arrows, Home, and End", () => {
    render(
      <ControlledSidebar detailsContent={<div>Clip facts</div>} />
    );

    const libraryTab = screen.getByRole("tab", { name: "Library" });
    const detailsTab = screen.getByRole("tab", { name: "Details" });

    libraryTab.focus();
    fireEvent.keyDown(libraryTab, { key: "ArrowRight" });
    expect(detailsTab).toHaveFocus();
    expect(detailsTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Details" })).toHaveTextContent(
      "Clip facts"
    );

    fireEvent.keyDown(detailsTab, { key: "ArrowLeft" });
    expect(libraryTab).toHaveFocus();
    expect(libraryTab).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(libraryTab, { key: "End" });
    expect(detailsTab).toHaveFocus();
    fireEvent.keyDown(detailsTab, { key: "Home" });
    expect(libraryTab).toHaveFocus();

    fireEvent.click(detailsTab);
    expect(detailsTab).toHaveAttribute("aria-selected", "true");
  });

  it("shows a bounded selection badge and an informative empty Details state", () => {
    render(
      <WorkspaceSidebar
        activeTab="details"
        selectionCount={3}
      />
    );

    expect(screen.getByRole("tab", { name: "Details 3 selected" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Details unavailable");
    expect(screen.getByRole("status")).toHaveTextContent(
      "selected clips are ready"
    );
  });

  it("blocks tab changes and disables nested library controls when disabled", () => {
    const onTabChange = vi.fn();
    render(
      <WorkspaceSidebar
        activeTab="library"
        onTabChange={onTabChange}
        disabled
        libraryProps={{
          currentRoot: { rootPath: "/root", pinned: false },
          onTogglePin: vi.fn(),
        }}
      />
    );

    const libraryTab = screen.getByRole("tab", { name: "Library" });
    const detailsTab = screen.getByRole("tab", { name: "Details" });
    expect(libraryTab).toBeDisabled();
    expect(detailsTab).toBeDisabled();
    fireEvent.keyDown(libraryTab, { key: "End" });
    expect(onTabChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Pin current library root" })
    ).toBeDisabled();
  });
});
