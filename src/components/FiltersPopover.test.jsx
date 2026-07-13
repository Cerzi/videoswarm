import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import FiltersPopover from "./FiltersPopover";

describe("FiltersPopover review filters", () => {
  it("selects a review state without changing the other filters", () => {
    let current = {
      includeTags: ["cat"],
      excludeTags: [],
      minRating: null,
      exactRating: null,
      reviewFilter: "any",
    };
    const onChange = vi.fn((updater) => {
      current = updater(current);
    });

    render(
      <FiltersPopover
        filters={current}
        onChange={onChange}
        onReset={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Picks" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(current.reviewFilter).toBe("pick");
    expect(current.includeTags).toEqual(["cat"]);
  });
});
