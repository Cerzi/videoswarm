import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ArenaBar from "./ArenaBar";
import ArenaSummaryDialog from "./ArenaSummaryDialog";

const arena = (kind) => ({
  status: "ready",
  kind: "mixed",
  scope: "library",
  match: "similar",
  border: null,
  roundNumber: 3,
  counts: { unrated: 10 },
  round: { id: 3, kind, clips: [] },
});

describe("ArenaBar", () => {
  it("names the round's kind large in the middle, marked by kind", () => {
    const { container, rerender } = render(<ArenaBar arena={arena("tier")} />);
    const round = container.querySelector(".arena-bar__round");
    expect(round).toHaveAttribute("data-kind", "tier");
    expect(round.querySelector(".arena-bar__round-centre")).toHaveTextContent(
      "Tier checkSame rating: change any that don't belong, then Enter."
    );
    rerender(<ArenaBar arena={arena("place")} />);
    expect(container.querySelector(".arena-bar__kind")).toHaveTextContent("Place");
  });
});

describe("ArenaSummaryDialog", () => {
  it("sums up the session, keeps going with Enter's button, and closes with Esc", () => {
    const onMore = vi.fn();
    const onDone = vi.fn();
    render(
      <ArenaSummaryDialog
        ended={{ stats: { rounds: 4, placed: 3, moved: 0, held: 2, rejected: 0, skipped: 1 }, tagged: 0 }}
        onMore={onMore}
        onDone={onDone}
      />
    );
    const dialog = screen.getByRole("dialog", { name: "Arena session done" });
    expect(dialog).toHaveTextContent("Rounds4");
    expect(dialog).not.toHaveTextContent("Moved");
    const more = screen.getByRole("button", { name: /More rounds/ });
    expect(more).toHaveFocus();
    fireEvent.click(more);
    expect(onMore).toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onDone).toHaveBeenCalled();
  });

  it("shows nothing when no session just ended", () => {
    const { container } = render(<ArenaSummaryDialog ended={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
