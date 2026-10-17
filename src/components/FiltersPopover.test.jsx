import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

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

  // With nothing to narrow it, the library search is the whole library.
  it("searches the whole library with no filter, even with no folder open", () => {
    const onSearchScopeChange = vi.fn();
    renderScope({ filters: baseFilters, onSearchScopeChange, canReturnToFolder: false });

    const library = screen.getByRole("button", { name: "Entire library" });
    expect(library).not.toBeDisabled();
    fireEvent.click(library);
    expect(onSearchScopeChange).toHaveBeenCalledWith("library");
    expect(screen.getByRole("button", { name: "This folder" })).toBeDisabled();
  });

  it("offers a library search for a rating alone", () => {
    const onSearchScopeChange = vi.fn();
    renderScope({ filters: { ...baseFilters, minRating: 4 }, onSearchScopeChange });
    const library = screen.getByRole("button", { name: "Entire library" });
    expect(library).not.toBeDisabled();
    fireEvent.click(library);
    expect(onSearchScopeChange).toHaveBeenCalledWith("library");
  });

  // Removing the last tag mid-search leaves the whole library.
  it("reports the whole library when the last filter is removed mid-search", () => {
    renderScope({
      filters: baseFilters,
      librarySearchScope: "library",
      onSearchScopeChange: vi.fn(),
      onRefreshLibrary: vi.fn(),
      libraryResultCount: 1200,
    });

    expect(screen.getByText(/1,200 clips from every root/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).not.toBeDisabled();
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

describe("FiltersPopover generation versions", () => {
  const filters = {
    includeTags: [],
    excludeTags: [],
    minRating: null,
    exactRating: null,
    reviewFilter: "any",
    versionFilter: "any",
  };

  it("selects a version filter without touching the others", () => {
    let current = { ...filters, maxMegapixels: 0.5 };
    const onChange = vi.fn((updater) => {
      current = updater(current);
    });
    render(
      <FiltersPopover filters={current} onChange={onChange} onReset={vi.fn()} onClose={vi.fn()} />
    );
    const group = within(screen.getByRole("group", { name: "Generation versions" }));
    expect(group.getByRole("button", { name: "Any" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(group.getByRole("button", { name: "Best version" }));
    expect(current).toMatchObject({ versionFilter: "best", maxMegapixels: 0.5 });
  });

  it("states that results are provisional while keys are pending", () => {
    const onFind = vi.fn();
    const { rerender } = render(
      <FiltersPopover
        filters={filters}
        onChange={vi.fn()}
        onReset={vi.fn()}
        onClose={vi.fn()}
        versionPendingCount={1204}
        onFindVersionsInLibrary={onFind}
      />
    );
    expect(screen.getByText(/Finding versions… 1,204 clips left/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search library" }));
    expect(onFind).toHaveBeenCalledTimes(1);

    rerender(
      <FiltersPopover
        filters={filters}
        onChange={vi.fn()}
        onReset={vi.fn()}
        onClose={vi.fn()}
        versionIndexStatus={{ running: true, scope: "library", processed: 10, total: 50 }}
        onFindVersionsInLibrary={onFind}
      />
    );
    expect(screen.getByText(/across the library… 10 of 50/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Search library" }).disabled).toBe(true);
  });
});

describe("FiltersPopover tag hierarchy", () => {
  const filters = {
    includeTags: [],
    excludeTags: [],
    minRating: null,
    exactRating: null,
  };
  const availableTags = [
    { name: "dance", usageCount: 3, parent: null },
    { name: "bellydance", usageCount: 2, parent: "dance" },
    { name: "outdoor", usageCount: 1, parent: null },
  ];
  const renderPopover = (onSetTagParent) =>
    render(
      <FiltersPopover
        filters={filters}
        availableTags={availableTags}
        onChange={vi.fn()}
        onReset={vi.fn()}
        onClose={vi.fn()}
        onSetTagParent={onSetTagParent}
      />
    );
  const row = (name) =>
    screen.getByText(`#${name}`).closest(".filters-tag-option");

  it("shows where a nested tag sits", () => {
    renderPopover(vi.fn());
    expect(within(row("bellydance")).getByText("in dance")).toBeInTheDocument();
    expect(within(row("dance")).queryByText(/^in /)).toBeNull();
  });

  it("puts a tag under another and moves it back to the top level", async () => {
    const onSetTagParent = vi.fn(async () => ({ success: true }));
    renderPopover(onSetTagParent);

    fireEvent.click(within(row("outdoor")).getByRole("button", { name: "Parent" }));
    const input = within(row("outdoor")).getByPlaceholderText("parent tag");
    fireEvent.change(input, { target: { value: "dance" } });
    fireEvent.click(within(row("outdoor")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSetTagParent).toHaveBeenCalledWith("outdoor", "dance"));
    await waitFor(() =>
      expect(within(row("outdoor")).queryByPlaceholderText("parent tag")).toBeNull()
    );

    fireEvent.click(within(row("bellydance")).getByRole("button", { name: "Parent" }));
    fireEvent.click(within(row("bellydance")).getByRole("button", { name: "Top level" }));
    await waitFor(() => expect(onSetTagParent).toHaveBeenLastCalledWith("bellydance", null));
  });

  it("keeps the editor open and says why when a move is refused", async () => {
    const onSetTagParent = vi.fn(async () => ({
      success: false,
      error: '"bellydance" is already inside "dance"',
    }));
    renderPopover(onSetTagParent);
    fireEvent.click(within(row("dance")).getByRole("button", { name: "Parent" }));
    fireEvent.change(within(row("dance")).getByPlaceholderText("parent tag"), {
      target: { value: "bellydance" },
    });
    fireEvent.click(within(row("dance")).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already inside");
    expect(within(row("dance")).getByPlaceholderText("parent tag")).toHaveValue("bellydance");
  });

  it("offers no parent editing without a handler", () => {
    renderPopover(undefined);
    expect(within(row("dance")).queryByRole("button", { name: "Parent" })).toBeNull();
  });
});


describe("FiltersPopover prompt search", () => {
  it("searches prompt words and says while it is searching", () => {
    let current = { reviewFilter: "any" };
    const onChange = vi.fn((updater) => {
      current = updater(current);
    });
    const { rerender } = render(
      <FiltersPopover filters={current} onChange={onChange} onReset={vi.fn()} onClose={vi.fn()} />
    );
    fireEvent.change(screen.getByRole("searchbox", { name: "Words in the prompt" }), {
      target: { value: "lighthouse -fog" },
    });
    expect(current.promptQuery).toBe("lighthouse -fog");
    rerender(
      <FiltersPopover
        filters={current}
        onChange={onChange}
        onReset={vi.fn()}
        onClose={vi.fn()}
        promptSearch={{ pending: true, unread: 0 }}
      />
    );
    expect(screen.getByText("Searching prompts…")).toBeInTheDocument();
  });

  it("offers a library search for prompt words alone", () => {
    const onSearchScopeChange = vi.fn();
    render(
      <FiltersPopover
        filters={{ promptQuery: "lighthouse" }}
        onChange={vi.fn()}
        onReset={vi.fn()}
        onClose={vi.fn()}
        onSearchScopeChange={onSearchScopeChange}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Entire library" }));
    expect(onSearchScopeChange).toHaveBeenCalledWith("library");
  });
});

describe("FiltersPopover companion app", () => {
  const companion = {
    name: "Helper",
    status: "online",
    actions: [
      { id: "polish", label: "Polish", hint: "Makes a better copy" },
      { id: "enlarge", label: "Enlarge" },
    ],
  };

  it("is absent without a connected companion", () => {
    render(<FiltersPopover filters={{}} onChange={vi.fn()} onReset={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByText("Hide clips already sent")).toBeNull();
  });

  it("filters each described action by phase and hides clips already sent", () => {
    let current = { reviewFilter: "pick", companionFilters: { enlarge: "done" } };
    const onChange = vi.fn((updater) => {
      current = updater(current);
    });
    const { rerender } = render(
      <FiltersPopover
        filters={current}
        onChange={onChange}
        onReset={vi.fn()}
        onClose={vi.fn()}
        companion={companion}
      />
    );
    expect(screen.getByText("Helper")).toBeInTheDocument();
    const polish = within(screen.getByRole("group", { name: "Polish" }));
    fireEvent.click(polish.getByRole("button", { name: "Not sent" }));
    expect(current).toEqual({
      reviewFilter: "pick",
      companionFilters: { enlarge: "done", polish: "not-sent" },
    });

    rerender(
      <FiltersPopover
        filters={current}
        onChange={onChange}
        onReset={vi.fn()}
        onClose={vi.fn()}
        companion={companion}
      />
    );
    const enlarge = within(screen.getByRole("group", { name: "Enlarge" }));
    expect(enlarge.getByRole("button", { name: "Done" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(enlarge.getByRole("button", { name: "Any" }));
    expect(current.companionFilters).toEqual({ polish: "not-sent" });

    fireEvent.click(screen.getByRole("checkbox", { name: "Hide clips already sent" }));
    expect(current.companionHideSent).toBe(true);
  });

  it("says when the companion is not answering", () => {
    render(
      <FiltersPopover
        filters={{}}
        onChange={vi.fn()}
        onReset={vi.fn()}
        onClose={vi.fn()}
        companion={{ ...companion, status: "offline" }}
      />
    );
    expect(screen.getByText("Not answering; showing its last answers.")).toBeInTheDocument();
  });
});

describe("FiltersPopover might be", () => {
  const status = {
    pending: false,
    tags: [
      { name: "dance", examples: 14, usable: true, precision: 0.92, recall: 0.6 },
      { name: "keeper", examples: 30, usable: false, precision: null, recall: null },
    ],
  };

  it("lists the tags that can be suggested and names the ones the prompt cannot tell", () => {
    let current = { reviewFilter: "any" };
    const onChange = vi.fn((updater) => {
      current = updater(current);
    });
    render(
      <FiltersPopover
        filters={current}
        onChange={onChange}
        onReset={vi.fn()}
        onClose={vi.fn()}
        likelyTagStatus={status}
      />
    );
    const select = screen.getByRole("combobox", { name: "Might be tagged" });
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Any clip",
      "dance · right 92%",
    ]);
    expect(screen.getByText("Not told by the prompt: keeper.")).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "dance" } });
    expect(current.mightBe).toBe("dance");
  });

  it("says while it learns, and what the filter shows once a tag is chosen", () => {
    const { rerender } = render(
      <FiltersPopover
        filters={{}}
        onChange={vi.fn()}
        onReset={vi.fn()}
        onClose={vi.fn()}
        likelyTagStatus={{ tags: null, pending: true }}
      />
    );
    expect(screen.getByText("Learning from your tags…")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Might be tagged" })).toBeDisabled();
    rerender(
      <FiltersPopover
        filters={{ mightBe: "dance" }}
        onChange={vi.fn()}
        onReset={vi.fn()}
        onClose={vi.fn()}
        likelyTagStatus={status}
        mightBe={{ pending: false, usable: true }}
      />
    );
    expect(screen.getByText(/Clips not tagged "dance" whose prompts suggest it/)).toBeInTheDocument();
  });

  it("offers a library search for a tag clips might be", () => {
    const onSearchScopeChange = vi.fn();
    render(
      <FiltersPopover
        filters={{ mightBe: "dance" }}
        onChange={vi.fn()}
        onReset={vi.fn()}
        onClose={vi.fn()}
        onSearchScopeChange={onSearchScopeChange}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Entire library" }));
    expect(onSearchScopeChange).toHaveBeenCalledWith("library");
  });
});
