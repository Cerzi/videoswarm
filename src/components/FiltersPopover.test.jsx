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

    fireEvent.click(screen.getByRole("button", { name: "Accepted" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(current.reviewFilter).toBe("pick");
    expect(current.includeTags).toEqual(["cat"]);
  });
});

describe("FiltersPopover search scope", () => {
  const baseFilters = {
    includeTags: [],
    excludeTags: [],
    minRating: null,
    exactRating: null,
    reviewFilter: "any",
    minMegapixels: null,
    maxMegapixels: null,
  };

  const renderScope = (props = {}) =>
    render(
      <FiltersPopover
        filters={baseFilters}
        availableTags={[]}
        onChange={vi.fn()}
        onReset={vi.fn()}
        onClose={vi.fn()}
        {...props}
      />
    );

  it("offers folder and library scope, defaulting to folder", () => {
    renderScope({ onSearchScopeChange: vi.fn() });
    expect(
      screen.getByRole("button", { name: "This folder" })
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "Entire library" })
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("switches to a library search", () => {
    const onSearchScopeChange = vi.fn();
    renderScope({ onSearchScopeChange });
    fireEvent.click(screen.getByRole("button", { name: "Entire library" }));
    expect(onSearchScopeChange).toHaveBeenCalledWith("library");
  });

  it("states that a library search is a snapshot and reports its size", () => {
    renderScope({
      librarySearchScope: "library",
      onSearchScopeChange: vi.fn(),
      onRefreshLibrary: vi.fn(),
      libraryResultCount: 1240,
    });
    expect(screen.getByText(/1,240 clips from every root/)).toBeInTheDocument();
    // The snapshot caveat has to be visible, not implied by a tooltip.
    expect(screen.getByText(/a snapshot, not live/)).toBeInTheDocument();
  });

  it("reports a truncated library search rather than hiding it", () => {
    renderScope({
      librarySearchScope: "library",
      onSearchScopeChange: vi.fn(),
      libraryResultCount: 20000,
      libraryTruncated: true,
    });
    expect(screen.getByText(/\(partial\)/)).toBeInTheDocument();
  });

  it("refreshes the library snapshot on request", () => {
    const onRefreshLibrary = vi.fn();
    renderScope({
      librarySearchScope: "library",
      onSearchScopeChange: vi.fn(),
      onRefreshLibrary,
      libraryResultCount: 3,
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefreshLibrary).toHaveBeenCalled();
  });

  it("cannot return to a folder when none was open", () => {
    renderScope({
      librarySearchScope: "library",
      onSearchScopeChange: vi.fn(),
      canReturnToFolder: false,
    });
    expect(screen.getByRole("button", { name: "This folder" })).toBeDisabled();
  });
});
