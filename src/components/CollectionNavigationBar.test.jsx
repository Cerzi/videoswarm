import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FolderScope, buildBreadcrumbs } from "../library/folderModel";
import CollectionNavigationBar from "./CollectionNavigationBar";

const breadcrumb = buildBreadcrumbs("/models/wan/outputs", "run-a/seed-01");

const baseProps = {
  breadcrumb,
  onBreadcrumbSelect: vi.fn(),
  scope: FolderScope.CURRENT_FOLDER,
  onScopeChange: vi.fn(),
  previousSibling: { path: "run-a/seed-00", name: "seed-00" },
  nextSibling: { path: "run-a/seed-02", name: "seed-02" },
  onPreviousFolder: vi.fn(),
  onNextFolder: vi.fn(),
  recursive: true,
  onRecursiveChange: vi.fn(),
  sidebarOpen: true,
  onSidebarToggle: vi.fn(),
  showFolderHeaders: false,
  onFolderHeadersToggle: vi.fn(),
  matchingCount: 1250,
  totalCount: 2048,
};

describe("CollectionNavigationBar", () => {
  it("renders a dense breadcrumb, scope, sibling actions, and collection counts", () => {
    render(<CollectionNavigationBar {...baseProps} />);

    expect(screen.getByRole("navigation", { name: "Current folder path" })).toBeVisible();
    expect(screen.getByRole("button", { name: "outputs" })).toHaveAttribute(
      "title",
      "/models/wan/outputs"
    );
    expect(screen.getByRole("button", { name: "seed-01" })).toHaveAttribute(
      "aria-current",
      "location"
    );
    expect(screen.getByRole("combobox", { name: "Folder scope" })).toHaveValue(
      FolderScope.CURRENT_FOLDER
    );
    expect(
      screen.getByLabelText("1,250 matching videos out of 2,048")
    ).toHaveTextContent("1,250 / 2,048");
    expect(
      screen.getByRole("button", { name: "Previous matching folder: seed-00" })
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Next matching folder: seed-02" })
    ).toBeEnabled();
  });

  it("forwards breadcrumb, scope, sibling, recursion, and sidebar intent", () => {
    const props = {
      ...baseProps,
      onBreadcrumbSelect: vi.fn(),
      onScopeChange: vi.fn(),
      onPreviousFolder: vi.fn(),
      onNextFolder: vi.fn(),
      onRecursiveChange: vi.fn(),
      onSidebarToggle: vi.fn(),
    };
    render(<CollectionNavigationBar {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "run-a" }));
    expect(props.onBreadcrumbSelect).toHaveBeenCalledWith("run-a");

    fireEvent.change(screen.getByRole("combobox", { name: "Folder scope" }), {
      target: { value: FolderScope.CURRENT_SUBTREE },
    });
    expect(props.onScopeChange).toHaveBeenCalledWith(FolderScope.CURRENT_SUBTREE);

    fireEvent.click(
      screen.getByRole("button", { name: "Previous matching folder: seed-00" })
    );
    expect(props.onPreviousFolder).toHaveBeenCalledWith(props.previousSibling);

    fireEvent.click(
      screen.getByRole("button", { name: "Next matching folder: seed-02" })
    );
    expect(props.onNextFolder).toHaveBeenCalledWith(props.nextSibling);

    fireEvent.click(screen.getByRole("checkbox", { name: "Index subfolders" }));
    expect(props.onRecursiveChange).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByRole("button", { name: "Hide folder sidebar" }));
    expect(props.onSidebarToggle).toHaveBeenCalledWith(false);
  });

  it("shows the folder-header toggle only while the tree sidebar is hidden", () => {
    const onFolderHeadersToggle = vi.fn();
    const { rerender } = render(
      <CollectionNavigationBar
        {...baseProps}
        sidebarOpen
        showFolderHeaders={false}
        onFolderHeadersToggle={onFolderHeadersToggle}
      />
    );
    expect(
      screen.queryByRole("button", { name: "Show folder headers" })
    ).toBeNull();

    rerender(
      <CollectionNavigationBar
        {...baseProps}
        sidebarOpen={false}
        showFolderHeaders
        onFolderHeadersToggle={onFolderHeadersToggle}
      />
    );
    const toggle = screen.getByRole("button", { name: "Show folder headers" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(onFolderHeadersToggle).toHaveBeenCalledWith(false);
  });

  it("disables unavailable siblings and every mutation while loading", () => {
    render(
      <CollectionNavigationBar
        {...baseProps}
        previousSibling={null}
        nextSibling={null}
        disabled
      />
    );

    expect(
      screen.getByRole("button", { name: "Previous matching folder: none" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Next matching folder: none" })
    ).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Folder scope" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Index subfolders" })).toBeDisabled();
  });
});
