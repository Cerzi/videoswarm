import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { vi } from "vitest";
import ReviewToolbar, { REVIEW_FOLD_ORDER } from "./ReviewToolbar";

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

  it("keeps the review-session action available before a scope has progress", () => {
    const onStartSession = vi.fn();
    render(
      <ReviewToolbar
        progress={{ total: 0 }}
        session={{ mode: "none" }}
        onStartSession={onStartSession}
      />
    );

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Find next Unreviewed" }));
    expect(onStartSession).toHaveBeenCalledOnce();
  });

  it("keeps every control reachable when the bar is folded to fit", () => {
    const onAutoAdvanceChange = vi.fn();
    const onUndo = vi.fn();
    const onSetReviewState = vi.fn();
    render(
      <ReviewToolbar
        progress={progress}
        selectedCount={1}
        canUndo
        session={{ mode: "none" }}
        initialFolded={[...REVIEW_FOLD_ORDER]}
        onSetReviewState={onSetReviewState}
        onAutoAdvanceChange={onAutoAdvanceChange}
        onUndo={onUndo}
      />
    );

    // Review buttons keep their names and keys, without the visible words.
    const accept = screen.getByRole("button", { name: "Accept" });
    expect(accept).not.toHaveTextContent("Accept");
    fireEvent.click(accept);
    expect(onSetReviewState).toHaveBeenCalledWith("pick");
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Advance after marking" })).toBeNull();
    // The session hint becomes the summary's tooltip.
    expect(document.querySelector(".review-session__summary")).toHaveAttribute(
      "title",
      expect.stringContaining("your first review or rating saves this position")
    );

    fireEvent.click(screen.getByRole("button", { name: "More review controls" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Reviewed 1,250 / 6,000")).toBeInTheDocument();
    expect(within(menu).getByText("Accept 700 · Reject 50")).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Advance after marking" }));
    expect(onAutoAdvanceChange).toHaveBeenCalledWith(true);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Undo/ }));
    expect(onUndo).toHaveBeenCalled();
  });

  it("shows no ⋯ menu while everything fits", () => {
    render(<ReviewToolbar progress={progress} selectedCount={1} />);
    expect(screen.queryByRole("button", { name: "More review controls" })).toBeNull();
  });
});
