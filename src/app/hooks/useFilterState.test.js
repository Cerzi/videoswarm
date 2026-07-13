import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { useFilterState } from "./useFilterState";

const videos = [
  { id: "new", tags: ["wan"], rating: null, reviewState: "unreviewed" },
  { id: "done", tags: ["wan"], rating: 4, reviewState: "reviewed" },
  { id: "pick", tags: ["hunyuan"], rating: 5, reviewState: "pick" },
  { id: "reject", tags: [], rating: 1, reviewState: "reject" },
];

describe("useFilterState review filters", () => {
  const renderFilters = () =>
    renderHook(() =>
      useFilterState({
        videos,
        filtersButtonRef: createRef(),
        filtersPopoverRef: createRef(),
      })
    );

  it("treats picks and rejects as reviewed while preserving exact states", () => {
    const { result } = renderFilters();

    act(() => result.current.updateFilters({ reviewFilter: "reviewed" }));
    expect(result.current.filteredVideos.map((video) => video.id)).toEqual([
      "done",
      "pick",
      "reject",
    ]);

    act(() => result.current.updateFilters({ reviewFilter: "pick" }));
    expect(result.current.filteredVideos.map((video) => video.id)).toEqual([
      "pick",
    ]);
    expect(result.current.filtersActiveCount).toBe(1);
  });

  it("combines review state with tags and ratings", () => {
    const { result } = renderFilters();
    act(() =>
      result.current.updateFilters({
        includeTags: ["wan"],
        minRating: 3,
        reviewFilter: "reviewed",
      })
    );
    expect(result.current.filteredVideos.map((video) => video.id)).toEqual([
      "done",
    ]);
    expect(result.current.filtersActiveCount).toBe(3);
  });
});
