import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ReviewPassBar from "./ReviewPassBar";

describe("ReviewPassBar", () => {
  it("counts decisions and leads out", () => {
    const onExit = vi.fn();
    render(<ReviewPassBar name="Library search" decided={12} total={1_040} onExit={onExit} />);
    expect(screen.getByRole("toolbar", { name: "Review pass" })).toHaveTextContent(
      "Library search · 12 of 1,040 decided"
    );
    expect(screen.queryByRole("button", { name: "Run the search again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Exit pass/ }));
    expect(onExit).toHaveBeenCalled();
  });

  it("offers the search again at the end of a pass made from one", () => {
    const onRerun = vi.fn();
    const { rerender } = render(<ReviewPassBar name="A1" decided={4} total={4} done canRerun onRerun={onRerun} />);
    expect(screen.getByRole("toolbar")).toHaveTextContent("A1 · all 4 decided");
    fireEvent.click(screen.getByRole("button", { name: "Run the search again" }));
    expect(onRerun).toHaveBeenCalled();
    rerender(<ReviewPassBar name="3 selected clips" decided={3} total={3} done />);
    expect(screen.queryByRole("button", { name: "Run the search again" })).toBeNull();
  });
});
