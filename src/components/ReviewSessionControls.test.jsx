import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ReviewSessionControls from "./ReviewSessionControls";

describe("ReviewSessionControls", () => {
  it("shows an active session, provisional refresh feedback, and a live target", () => {
    render(
      <ReviewSessionControls
        session={{
          mode: "active",
          savedAtLabel: "Saved 2 minutes ago",
          candidateName: "clip-0042.mp4",
          checkingForFiles: true,
        }}
        onForget={vi.fn()}
      />
    );

    expect(screen.getByText("Session active")).toBeVisible();
    expect(screen.getByText("Saved 2 minutes ago")).toBeVisible();
    expect(screen.getByText("Checking for newer files…")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Review target: clip-0042.mp4"
    );
  });

  it("continues an elsewhere session and confirms moving its saved position", async () => {
    const onContinue = vi.fn();
    const onMove = vi.fn();
    render(
      <ReviewSessionControls
        session={{
          mode: "elsewhere",
          locationLabel: "Saved in run-a / Current subtree",
        }}
        onContinue={onContinue}
        onMove={onMove}
        onForget={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue saved" }));
    expect(onContinue).toHaveBeenCalledOnce();

    const move = screen.getByRole("button", {
      name: "Move saved review position here…",
    });
    fireEvent.click(move);
    const dialog = screen.getByRole("alertdialog", {
      name: "Move the saved review position here?",
    });
    expect(dialog).toHaveTextContent("Review decisions, ratings, and tags remain unchanged");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Move position" }));

    expect(onMove).toHaveBeenCalledOnce();
    await waitFor(() => expect(move).toHaveFocus());
  });

  it("confirms forgetting a cursor without implying that review metadata is removed", async () => {
    const onForget = vi.fn();
    render(
      <ReviewSessionControls
        session={{ mode: "active" }}
        onForget={onForget}
      />
    );

    fireEvent.click(
      screen.getByText("•••", { selector: "summary" })
    );
    const forget = screen.getByRole("menuitem", {
      name: "Forget saved position…",
    });
    fireEvent.click(forget);
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "Review decisions, ratings, and tags will remain unchanged"
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(forget).toHaveFocus());
    expect(onForget).not.toHaveBeenCalled();
  });

  it("offers bounded recovery actions for filtered, capped, and partial-index states", () => {
    const onReviewAllUnreviewed = vi.fn();
    const onShowTarget = vi.fn();
    const rendered = render(
      <ReviewSessionControls
        session={{ mode: "complete-view", showTarget: true }}
        onReviewAllUnreviewed={onReviewAllUnreviewed}
        onShowTarget={onShowTarget}
        onForget={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Review all Unreviewed" }));
    fireEvent.click(screen.getByRole("button", { name: "Show review target" }));
    expect(onReviewAllUnreviewed).toHaveBeenCalledOnce();
    expect(onShowTarget).toHaveBeenCalledOnce();

    const onIndexSubfolders = vi.fn();
    rendered.rerender(
      <ReviewSessionControls
        session={{ mode: "index-required" }}
        onIndexSubfolders={onIndexSubfolders}
        onForget={vi.fn()}
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Index subfolders to continue" })
    );
    expect(onIndexSubfolders).toHaveBeenCalledOnce();
  });

  it("puts scope and remaining-count context in session action names", () => {
    const onStart = vi.fn();
    const rendered = render(
      <ReviewSessionControls
        session={{
          mode: "none",
          startActionContext: "Current folder, 12 unreviewed",
        }}
        onStart={onStart}
      />
    );

    fireEvent.click(screen.getByRole("button", {
      name: "Start review here — Current folder, 12 unreviewed",
    }));
    expect(onStart).toHaveBeenCalledOnce();

    const onContinue = vi.fn();
    rendered.rerender(
      <ReviewSessionControls
        session={{
          mode: "available",
          savedActionContext: "outputs / run-a, 4 unreviewed in the root",
        }}
        onContinue={onContinue}
        onForget={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", {
      name: "Continue review — outputs / run-a, 4 unreviewed in the root",
    }));
    expect(onContinue).toHaveBeenCalledOnce();
  });
});
