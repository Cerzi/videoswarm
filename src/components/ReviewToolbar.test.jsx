import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import ReviewToolbar from "./ReviewToolbar";

const progress = {
  total: 6000,
  reviewedTotal: 1250,
  reviewed: 500,
  accept: 700,
  reject: 50,
  unreviewed: 4750,
};

describe("ReviewToolbar", () => {
  it("shows compact progress and catalog-derived one-handed key hints", () => {
    render(<ReviewToolbar progress={progress} selectedCount={1} />);

    expect(screen.getByRole("progressbar", { name: "Review progress" })).toHaveAttribute(
      "aria-valuenow",
      "1250"
    );
    expect(screen.getByText("1,250")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Accept/ })).toHaveTextContent("A");
    expect(screen.getByRole("button", { name: /Reviewed/ })).toHaveTextContent("S");
    expect(screen.getByRole("button", { name: /Reject/ })).toHaveTextContent("D");
    const unreviewed = screen.getByRole("button", { name: /Unreviewed/ });
    expect(unreviewed).toHaveTextContent("F");
    expect(unreviewed).toHaveAttribute(
      "title",
      expect.stringContaining("clears ratings but keeps tags")
    );
  });

  it("dispatches review, advance, undo, and result-processing controls", () => {
    const onSetReviewState = vi.fn();
    const onAutoAdvanceChange = vi.fn();
    const onUndo = vi.fn();
    const onProcessResults = vi.fn();
    render(
      <ReviewToolbar
        progress={progress}
        selectedCount={1}
        canUndo
        onSetReviewState={onSetReviewState}
        onAutoAdvanceChange={onAutoAdvanceChange}
        onUndo={onUndo}
        onProcessResults={onProcessResults}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Accept/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Advance after marking" }));
    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    fireEvent.click(screen.getByRole("button", { name: "Process results" }));

    expect(onSetReviewState).toHaveBeenCalledWith("pick");
    expect(onAutoAdvanceChange).toHaveBeenCalledWith(true);
    expect(onUndo).toHaveBeenCalledOnce();
    expect(onProcessResults).toHaveBeenCalledOnce();
  });

  it("disables mutations without a selection and explains unavailable processing", () => {
    render(
      <ReviewToolbar
        progress={progress}
        selectedCount={0}
        canProcessResults={false}
        processResultsReason="Wait for the authoritative scan"
      />
    );

    expect(screen.getByRole("button", { name: /Accept/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Undo/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Process results" })).toHaveAttribute(
      "title",
      "Wait for the authoritative scan"
    );
  });

  it("does not render for an empty folder scope", () => {
    const { container } = render(
      <ReviewToolbar progress={{ ...progress, total: 0 }} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
