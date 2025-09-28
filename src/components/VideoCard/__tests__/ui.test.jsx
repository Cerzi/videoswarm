// src/components/VideoCard/VideoCard.test.jsx
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import * as mediaModule from "../../../utils/media";
import VideoCard from "../VideoCard";

// Keep a handle to the native createElement so our mocks can delegate safely
const NATIVE_CREATE_ELEMENT = document.createElement.bind(document);

// --- IntersectionObserver mock: immediately marks the card visible ---
class IO {
  constructor(cb) {
    this.cb = cb;
  }
  observe = (el) => {
    this.cb([{ target: el, isIntersecting: true }]);
  };
  disconnect = () => {};
}

beforeEach(() => {
  // @ts-ignore
  global.IntersectionObserver = IO;
});

let lastVideoEl;
let hardTeardownSpy;

// --- Base createElement mock: augment a REAL <video> Node so DOM APIs work ---
beforeEach(() => {
  lastVideoEl = undefined;
  vi.spyOn(document, "createElement").mockImplementation((tag, opts) => {
    const el = NATIVE_CREATE_ELEMENT(tag, opts); // keep a real Node
    if (tag !== "video") return el;

    // Provide predictable media APIs on JSDOM video elements
    Object.assign(el, {
      preload: "none",
      muted: false,
      loop: false,
      playsInline: false,
      src: "",
      load: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      removeAttribute: vi.fn(function (name) {
        if (name === "src") this.src = "";
        HTMLElement.prototype.removeAttribute.call(this, name);
      }),
      remove: vi.fn(function () {
        if (this.parentNode) this.parentNode.removeChild(this);
      }),
    });

    lastVideoEl = el; // capture for assertions in other tests
    return el;
  });

  hardTeardownSpy = vi
    .spyOn(mediaModule, "hardTeardownVideo")
    .mockImplementation((el) => {
      try { el?.pause?.(); } catch {}
      try { el?.remove?.(); } catch {}
    });
});

afterEach(() => {
  vi.restoreAllMocks();
  hardTeardownSpy = undefined;
});

// --- Common props scaffold ---
const baseProps = {
  selected: false,
  onSelect: vi.fn(),
  onContextMenu: vi.fn(),
  isPlaying: false,
  isLoaded: false,
  isLoading: false,
  isVisible: true,
  showFilenames: false,
  canLoadMoreVideos: () => true,
  onStartLoading: vi.fn(),
  onStopLoading: vi.fn(),
  onVideoLoad: vi.fn(),
  onVideoPlay: vi.fn(),
  onVideoPause: vi.fn(),
  onPlayError: vi.fn(),
  onVisibilityChange: vi.fn(),
  onHover: vi.fn(),
  ioRoot: { current: null },
  evictionVictims: [],
};

