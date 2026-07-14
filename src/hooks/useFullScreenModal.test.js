import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useFullScreenModal } from "./useFullScreenModal";

const makeVideos = () => [
  { id: "one", name: "one.mp4" },
  { id: "two", name: "two.mp4" },
  { id: "three", name: "three.mp4" },
];

describe("useFullScreenModal", () => {
  it("tracks the current ID across record replacement and closes if it disappears", () => {
    const videos = makeVideos();
    const rendered = renderHook(
      ({ items }) => useFullScreenModal(items),
      { initialProps: { items: videos } }
    );

    act(() => rendered.result.current.openFullScreen(videos[1], new Set()));
    expect(rendered.result.current.fullScreenVideo).toBe(videos[1]);

    const replaced = videos.map((video) => ({ ...video, updated: true }));
    rendered.rerender({ items: replaced });
    expect(rendered.result.current.fullScreenVideo).toBe(replaced[1]);

    rendered.rerender({ items: [replaced[0], replaced[2]] });
    expect(rendered.result.current.fullScreenVideo).toBeNull();

    rendered.rerender({ items: replaced });
    expect(rendered.result.current.fullScreenVideo).toBeNull();
  });

  it("navigates one ID at a time", () => {
    const videos = makeVideos();
    const { result } = renderHook(() => useFullScreenModal(videos));
    act(() => result.current.openFullScreen(videos[0]));

    act(() => result.current.navigateFullScreen("next"));
    expect(result.current.fullScreenVideo?.id).toBe("two");
    act(() => result.current.navigateFullScreen("prev"));
    expect(result.current.fullScreenVideo?.id).toBe("one");
  });
});
