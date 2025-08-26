// src/components/FullScreenModal.test.jsx
import React from "react";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { vi, beforeAll, afterAll, afterEach, describe, it, expect } from "vitest";
import FullScreenModal from "./FullScreenModal";

// ---- JSDOM media stubs so play/pause actually flips paused state ----
const restore = {};
beforeAll(() => {
  restore.play = Object.getOwnPropertyDescriptor(
    window.HTMLMediaElement.prototype,
    "play"
  );
  restore.pause = Object.getOwnPropertyDescriptor(
    window.HTMLMediaElement.prototype,
    "pause"
  );
  restore.paused = Object.getOwnPropertyDescriptor(
    window.HTMLMediaElement.prototype,
    "paused"
  );

  Object.defineProperty(window.HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: vi.fn().mockImplementation(function () {
      this.paused = false;
      return Promise.resolve();
    }),
  });
  Object.defineProperty(window.HTMLMediaElement.prototype, "pause", {
    configurable: true,
    value: vi.fn().mockImplementation(function () {
      this.paused = true;
    }),
  });
  Object.defineProperty(window.HTMLMediaElement.prototype, "paused", {
    configurable: true,
    writable: true,
    value: true,
  });
});

afterAll(() => {
  if (restore.play) Object.defineProperty(window.HTMLMediaElement.prototype, "play", restore.play);
  if (restore.pause) Object.defineProperty(window.HTMLMediaElement.prototype, "pause", restore.pause);
  if (restore.paused) Object.defineProperty(window.HTMLMediaElement.prototype, "paused", restore.paused);
});

afterEach(() => {
  cleanup();
  // Clean any grid nodes we appended directly to body
  Array.from(document.querySelectorAll("[data-video-id]")).forEach((n) => n.parentElement?.remove());
});

// ---- helpers ----
function makeVideo(id, name = id, extras = {}) {
  return { id, name, ...extras };
}

function mountGridWithVideo(videoId) {
  // Append the grid to <body> so the component’s DOM and our assertions share the same root.
  const card = document.createElement("div");
  card.setAttribute("data-video-id", videoId);

  const el = document.createElement("video");
  // Make it adoptable
  Object.defineProperty(el, "readyState", { configurable: true, value: 4 });
  el.paused = true;

  card.appendChild(el);
  document.body.appendChild(card);

  return {
    gridVideo: el,
    originalParent: card,
    cleanup: () => card.remove(),
  };
}

describe("FullScreenModal (behavioral)", () => {
  it("toggles play/pause on adopted element via Space", async () => {
    const id = "/tmp/new.mp4";
    const { gridVideo, originalParent } = mountGridWithVideo(id);
    const gridRef = { current: document.body }; // component queries inside this root

    const video = makeVideo(id, "new.mp4");

    // IMPORTANT: render into document.body so modal is visible to our queries
    render(
      <FullScreenModal
        video={video}
        videos={[video]}
        initialVideo={video}
        gridRef={gridRef}
        onClose={() => {}}
        onNavigate={() => {}}
        showFilenames
      />,
      { container: document.body }
    );

    // Wait for adoption: video should be moved from its original card
    await waitFor(() => {
      expect(gridVideo.parentElement).not.toBe(originalParent);
    });

    // Auto-plays on open
    await waitFor(() => {
      expect(gridVideo.paused).toBe(false);
    });

    // Space -> pause
    fireEvent.keyDown(document, { key: " ", code: "Space" });
    await waitFor(() => {
      expect(gridVideo.paused).toBe(true);
    });

    // Space -> play
    fireEvent.keyDown(document, { key: " ", code: "Space" });
    await waitFor(() => {
      expect(gridVideo.paused).toBe(false);
    });
  });

  it("uses fallback video if no adoption target is found", async () => {
    // No matching [data-video-id] in the grid root
    const gridRef = { current: document.body };
    const video = makeVideo("/tmp/missing.mp4", "missing.mp4");

    render(
      <FullScreenModal
        video={video}
        videos={[video]}
        initialVideo={video}
        gridRef={gridRef}
        onClose={() => {}}
        onNavigate={() => {}}
        showFilenames
      />,
      { container: document.body }
    );

    // Only the modal's fallback video should exist
    await waitFor(() => {
      const vids = Array.from(document.querySelectorAll("video"));
      expect(vids.length).toBe(1);
    });

    const fallbackVideo = document.querySelector("video");
    expect(fallbackVideo).toBeTruthy();

    // Space toggles
    expect(fallbackVideo.paused).toBe(true);
    fireEvent.keyDown(document, { key: " ", code: "Space" });
    await waitFor(() => {
      expect(fallbackVideo.paused).toBe(false);
    });
    fireEvent.keyDown(document, { key: " ", code: "Space" });
    await waitFor(() => {
      expect(fallbackVideo.paused).toBe(true);
    });
  });

  it("ESC closes and arrows navigate (callbacks fire)", async () => {
    const id = "/tmp/has-grid.mp4";
    const { gridVideo, originalParent } = mountGridWithVideo(id);
    const gridRef = { current: document.body };
    const video = makeVideo(id, "has-grid.mp4");

    const onClose = vi.fn();
    const onNavigate = vi.fn();

    render(
      <FullScreenModal
        video={video}
        videos={[video]}
        initialVideo={video}
        gridRef={gridRef}
        onClose={onClose}
        onNavigate={onNavigate}
        showFilenames
      />,
      { container: document.body }
    );

    // Ensure adoption occurred (modal is mounted/active)
    await waitFor(() => {
      expect(gridVideo.parentElement).not.toBe(originalParent);
    });

    fireEvent.keyDown(document, { key: "ArrowRight" });
    fireEvent.keyDown(document, { key: "ArrowLeft" });

    // Depending on your controller wiring, next might be first, but both should be called once.
    expect(onNavigate).toHaveBeenCalledWith("next");
    expect(onNavigate).toHaveBeenCalledWith("prev");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });
});
