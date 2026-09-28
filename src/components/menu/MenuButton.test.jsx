import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MenuButton from "./MenuButton";

const items = (overrides = {}) => [
  { type: "item", id: "open", label: "Open folder…", shortcut: "Ctrl+O", onSelect: overrides.onOpen || vi.fn() },
  { type: "separator", id: "sep" },
  { type: "heading", id: "heading", label: "Playback" },
  { type: "checkbox", id: "names", label: "Show file names", checked: true, onChange: overrides.onNames || vi.fn() },
  { type: "radio", id: "balanced", label: "Balanced", checked: false, onSelect: overrides.onBalanced || vi.fn() },
  { type: "item", id: "off", label: "Unavailable", disabled: true, onSelect: vi.fn() },
  { type: "note", id: "note", text: "3 of 6 decoders in use" },
];

describe("MenuButton", () => {
  it("opens a labelled menu with checkbox and radio states, and closes on Escape", () => {
    render(<MenuButton label="View" ariaLabel="View" items={items()} />);
    const trigger = screen.getByRole("button", { name: "View" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "View" });
    expect(screen.getByRole("menuitemcheckbox", { name: "Show file names" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Balanced" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("menuitem", { name: "Unavailable" })).toBeDisabled();
    expect(screen.getByText("3 of 6 decoders in use")).toBeVisible();
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /Open folder/ }));

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps the menu open for toggles and closes it for actions", () => {
    const onNames = vi.fn();
    const onOpen = vi.fn();
    render(<MenuButton label="View" items={items({ onNames, onOpen })} />);
    fireEvent.click(screen.getByRole("button", { name: /View/ }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Show file names" }));
    expect(onNames).toHaveBeenCalledWith(false);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /Open folder/ }));
    expect(onOpen).toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("moves focus with the arrow keys, skipping disabled items, and closes on an outside click", () => {
    render(
      <div>
        <MenuButton label="View" items={items()} />
        <p>outside</p>
      </div>
    );
    fireEvent.keyDown(screen.getByRole("button", { name: /View/ }), { key: "ArrowDown" });
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitemcheckbox", { name: "Show file names" }));
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Balanced" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /Open folder/ }));
    fireEvent.mouseDown(screen.getByText("outside"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
