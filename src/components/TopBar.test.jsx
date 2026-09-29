import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FolderScope, buildBreadcrumbs } from "../library/folderModel";
import TopBar from "./TopBar";

const baseProps = () => ({
  onOpenFolder: vi.fn(),
  recentFolders: [{ path: "/renders/2026-09", name: "2026-09" }],
  pinnedFolders: [{ rootPath: "/renders", name: "renders" }],
  onOpenLocation: vi.fn(),
  hasOpenFolder: true,
  breadcrumb: buildBreadcrumbs("/models/wan/outputs", "run-a/seed-01"),
  onBreadcrumbSelect: vi.fn(),
  previousSibling: { path: "run-a/seed-00", name: "seed-00" },
  nextSibling: null,
  onPreviousFolder: vi.fn(),
  onNextFolder: vi.fn(),
  matchingCount: 1250,
  totalCount: 2048,
  scope: FolderScope.CURRENT_FOLDER,
  onScopeChange: vi.fn(),
  recursive: true,
  onRecursiveChange: vi.fn(),
  onFiltersToggle: vi.fn(),
  onFiltersClear: vi.fn(),
  sortSelection: "name-asc",
  onSortChange: vi.fn(),
  zoomLevel: 1,
  onZoomChange: vi.fn(),
  reviewModeEnabled: true,
  onReviewModeToggle: vi.fn(),
  showFilenames: true,
  onFilenamesToggle: vi.fn(),
  hoverAudioEnabled: false,
  onHoverAudioToggle: vi.fn(),
  groupByFolders: true,
  onGroupByFoldersToggle: vi.fn(),
  onFolderHeadersToggle: vi.fn(),
  playbackMode: "balanced",
  onPlaybackModeChange: vi.fn(),
  playbackDecision: { target: 3, safetyCap: 6, health: "healthy" },
  playbackCapabilityStatus: "Linux: hardware video decode was not detected; software decoding is likely.",
  onProxyPlaybackToggle: vi.fn(),
  onPlaybackDetailsToggle: vi.fn(),
  onHotkeyHelp: vi.fn(),
  onOpenAbout: vi.fn(),
  onOpenSupport: vi.fn(),
});

const openMenu = (name) => {
  fireEvent.click(screen.getByRole("button", { name }));
  return screen.getByRole("menu");
};

