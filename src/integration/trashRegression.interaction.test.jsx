import React, { useEffect, useMemo, useState } from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import useSelectionState from "../hooks/selection/useSelectionState";
import useTrashIntegration from "../hooks/actions/useTrashIntegration";
import MetadataPanel from "../components/MetadataPanel";
import FiltersPopover from "../components/FiltersPopover";

function Harness() {
  const selection = useSelectionState();
  const [videos, setVideos] = useState([
    { id: "keep", tags: ["alpha"], rating: null },
    { id: "trash", tags: ["beta"], rating: null },
  ]);
  const [filters, setFilters] = useState({
    includeTags: [],
    excludeTags: [],
    minRating: null,
    exactRating: null,
  });

  const integration = useTrashIntegration({
    electronAPI: undefined,
    notify: () => {},
    confirm: () => true,
    releaseVideoHandlesForAsync: () => Promise.resolve(),
    setVideos,
    setSelected: selection.setSelected,
    setLoadedIds: () => {},
    setPlayingIds: () => {},
    setVisibleIds: () => {},
    setLoadingIds: () => {},
    refreshTagList: () => {},
  });

  useEffect(() => {
    selection.setSelected(() => new Set(videos.map((video) => video.id)));
  }, [selection.setSelected, videos]);

  const selectedVideos = useMemo(() => {
    const map = new Map(videos.map((video) => [video.id, video]));
    return Array.from(selection.selected).map((id) => map.get(id)).filter(Boolean);
  }, [selection.selected, videos]);

  const handleFiltersChange = (updater) => {
    setFilters((prev) =>
      typeof updater === "function" ? updater(prev) ?? prev : { ...prev, ...updater }
    );
  };

  return (
    <div>
      <button onClick={() => integration.onItemsRemoved(new Set(["trash"]))}>
        Trash Selected
      </button>
      <MetadataPanel
        isOpen
        onToggle={() => {}}
        selectionCount={selection.size}
        selectedVideos={selectedVideos}
        availableTags={[{ name: "alpha", usageCount: 2 }]}
        onAddTag={() => {}}
        onRemoveTag={() => {}}
        onApplyTagToSelection={() => {}}
        onSetRating={() => {}}
        onClearRating={() => {}}
        focusToken={0}
        onFocusSelection={() => {}}
      />
      <FiltersPopover
        ref={null}
        filters={filters}
        availableTags={[{ name: "alpha", usageCount: 2 }]}
        onChange={handleFiltersChange}
        onReset={() =>
          setFilters({
            includeTags: [],
            excludeTags: [],
            minRating: null,
            exactRating: null,
          })
        }
        onClose={() => {}}
      />
    </div>
  );
}

describe("trash regression harness", () => {
  it("keeps metadata and filter inputs interactive after trash", async () => {
    render(<Harness />);

    const metadataInput = await screen.findByPlaceholderText("Add tag and press Enter");
    expect(metadataInput).not.toBeDisabled();

    const filterInput = screen.getByPlaceholderText("Search available tags");
    fireEvent.change(filterInput, { target: { value: "ab" } });
    expect(filterInput).toHaveValue("ab");

    fireEvent.click(screen.getByText("Trash Selected"));

    expect(metadataInput).not.toBeDisabled();

    fireEvent.change(filterInput, { target: { value: "abc" } });
    expect(filterInput).toHaveValue("abc");
  });
});
