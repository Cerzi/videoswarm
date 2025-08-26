import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, screen } from "@testing-library/react";
import VideoCard from "../VideoCard";

// Make cards visible immediately
class IO {
  constructor(cb) {
    this.cb = cb;
  }
  observe = (el) => this.cb([{ target: el, isIntersecting: true }]);
  unobserve() {}
  disconnect() {}
}

function makeVideoStub(realCreate) {
  const listeners = {};
  const el = realCreate("video"); // real node so container.contains(el) is valid

  const origAdd = el.addEventListener.bind(el);
  const origRemove = el.removeEventListener.bind(el);

  el.addEventListener = (t, fn) => {
    listeners[t] = fn;
    origAdd(t, fn);
  };
  el.removeEventListener = (t) => {
    delete listeners[t];
    origRemove(t, listeners[t]);
  };

  // Patch media methods
  el.play = vi.fn(() => Promise.resolve());
  el.pause = vi.fn();
  el.load = vi.fn();

  return { el, listeners };
}

async function tick(ms) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}
async function waitListener(listeners, name, steps = 12, stepMs = 50) {
  for (let i = 0; i < steps; i++) {
    if (typeof listeners[name] === "function") return;
    await tick(stepMs);
  }
  throw new Error(`Listener '${name}' not attached`);
}

describe("VideoCard local transient errors", () => {
  let createSpy, realCreate, realRAF, realCAF;

  beforeEach(() => {
    vi.useFakeTimers();
    global.IntersectionObserver = IO;

    // Pair rAF/cAF with timers (in case vitest.setup isn't loaded)
    realRAF = global.requestAnimationFrame;
    realCAF = global.cancelAnimationFrame;
    global.requestAnimationFrame = (cb) => setTimeout(cb, 16);
    global.cancelAnimationFrame = (id) => clearTimeout(id);

    realCreate = document.createElement.bind(document);
    createSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation((t, o) => realCreate(t, o));
  });

  afterEach(() => {
    createSpy.mockRestore();
    global.requestAnimationFrame = realRAF;
    global.cancelAnimationFrame = realCAF;
    vi.useRealTimers();
  });

  it("retries after a first local code-4 and recovers", async () => {
    vi.useFakeTimers();

    // real Node-based stubs (your file already has makeVideoStub(realCreate))
    const first = makeVideoStub(realCreate);
    const second = makeVideoStub(realCreate);

    let creates = 0;
    createSpy.mockImplementation((tag, opts) => {
      if (tag === "video") return creates++ === 0 ? first.el : second.el;
      return realCreate(tag, opts);
    });

    render(
      <VideoCard
        video={{
          id: "/tmp/new.mp4",
          name: "new.mp4",
          fullPath: "/tmp/new.mp4",
          isElectronFile: true, // local → first code-4 is transient
          size: 1024,
          dateModified: new Date().toISOString(),
        }}
        isVisible
        isLoaded={false}
        isLoading={false}
        canLoadMoreVideos={() => true}
        // onVideoLoad not asserted anymore (no longer guaranteed)
      />
    );

    // Let the element mount and attach listeners
    for (let i = 0; i < 8 && typeof first.listeners.error !== "function"; i++) {
      await act(async () => {
        vi.advanceTimersByTime(25);
      });
    }

    // First error (transient)
    await act(async () => {
      first.listeners.error?.({ target: { error: { code: 4 } } });
    });

    // Retry timeout (~1.2s)
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });

    // Ensure retry has listeners, then succeed
    for (
      let i = 0;
      i < 8 && typeof second.listeners.loadeddata !== "function";
      i++
    ) {
      await act(async () => {
        vi.advanceTimersByTime(25);
      });
    }
    await act(async () => {
      second.listeners.loadeddata?.();
    });

    // ✅ Assert by UI/DOM state, not callback
    const card = document.querySelector('[data-video-id="/tmp/new.mp4"]');
    expect(card).toBeTruthy();
    expect(card.getAttribute("data-loaded")).toBe("true");

    // Placeholder no longer shows error glyph
    const ph = document.querySelector(".video-placeholder");
    expect(ph?.textContent ?? "").not.toMatch(/⚠/);

    // Exactly two <video> creations (initial + retry)
    const createdVideos = createSpy.mock.calls.filter(
      ([tag]) => tag === "video"
    ).length;
    expect(createdVideos).toBe(2);
  }, 10000);

  it("marks permanent after two code-4 attempts (no further retries)", async () => {
    const first = makeVideoStub(realCreate);
    const second = makeVideoStub(realCreate);

    let creates = 0;
    createSpy.mockImplementation((tag, opts) => {
      if (tag === "video") return creates++ === 0 ? first.el : second.el;
      return realCreate(tag, opts);
    });

    render(
      <VideoCard
        video={{
          id: "/tmp/bad.mkv",
          name: "bad.mkv",
          fullPath: "/tmp/bad.mkv",
          isElectronFile: true,
          size: 2048,
          dateModified: new Date().toISOString(),
        }}
        isVisible
        isLoaded={false}
        isLoading={false}
        canLoadMoreVideos={() => true}
      />
    );

    await tick(80);
    await waitListener(first.listeners, "error");

    // First error (transient)
    await act(async () => {
      first.listeners.error?.({ target: { error: { code: 4 } } });
    });

    // Wait for retry, then second error → permanent
    await tick(1600);
    await waitListener(second.listeners, "error");
    await act(async () => {
      second.listeners.error?.({ target: { error: { code: 4 } } });
    });

    const createdAfterSecond = creates;
    await tick(3000);
    // No third creation (permanent)
    expect(creates).toBe(createdAfterSecond);
  }, 10000);

  it("clears error when file content changes and can load again", async () => {
    const first = makeVideoStub(realCreate);
    const second = makeVideoStub(realCreate);

    let creates = 0;
    createSpy.mockImplementation((tag, opts) => {
      if (tag === "video") {
        const stub =
          (creates++ === 0 ? first : second) ?? makeVideoStub(realCreate);
        return stub.el;
      }
      return realCreate(tag, opts);
    });

    const base = {
      id: "/tmp/new.mp4",
      name: "new.mp4",
      fullPath: "/tmp/new.mp4",
      isElectronFile: true,
      size: 1024,
      dateModified: new Date().toISOString(),
    };

    const { rerender } = render(
      <VideoCard
        video={base}
        isVisible
        isLoaded={false}
        isLoading={false}
        canLoadMoreVideos={() => true}
      />
    );

    await tick(80);
    await waitListener(first.listeners, "error");

    // First error (transient)
    await act(async () => {
      first.listeners.error?.({ target: { error: { code: 4 } } });
    });

    // Simulate file change (App would pass new object w/ updated size/mtime)
    const changed = {
      ...base,
      size: base.size + 4096,
      dateModified: new Date(Date.now() + 1000).toISOString(),
    };
    rerender(
      <VideoCard
        video={changed}
        isVisible
        isLoaded={false}
        isLoading={false}
        canLoadMoreVideos={() => true}
      />
    );

    // Retry after change
    await tick(1600);
    second.el.dataset.adopted = "modal";
    await act(async () => {
      second.listeners.loadeddata?.();
    });

    expect(screen.getByText(/new\.mp4/i)).toBeInTheDocument();
    const createdVideos = createSpy.mock.calls.filter(
      ([tag]) => tag === "video"
    ).length;
    expect(createdVideos).toBe(2);
  }, 10000);
});
