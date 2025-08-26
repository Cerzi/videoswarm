import React from "react";
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useRef } from "react";
import { useAdoptedVideo } from "./useAdoptedVideo";

function Harness({ currentVideo, gridRef }) {
  const { adoptHostRef, fallbackRef, activeVideoRef, usingAdopted } =
    useAdoptedVideo(currentVideo, gridRef);

  return (
    <div>
      <div data-testid="host" ref={adoptHostRef} />
      <video data-testid="fallback" ref={fallbackRef} />
      <div data-testid="flags" data-using-adopted={usingAdopted ? "1" : "0"} />
      <div data-testid="active-is-fallback" data-active={activeVideoRef === fallbackRef ? "1" : "0"} />
    </div>
  );
}

describe("useAdoptedVideo", () => {
  it("adopts an existing grid video and restores on cleanup", () => {
    const grid = document.createElement("div");
    const card = document.createElement("div");
    card.dataset.videoId = "v1";
    const vid = document.createElement("video");
    card.appendChild(vid);
    grid.appendChild(card);
    document.body.appendChild(grid);

    const gridRef = { current: grid };

    const { getByTestId, unmount } = render(
      <Harness currentVideo={{ id: "v1" }} gridRef={gridRef} />
    );

    const host = getByTestId("host");
    expect(host.contains(vid)).toBe(true);
    expect(getByTestId("flags").dataset.usingAdopted).toBe("1");

    unmount();
    // On cleanup it should restore to original parent
    expect(card.contains(vid)).toBe(true);
    document.body.removeChild(grid);
  });

  it("uses fallback when no grid video exists", () => {
    const gridRef = { current: document.createElement("div") };
    const { getByTestId } = render(
      <Harness currentVideo={{ id: "v2" }} gridRef={gridRef} />
    );

    const fallback = getByTestId("fallback");
    expect(getByTestId("host").contains(fallback)).toBe(false);
    expect(getByTestId("flags").dataset.usingAdopted).toBe("0");
    expect(getByTestId("active-is-fallback").dataset.active).toBe("1");
  });
});
