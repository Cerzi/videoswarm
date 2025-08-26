import React, { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import VideoCard from "../components/VideoCard/VideoCard";

// Make cards visible immediately
class IO {
  constructor(cb) {
    this.cb = cb;
  }
  observe = (el) => this.cb([{ target: el, isIntersecting: true }]);
  unobserve() {}
  disconnect() {}
}

// Create a REAL <video> node then hook listeners (so DOM APIs like contains() work)
function makeRealVideoStub(realCreate) {
  const listeners = {};
  const el = realCreate("video");
  const origAdd = el.addEventListener.bind(el);
  const origRemove = el.removeEventListener.bind(el);

  el.addEventListener = (t, fn) => {
    listeners[t] = fn;
    origAdd(t, fn);
  };
  el.removeEventListener = (t, fn) => {
    delete listeners[t];
    origRemove(t, fn);
  };

  el.play = vi.fn(() => Promise.resolve());
  el.pause = vi.fn();
  el.load = vi.fn();

  return { el, listeners };
}

// Tiny harness that owns the video prop and can emulate “file changed”
function Harness({ initialVideo, onVideoRef }) {
  const [video, setVideo] = useState(initialVideo);
  // expose a way for the test to update the video (file-changed)
  onVideoRef.current = (next) => setVideo(next);

  return (
    <VideoCard
      video={video}
      isVisible
      isLoaded={false}
      isLoading={false}
      canLoadMoreVideos={() => true}
      onVideoLoad={() => {}}
    />
  );
}

async function tick(ms) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe("Integration: local transient unsupported → file-changed recovery", () => {
  let realCreate, createSpy;

  beforeEach(() => {
    vi.useFakeTimers();

    // Force deterministic scheduling in tests:
    //  - IntersectionObserver always intersects
    //  - Progressive list uses interval fallback (disable rIC)
    global.IntersectionObserver = IO;
    global.requestIdleCallback = undefined;

    realCreate = document.createElement.bind(document);
    createSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation((t, o) => realCreate(t, o));
  });

  afterEach(() => {
    createSpy.mockRestore();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("retries a local code-4 after file change and loads successfully", async () => {
    const first = makeRealVideoStub(realCreate);
    const second = makeRealVideoStub(realCreate);
    let created = 0;

    // First create() → first.el, second create() → second.el
    createSpy.mockImplementation((tag, opts) => {
      if (tag === "video") return (created++ === 0 ? first : second).el;
      return realCreate(tag, opts);
    });

    const base = {
      id: "/tmp/new.mp4",
      name: "new.mp4",
      fullPath: "/tmp/new.mp4",
      relativePath: "new.mp4",
      extension: ".mp4",
      isElectronFile: true, // local → first code-4 is transient
      size: 1024,
      dateModified: new Date().toISOString(),
      metadata: { folder: "/tmp" },
    };

    const onVideoRef = { current: () => {} };
    const { container } = render(
      <Harness initialVideo={base} onVideoRef={onVideoRef} />
    );

    // Allow initial effects; ensure error listener attached on first video
    for (let i = 0; i < 8 && typeof first.listeners.error !== "function"; i++) {
      await tick(25);
    }
    expect(typeof first.listeners.error).toBe("function");

    // First attempt fails with code 4 (transient)
    await act(async () => {
      first.listeners.error?.({ target: { error: { code: 4 } } });
    });

    // Emulate “file changed” arriving from watcher: bump size + mtime
    const changed = {
      ...base,
      size: 8 * 1024 * 1024,
      dateModified: new Date(Date.now() + 1000).toISOString(),
    };
    // Update harness video prop (this mimics your App responding to onFileChanged)
    await act(async () => {
      onVideoRef.current(changed);
    });

    // Allow the scheduled retry timeout (~1200ms in your component)
    await tick(1600);

    // Second attempt succeeds
    for (
      let i = 0;
      i < 8 && typeof second.listeners.loadeddata !== "function";
      i++
    ) {
      await tick(25);
    }
    await act(async () => {
      second.listeners.loadeddata?.();
    });

    const card = container.querySelector('[data-video-id="/tmp/new.mp4"]');
    expect(card).toBeTruthy();
    expect(card.getAttribute("data-loaded")).toBe("true");

    // Exactly two <video> nodes created: initial + retry
    const createdVideos = createSpy.mock.calls.filter(
      ([tag]) => tag === "video"
    ).length;
    expect(createdVideos).toBe(2);
  });
});
