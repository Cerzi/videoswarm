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

  // A library search is defined by its tags, so every test of a real search
  // has to carry one. Only the tests of the gate itself start empty.
  const taggedFilters = { ...baseFilters, includeTags: ["keeper"] };

  const renderScope = (props = {}) =>
    render(
      <FiltersPopover
        filters={taggedFilters}
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

  it("switches to a library search once a tag is included", () => {
    const onSearchScopeChange = vi.fn();
    renderScope({ onSearchScopeChange });
    fireEvent.click(screen.getByRole("button", { name: "Entire library" }));
    expect(onSearchScopeChange).toHaveBeenCalledWith("library");
  });

  // Without a tag the query has no constraint, so it would read the whole
  // profile into the grid and report itself truncated. That is a bound to hit
  // rather than a result anyone asked for.
  it("will not start a library search with no tag to search for", () => {
    const onSearchScopeChange = vi.fn();
    renderScope({ filters: baseFilters, onSearchScopeChange });

    const library = screen.getByRole("button", { name: "Entire library" });
    expect(library).toBeDisabled();
    fireEvent.click(library);
    expect(onSearchScopeChange).not.toHaveBeenCalled();
  });

  it("says why the library scope is unavailable instead of just dimming it", () => {
    renderScope({ filters: baseFilters, onSearchScopeChange: vi.fn() });
    expect(
      screen.getByText(/Include a tag above to search every root/)
    ).toBeInTheDocument();
  });

  // Removing the last tag mid-search leaves the scope where it is; the panel
  // has to ask for a tag rather than report an empty library.
  it("asks for a tag when the last one is removed mid-search", () => {
    renderScope({
      filters: baseFilters,
      librarySearchScope: "library",
      onSearchScopeChange: vi.fn(),
      onRefreshLibrary: vi.fn(),
      libraryResultCount: 0,
    });

    expect(
      screen.getByText(/Include a tag above to search every root/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/from every root/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
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
