import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import VersionsBar from "./VersionsBar";

describe("VersionsBar", () => {
  it("says how many versions there are and where, and leads back", () => {
    const onClose = vi.fn();
    const onRestart = vi.fn();
    render(<VersionsBar count={3} elsewhere={2} truncated onClose={onClose} onRestart={onRestart} />);
    expect(screen.getByRole("toolbar", { name: "Versions side by side" })).toHaveTextContent(
      "3 versions of this generation, best first · 2 from folders that aren't open · more not shown"
    );
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(onClose).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Play together from the start" }));
    expect(onRestart).toHaveBeenCalled();
  });

  it("says when it is reading or could not read the versions", () => {
    const { rerender } = render(<VersionsBar count={1} loading />);
    expect(screen.getByText("Reading versions…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play together from the start" })).toBeDisabled();
    rerender(<VersionsBar count={1} failed />);
    expect(screen.getByText("The other versions could not be read")).toBeInTheDocument();
  });
});