describe("TopBar", () => {
  it("opens folders, recent locations and pinned folders from one Open menu", () => {
    const props = baseProps();
    render(<TopBar {...props} />);
    const menu = openMenu("Open");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Open folder…/ }));
    expect(props.onOpenFolder).toHaveBeenCalled();
    openMenu("Open");
    fireEvent.click(screen.getByRole("menuitem", { name: "2026-09" }));
    expect(props.onOpenLocation).toHaveBeenCalledWith("/renders/2026-09");
    openMenu("Open");
    fireEvent.click(screen.getByRole("menuitem", { name: "renders" }));
    expect(props.onOpenLocation).toHaveBeenLastCalledWith("/renders");
  });

  it("shows the location with sibling folders, breadcrumb, count, scope and Include subfolders", () => {
    const props = baseProps();
    render(<TopBar {...props} />);
    const location = screen.getByRole("navigation", { name: "Location" });
    expect(within(location).getByRole("button", { name: "seed-01" })).toHaveAttribute("aria-current", "location");
    fireEvent.click(within(location).getByRole("button", { name: "run-a" }));
    expect(props.onBreadcrumbSelect).toHaveBeenCalledWith("run-a");
    fireEvent.click(screen.getByRole("button", { name: "Previous folder: seed-00" }));
    expect(props.onPreviousFolder).toHaveBeenCalledWith(props.previousSibling);
    expect(screen.getByRole("button", { name: "Next folder: none" })).toBeDisabled();
    expect(screen.getByLabelText("1,250 matching clips out of 2,048")).toHaveTextContent("1,250 / 2,048");
    fireEvent.change(screen.getByRole("combobox", { name: "Folder scope" }), { target: { value: FolderScope.ALL_DESCENDANTS } });
    expect(props.onScopeChange).toHaveBeenCalledWith(FolderScope.ALL_DESCENDANTS);
    fireEvent.click(screen.getByRole("checkbox", { name: "Include subfolders" }));
    expect(props.onRecursiveChange).toHaveBeenCalledWith(false);
  });

  it("hides folder-only controls with no folder open", () => {
    render(<TopBar {...baseProps()} hasOpenFolder={false} />);
    expect(screen.queryByRole("navigation", { name: "Location" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Folder scope" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Include subfolders" })).toBeInTheDocument();
  });

  it("labels the review switch and keeps zoom's historic range", () => {
    const props = baseProps();
    render(<TopBar {...props} />);
    const review = screen.getByRole("button", { name: "Review" });
    expect(review).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(review);
    expect(props.onReviewModeToggle).toHaveBeenCalled();
    const zoom = screen.getByRole("slider", { name: "Grid zoom" });
    expect(zoom).toHaveAttribute("min", "0");
    expect(zoom).toHaveAttribute("max", "4");
    expect(zoom).toHaveAttribute("step", "0.5");
    expect(zoom).toHaveAttribute("aria-valuetext", "200px cards");
    fireEvent.change(zoom, { target: { value: "1.5" } });
    expect(props.onZoomChange).toHaveBeenCalledWith(1.5);
    fireEvent.change(screen.getByRole("combobox", { name: "Sort order" }), { target: { value: "resolution-desc" } });
    expect(props.onSortChange).toHaveBeenCalledWith("resolution-desc");
  });

  it("puts view settings and playback in the View menu", () => {
    const props = baseProps();
    render(<TopBar {...props} proxyPlaybackAvailable={false} />);
    const menu = openMenu("View");
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Show file names" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Play audio on hover" }));
    expect(props.onHoverAudioToggle).toHaveBeenCalled();
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Folder groups strip" }));
    expect(props.onFolderHeadersToggle).toHaveBeenCalledWith(true);
    expect(within(menu).getByRole("menuitemradio", { name: "Balanced" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Static + Hover" }));
    expect(props.onPlaybackModeChange).toHaveBeenCalledWith("static-hover");
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Playback proxies (720p)" })).toBeDisabled();
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Playback details in the status line" }));
    expect(props.onPlaybackDetailsToggle).toHaveBeenCalled();
    expect(within(menu).getByText(/3 of 6 decoders in use · Linux: hardware video decode was not detected/)).toBeVisible();
  });

  it("puts shortcuts, About and Support in ⋯", () => {
    const props = baseProps();
    render(<TopBar {...props} />);
    let menu = openMenu("More");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Keyboard shortcuts/ }));
    expect(props.onHotkeyHelp).toHaveBeenCalled();
    menu = openMenu("More");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "About Video Swarm" }));
    expect(props.onOpenAbout).toHaveBeenCalled();
    menu = openMenu("More");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Support Video Swarm/ }));
    expect(props.onOpenSupport).toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: /Donate/ })).toBeNull();
  });

  it("offers Preferences in ⋯ once the app provides it", () => {
    const props = baseProps();
    const { rerender } = render(<TopBar {...props} />);
    expect(within(openMenu("More")).queryByRole("menuitem", { name: /Preferences/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    const onOpenPreferences = vi.fn();
    rerender(<TopBar {...props} onOpenPreferences={onOpenPreferences} />);
    fireEvent.click(within(openMenu("More")).getByRole("menuitem", { name: /Preferences…/ }));
    expect(onOpenPreferences).toHaveBeenCalled();
  });

  it("moves folded controls into ⋯ instead of dropping them", () => {
    const props = baseProps();
    render(<TopBar {...props} initialFolded={["zoom", "sort", "scope", "subfolders", "siblings"]} />);
    expect(screen.queryByRole("slider", { name: "Grid zoom" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Sort order" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Include subfolders" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Previous folder/ })).toBeNull();

    const menu = openMenu("More");
    expect(within(menu).getByRole("slider", { name: "Grid zoom" })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Created ↓" }));
    expect(props.onSortChange).toHaveBeenCalledWith("created-desc");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "All descendants" }));
    expect(props.onScopeChange).toHaveBeenCalledWith(FolderScope.ALL_DESCENDANTS);
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Include subfolders" }));
    expect(props.onRecursiveChange).toHaveBeenCalledWith(false);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Previous folder: seed-00/ }));
    expect(props.onPreviousFolder).toHaveBeenCalled();
  });

  it("offers a clear control only while filters are active", () => {
    const props = baseProps();
    const { rerender } = render(<TopBar {...props} />);
    expect(screen.queryByRole("button", { name: /Clear .* active filter/ })).toBeNull();
    rerender(<TopBar {...props} filtersActiveCount={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear 1 active filter" }));
    expect(props.onFiltersClear).toHaveBeenCalled();
    expect(props.onFiltersToggle).not.toHaveBeenCalled();
  });

  it("shows a quiet status while a cached folder is revalidated", () => {
    render(<TopBar {...baseProps()} isRefreshingFolder />);
    expect(screen.getByRole("status")).toHaveTextContent("Refreshing");
  });
});
