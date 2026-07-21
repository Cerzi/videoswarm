import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import KeyboardShortcutsDialog from "./KeyboardShortcutsDialog";
import { HOTKEY_SECTIONS } from "../hotkeys/shortcutCatalog";

describe("KeyboardShortcutsDialog", () => {
  it("renders every shortcut from the shared catalog", () => {
    render(<KeyboardShortcutsDialog open onClose={vi.fn()} />);

    expect(
      screen.getByRole("dialog", { name: "Keyboard shortcuts" })
    ).toBeInTheDocument();
    for (const section of HOTKEY_SECTIONS) {
      expect(screen.getByRole("heading", { name: section.title })).toBeInTheDocument();
      for (const shortcut of section.shortcuts) {
        expect(screen.getByText(shortcut.label)).toBeInTheDocument();
      }
    }
  });

  it("closes with Escape and restores focus", () => {
    const onClose = vi.fn();
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { rerender } = render(
      <KeyboardShortcutsDialog open onClose={onClose} />
    );

    expect(screen.getByRole("button", { name: "Close keyboard shortcuts" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    rerender(<KeyboardShortcutsDialog open={false} onClose={onClose} />);
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("closes from the backdrop but not from the dialog surface", () => {
    const onClose = vi.fn();
    const { container } = render(
      <KeyboardShortcutsDialog open onClose={onClose} />
    );
    const backdrop = container.querySelector(".shortcuts-dialog-backdrop");
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });

    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps rating shortcuts but hides review-state shortcuts when review mode is off", () => {
    render(
      <KeyboardShortcutsDialog
        open
        onClose={vi.fn()}
        reviewModeEnabled={false}
      />
    );

    expect(screen.getByRole("heading", { name: "Rating" })).toBeVisible();
    expect(screen.getByText("Set star rating")).toBeVisible();
    expect(screen.getByText("Clear star rating")).toBeVisible();
    expect(screen.queryByText("Mark as Accept")).toBeNull();
  });
});
