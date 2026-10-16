import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import StackBar from "./StackBar";

describe("StackBar", () => {
  it("says where the stack sits, what it holds and what filters hide", () => {
    render(<StackBar position={3} count={41} runs={5} total={20} seeds={4} />);
    expect(
      screen.getByText("Stack 3 of 41 · 5 runs · 4 seeds · 15 more hidden by filters")
    ).toBeInTheDocument();
  });

  it("steps, closes and rejects the rest through its buttons", () => {
    const onClose = vi.fn();
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    const onRejectUnreviewed = vi.fn();
    render(
      <StackBar
        position={1}
        count={2}
        runs={3}
        total={3}
        hasNext
        unreviewedCount={2}
        onClose={onClose}
        onPrevious={onPrevious}
        onNext={onNext}
        onRejectUnreviewed={onRejectUnreviewed}
      />
    );
    expect(screen.getByRole("button", { name: "Previous stack" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next stack" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject 2 unreviewed runs" }));
    fireEvent.click(screen.getByRole("button", { name: /All stacks/ }));
    expect(onNext).toHaveBeenCalledOnce();
    expect(onRejectUnreviewed).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onPrevious).not.toHaveBeenCalled();
  });

  it("disables culling when nothing is left and hides it outside review mode", () => {
    const { rerender } = render(<StackBar runs={2} total={2} unreviewedCount={0} />);
    expect(screen.getByRole("button", { name: "No unreviewed runs" })).toBeDisabled();
    rerender(<StackBar runs={2} total={2} unreviewedCount={2} reviewModeEnabled={false} />);
    expect(screen.queryByRole("button", { name: /unreviewed/ })).toBeNull();
  });
});