describe("VideoCard", () => {
  it("shows terminal error for non-local code 4 and does not retry", async () => {
    // Override the base createElement mock JUST for this test to make load() throw during init.
    document.createElement.mockImplementation((tag, opts) => {
      const el = NATIVE_CREATE_ELEMENT(tag, opts);
      if (tag === "video") {
        // Ensure media stubs exist
        el.pause = vi.fn();
        el.play = vi.fn().mockResolvedValue(undefined);
        // Force the initial load() inside runInit to throw ⇒ triggers onErr/UI error immediately
        el.load = vi.fn(() => {
          const err = new Error("load failed");
          err.name = "NotSupportedError";
          throw err;
        });
      }
      return el;
    });

    // Non-local video so the first error ends up as an immediate UI error
    render(
      <VideoCard
        video={{
          id: "v1",
          name: "v1",
          fullPath: "/remote/v1.mp4",
          isElectronFile: false,
        }}
        isVisible
        isLoaded={false}
        isLoading={false}
        scheduleInit={(fn) => fn()}
        canLoadMoreVideos={() => true}
      />
    );

    // Allow effects to run; load() throws during init and sets errorText
    await act(async () => {});

    // Assert error marker appears (match several possible labels)
    const placeholder = await screen.findByText(
      /⚠|Cannot decode|Error|Failed to load/i
    );
    expect(placeholder).toBeTruthy();

    // No retry (just one <video> created)
    const createdVideos = document.createElement.mock.calls.filter(
      ([t]) => t === "video"
    ).length;
    expect(createdVideos).toBe(1);
  });

  it("builds proper file:// URL (no %5C)", async () => {
    const video = {
      id: "v2",
      name: "v2",
      isElectronFile: true,
      fullPath: "C:\\Users\\me\\a b#c.mp4",
    };

    render(<VideoCard {...baseProps} video={video} />);

    // Allow loadVideo to run and set el.src
    await act(async () => {});

    const created = lastVideoEl;
    expect(created).toBeTruthy();

    // src should already be set by the component
    expect(created.src).toMatch(/^file:\/\//);
    expect(created.src.includes("%5C")).toBe(false);
    expect(created.src).toContain("/C:/Users/me/a%20b%23c.mp4");

    // Optionally finish the "load" to attach <video> into the container
    await act(async () => {
      created.dispatchEvent?.(new Event("loadedmetadata"));
      created.dispatchEvent?.(new Event("canplay"));
    });
  });

  it("loads when parent marks visible even if IntersectionObserver never fires", async () => {
    // Mock IO that never calls the callback (no visibility events)
    const PrevIO = global.IntersectionObserver;
    class IO_NoFire {
      constructor() {}
      observe() {}
      disconnect() {}
    }
    // @ts-ignore
    global.IntersectionObserver = IO_NoFire;

    try {
      const video = {
        id: "v3",
        name: "v3",
        isElectronFile: true,
        fullPath: "C:\\Users\\me\\visible-only.mp4",
      };

      render(<VideoCard {...baseProps} video={video} isVisible={true} />);

      // Allow the backup effect (microtask) to run
      await act(async () => {});

      // The backup effect should have triggered a load
      expect(lastVideoEl).toBeTruthy();
      expect(lastVideoEl.src).toMatch(/^file:\/\//);
      expect(lastVideoEl.src.includes("%5C")).toBe(false);
    } finally {
      // @ts-ignore
      global.IntersectionObserver = PrevIO;
    }
  });

  it("does not auto-load if not visible and IntersectionObserver never fires", async () => {
    // Mock IO that never calls the callback (no visibility events)
    const PrevIO = global.IntersectionObserver;
    class IO_NoFire {
      constructor() {}
      observe() {}
      disconnect() {}
    }
    // @ts-ignore
    global.IntersectionObserver = IO_NoFire;

    try {
      const video = {
        id: "v4",
        name: "v4",
        isElectronFile: true,
        fullPath: "C:\\Users\\me\\not-visible.mp4",
      };

      render(<VideoCard {...baseProps} video={video} isVisible={false} />);

      // Let effects/microtasks flush
      await act(async () => {});

      // No IO event and not visible ⇒ should NOT load
      expect(lastVideoEl).toBeUndefined();
    } finally {
      // @ts-ignore
      global.IntersectionObserver = PrevIO;
    }
  });

  it("prefetches once the card is near the viewport", async () => {
    const video = {
      id: "near-prefetch",
      name: "near-prefetch",
      isElectronFile: true,
      fullPath: "C:/videos/near.mp4",
    };

    const observeIntersection = vi.fn((el, maybeId, maybeCb) => {
      const cb = typeof maybeId === "function" ? maybeId : maybeCb;
      if (cb) cb(false, null, { visible: false, near: true });
    });
    const unobserveIntersection = vi.fn();
    const onStartLoading = vi.fn();

    render(
      <VideoCard
        {...baseProps}
        video={video}
        isVisible={false}
        observeIntersection={observeIntersection}
        unobserveIntersection={unobserveIntersection}
        onStartLoading={onStartLoading}
        scheduleInit={(fn) => fn()}
      />
    );

    await act(async () => {});

    expect(onStartLoading).toHaveBeenCalledWith(video.id);
    expect(lastVideoEl).toBeTruthy();
  });

  it("clears stale video elements before attaching a new playback node", async () => {
    const video = {
      id: "duplicate-cleanup",
      name: "duplicate-cleanup",
      isElectronFile: true,
      fullPath: "C:/videos/dup.mp4",
    };

    const createdVideos = [];
    const baseMock = document.createElement.getMockImplementation();
    document.createElement.mockImplementation((tag, opts) => {
      const el = baseMock(tag, opts);
      if (tag === "video") {
        createdVideos.push(el);
      }
      return el;
    });

    let canLoad = true;
    const { rerender, container } = render(
      <VideoCard
        {...baseProps}
        video={video}
        isVisible
        canLoadMoreVideos={() => canLoad}
        scheduleInit={(fn) => fn()}
      />
    );

    await act(async () => {});

    const firstEl = createdVideos[0];
    expect(firstEl).toBeTruthy();

    await act(async () => {
      firstEl.dispatchEvent?.(new Event("loadeddata"));
    });

    const cardContainer = container.querySelector(
      `[data-video-id="${video.id}"] .video-container`
    );
    expect(cardContainer).toBeTruthy();
    expect(cardContainer.querySelectorAll("video").length).toBe(1);

    // Force an unload via capacity drop
    canLoad = false;
    rerender(
      <VideoCard
        {...baseProps}
        video={video}
        isVisible
        canLoadMoreVideos={() => canLoad}
        scheduleInit={(fn) => fn()}
      />
    );
    await act(async () => {});
    expect(cardContainer.querySelectorAll("video").length).toBe(0);

    // Allow loads again (triggers a new createElement)
    canLoad = true;
    rerender(
      <VideoCard
        {...baseProps}
        video={video}
        isVisible
        canLoadMoreVideos={() => canLoad}
        scheduleInit={(fn) => fn()}
      />
    );

    await act(async () => {});

    const secondEl = createdVideos[1];
    expect(secondEl).toBeTruthy();

    // Simulate a stale stray <video> left behind by the previous load
    const stale = NATIVE_CREATE_ELEMENT("video");
    stale.pause = vi.fn();
    stale.remove = vi.fn(function () {
      if (this.parentNode) this.parentNode.removeChild(this);
    });
    cardContainer.appendChild(stale);
    expect(cardContainer.querySelectorAll("video").length).toBe(1);

    await act(async () => {
      secondEl.dispatchEvent?.(new Event("loadeddata"));
    });

    const attachedVideos = cardContainer.querySelectorAll("video");
    expect(attachedVideos).toHaveLength(1);
    expect(attachedVideos[0]).toBe(secondEl);
  });

  it("clears visibility state on unmount to avoid stale parents", async () => {
    const video = {
      id: "visible-cleanup",
      name: "visible-cleanup",
      isElectronFile: true,
      fullPath: "C:/videos/cleanup.mp4",
    };

    const onVisibilityChange = vi.fn();
    const observeIntersection = vi.fn((el, maybeId, maybeCb) => {
      const cb = typeof maybeId === "function" ? maybeId : maybeCb;
      if (cb) cb(true, null, { visible: true, near: true });
    });
    const unobserveIntersection = vi.fn();

    const { unmount } = render(
      <VideoCard
        {...baseProps}
        video={video}
        onVisibilityChange={onVisibilityChange}
        observeIntersection={observeIntersection}
        unobserveIntersection={unobserveIntersection}
        scheduleInit={(fn) => fn()}
      />
    );

    await act(async () => {});

    expect(onVisibilityChange).toHaveBeenCalledWith(video.id, true);

    onVisibilityChange.mockClear();

    unmount();

    expect(onVisibilityChange).toHaveBeenCalledTimes(1);
    expect(onVisibilityChange).toHaveBeenCalledWith(video.id, false);
  });

  it("tears down aggressively when evicted", async () => {
    const video = {
      id: "victim",
      name: "victim",
      isElectronFile: true,
      fullPath: "C:/videos/victim.mp4",
    };

    const { rerender } = render(
      <VideoCard
        {...baseProps}
        video={video}
        isVisible
        isLoaded={false}
        isLoading={false}
        scheduleInit={(fn) => fn()}
        evictionVictims={[]}
      />
    );

    await act(async () => {});
    await act(async () => {
      lastVideoEl?.dispatchEvent?.(new Event("loadeddata"));
    });

    expect(hardTeardownSpy).not.toHaveBeenCalled();

    rerender(
      <VideoCard
        {...baseProps}
        video={video}
        isVisible
        isLoaded
        isLoading={false}
        scheduleInit={(fn) => fn()}
        evictionVictims={[]}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(hardTeardownSpy).not.toHaveBeenCalled();

    rerender(
      <VideoCard
        {...baseProps}
        video={video}
        isVisible
        isLoaded
        isLoading={false}
        scheduleInit={(fn) => fn()}
        evictionVictims={[video.id]}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(hardTeardownSpy).toHaveBeenCalled();
  });

  it("invokes onStopLoading exactly once when unmounted with a pending load", async () => {
    const video = {
      id: "pending-unmount",
      name: "pending-unmount",
      isElectronFile: true,
      fullPath: "C:/videos/pending-unmount.mp4",
    };

    const onStopLoading = vi.fn();

    const { unmount } = render(
      <VideoCard
        {...baseProps}
        video={video}
        isVisible
        isLoaded={false}
        isLoading={false}
        onStopLoading={onStopLoading}
        scheduleInit={(fn) => fn()}
      />
    );

    await act(async () => {});

    expect(lastVideoEl).toBeTruthy();
    expect(onStopLoading).not.toHaveBeenCalled();

    await act(async () => {
      unmount();
    });

    expect(onStopLoading).toHaveBeenCalledTimes(1);
  });

  it("releases the loading slot when capacity drops mid-load", async () => {
    const video = {
      id: "pending-capacity",
      name: "pending-capacity",
      isElectronFile: true,
      fullPath: "C:/videos/pending-capacity.mp4",
    };

    const onStopLoading = vi.fn();
    let canLoad = true;

    const { rerender, unmount } = render(
      <VideoCard
        {...baseProps}
        video={video}
        isVisible
        isLoaded={false}
        isLoading={false}
        onStopLoading={onStopLoading}
        canLoadMoreVideos={() => canLoad}
        scheduleInit={(fn) => fn()}
      />
    );

    await act(async () => {});

    expect(lastVideoEl).toBeTruthy();
    expect(onStopLoading).not.toHaveBeenCalled();

    canLoad = false;
    rerender(
      <VideoCard
        {...baseProps}
        video={video}
        isVisible
        isLoaded={false}
        isLoading={false}
        onStopLoading={onStopLoading}
        canLoadMoreVideos={() => canLoad}
        scheduleInit={(fn) => fn()}
      />
    );

    await act(async () => {});
    expect(onStopLoading).toHaveBeenCalledTimes(1);

    await act(async () => {
      unmount();
    });

    expect(onStopLoading).toHaveBeenCalledTimes(1);
  });
});
