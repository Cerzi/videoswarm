import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DebugSummary from "./DebugSummary";

describe("DebugSummary selection note", () => {
  it("shows nothing about a selection when none is made", () => {
    render(<DebugSummary total={12} />);
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it("counts the selection and clears it", () => {
    const onClearSelection = vi.fn();
    render(<DebugSummary total={12} selectedCount={3} onClearSelection={onClearSelection} />);
    const count = screen.getByText("3 selected");
    expect(count.className).not.toMatch(/large/);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClearSelection).toHaveBeenCalled();
  });

  it("makes a large selection stand out and says what it cannot do at once", () => {
    render(<DebugSummary total={48_213} selectedCount={48_213} onClearSelection={vi.fn()} />);
    expect(screen.getByText("48,213 selected").className).toMatch(/debug-info__selection--large/);
    expect(screen.getByText(/Too many to move, copy, tag or rate at once/)).toBeInTheDocument();
  });
});
