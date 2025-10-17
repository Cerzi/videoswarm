// src/components/VideoCard/VideoCard.test.jsx
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
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

let prevRAF;
let prevCAF;

beforeEach(() => {
  // @ts-ignore
  global.IntersectionObserver = IO;
  prevRAF = global.requestAnimationFrame;
  prevCAF = global.cancelAnimationFrame;
  global.requestAnimationFrame = (cb) => {
    cb(0);
    return 0;
  };
  global.cancelAnimationFrame = () => {};
});

let lastVideoEl;

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
});

afterEach(() => {
  global.requestAnimationFrame = prevRAF;
  global.cancelAnimationFrame = prevCAF;
  vi.restoreAllMocks();
});

// --- Common props scaffold ---
const makeScrollRootRef = () => {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => ({
    top: 0,
    bottom: 1200,
    left: 0,
    right: 1920,
    width: 1920,
    height: 1200,
  });
  return { current: el };
};

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
  scrollRootRef: makeScrollRootRef(),
  layoutEpoch: 0,
};

beforeEach(() => {
  baseProps.scrollRootRef = makeScrollRootRef();
  baseProps.layoutEpoch = 0;
});

describe("VideoCard", () => {
  it("shows terminal error for non-local code 4 and does not retry", async () => {
    // Override the base createElement mock JUST for this test to make load() throw during init.
    document.createElement.mockImplementation((tag, opts) => {
      const el = NATIVE_CREATE_ELEMENT(tag, opts);
      if (tag === "video") {
        // Ensure media stubs exist
        el.pause = vi.fn();
        if (!el.play) el.play = vi.fn().mockResolvedValue(undefined);
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
        scrollRootRef={makeScrollRootRef()}
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

  it("does not emit redundant visibility change notifications", async () => {
    let handler = null;
    const observeIntersection = vi.fn((el, _id, cb) => {
      handler = cb;
    });
    const unobserveIntersection = vi.fn();
    const onVisibilityChange = vi.fn();

    render(
      <VideoCard
        {...baseProps}
        video={{ id: "vid-1", name: "Video" }}
        isVisible={false}
        canLoadMoreVideos={() => false}
        observeIntersection={observeIntersection}
        unobserveIntersection={unobserveIntersection}
        onVisibilityChange={onVisibilityChange}
      />
    );

    expect(observeIntersection).toHaveBeenCalled();
    expect(typeof handler).toBe("function");

    await act(async () => {
      handler(true, { boundingClientRect: { top: 0, bottom: 100 } });
    });
    expect(onVisibilityChange).toHaveBeenCalledTimes(1);
    expect(onVisibilityChange).toHaveBeenLastCalledWith("vid-1", true);

    onVisibilityChange.mockClear();

    await act(async () => {
      handler(true, { boundingClientRect: { top: 0, bottom: 100 } });
    });
    expect(onVisibilityChange).not.toHaveBeenCalled();

    await act(async () => {
      handler(false, { boundingClientRect: { top: 0, bottom: 100 } });
    });
    expect(onVisibilityChange).toHaveBeenCalledTimes(1);
    expect(onVisibilityChange).toHaveBeenLastCalledWith("vid-1", false);
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

  it("removes stray video elements when load completes", async () => {
    const video = {
      id: "v3",
      name: "v3",
      isElectronFile: false,
      fullPath: "/remote/v3.mp4",
    };

    render(<VideoCard {...baseProps} video={video} />);

    await act(async () => {});

    expect(lastVideoEl).toBeTruthy();

    const cardVideo = lastVideoEl;

    const container = document.querySelector(".video-container");
    expect(container).toBeTruthy();

    const stray = document.createElement("video");
    stray.className = "video-element stray";
    container.appendChild(stray);

    await act(async () => {
      cardVideo.dispatchEvent?.(new Event("loadedmetadata"));
      cardVideo.dispatchEvent?.(new Event("loadeddata"));
    });

    const videos = container.querySelectorAll("video");
    expect(videos).toHaveLength(1);
    expect(videos[0]).toBe(cardVideo);
  });

  it("cleans up stray videos on layout epoch changes", async () => {
    const video = {
      id: "v4",
      name: "v4",
      isElectronFile: false,
      fullPath: "/remote/v4.mp4",
    };

    const { rerender } = render(
      <VideoCard {...baseProps} video={video} layoutEpoch={0} />
    );

    await act(async () => {
      lastVideoEl.dispatchEvent?.(new Event("loadedmetadata"));
      lastVideoEl.dispatchEvent?.(new Event("loadeddata"));
    });

    expect(lastVideoEl).toBeTruthy();

    const cardVideo = lastVideoEl;

    const container = document.querySelector(".video-container");
    expect(container).toBeTruthy();

    const stray = document.createElement("video");
    stray.className = "video-element stray";
    container.appendChild(stray);
    expect(container.querySelectorAll("video")).toHaveLength(2);

    await act(async () => {
      rerender(<VideoCard {...baseProps} video={video} layoutEpoch={1} />);
    });

    const videos = container.querySelectorAll("video");
    expect(videos).toHaveLength(1);
    expect(videos[0]).toBe(cardVideo);
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

  it("treats assumeVisible override as a hard admission when DOM shows in-view", async () => {
    const gate = vi.fn((opts) => Boolean(opts?.assumeVisible));

    const { container } = render(
      <VideoCard
        {...baseProps}
        video={{ id: "v-gate", name: "v-gate" }}
        isVisible
        canLoadMoreVideos={gate}
      />
    );

    const card = container.querySelector(".video-item");
    expect(card).toBeTruthy();
    if (card) {
      card.getBoundingClientRect = () => ({
        top: 100,
        bottom: 260,
        left: 0,
        right: 320,
        width: 320,
        height: 160,
      });
    }

    await act(async () => {});

    expect(gate).toHaveBeenCalledWith({ assumeVisible: true });
    const createdVideos = document.createElement.mock.calls.filter(
      ([tag]) => tag === "video"
    ).length;
    expect(createdVideos).toBeGreaterThan(0);
  });

  it("re-evaluates geometry when layout epoch changes", async () => {
    const gate = vi.fn(() => true);
    const video = {
      id: "layout-check",
      name: "layout-check",
      isElectronFile: true,
      fullPath: "C:/videos/layout-check.mp4",
    };

    const { container, rerender } = render(
      <VideoCard
        {...baseProps}
        video={video}
        isVisible={false}
        layoutEpoch={0}
        canLoadMoreVideos={gate}
      />
    );

    const card = container.querySelector(".video-item");
    expect(card).toBeTruthy();
    if (card) {
      card.getBoundingClientRect = () => ({
        top: 120,
        bottom: 320,
        left: 0,
        right: 320,
        width: 320,
        height: 200,
      });
    }

    await act(async () => {});
    expect(lastVideoEl).toBeUndefined();

    rerender(
      <VideoCard
        {...baseProps}
        video={video}
        isVisible={false}
        layoutEpoch={1}
        canLoadMoreVideos={gate}
      />
    );

    await act(async () => {});

    expect(gate).toHaveBeenCalledWith({ assumeVisible: true });
    expect(lastVideoEl).toBeTruthy();
  });

  it("rehydrates when flagged as loaded but missing a video element", async () => {
    const canLoad = vi.fn().mockReturnValue(true);
    const onStart = vi.fn();

    render(
      <VideoCard
        {...baseProps}
        video={{
          id: "rehydrate",
          name: "rehydrate",
          fullPath: "/rehydrate.mp4",
          isElectronFile: false,
        }}
        isLoaded={true}
        isLoading={false}
        canLoadMoreVideos={canLoad}
        onStartLoading={onStart}
      />
    );

    await act(async () => {});

    expect(canLoad).toHaveBeenCalled();
    expect(onStart).toHaveBeenCalled();
    const createdVideos = document.createElement.mock.calls.filter(
      ([tag]) => tag === "video"
    ).length;
    expect(createdVideos).toBeGreaterThan(0);
  });

  it("re-parents an existing video back into the container after relayout", async () => {
    const canLoad = vi.fn().mockReturnValue(true);
    const onVideoLoad = vi.fn();

    let props = {
      ...baseProps,
      video: {
        id: "persist",
        name: "persist",
        fullPath: "/persist.mp4",
        isElectronFile: false,
      },
      canLoadMoreVideos: canLoad,
      onVideoLoad,
      layoutEpoch: 0,
      isLoaded: false,
      isLoading: false,
    };

    const { rerender } = render(<VideoCard {...props} />);

    await act(async () => {});

    const created = lastVideoEl;
    expect(created).toBeTruthy();

    await act(async () => {
      created.dispatchEvent?.(new Event("loadedmetadata"));
      created.dispatchEvent?.(new Event("loadeddata"));
    });

    expect(onVideoLoad).toHaveBeenCalledWith("persist", expect.any(Number));

    props = { ...props, isLoaded: true };
    rerender(<VideoCard {...props} />);

    let containerEl = document.querySelector(".video-container");
    expect(containerEl).toBeTruthy();

    if (containerEl && created.parentNode === containerEl) {
      containerEl.removeChild(created);
    }
    expect(containerEl?.contains(created)).toBe(false);

    props = { ...props, layoutEpoch: 1 };
    rerender(<VideoCard {...props} />);

    await act(async () => {});

    containerEl = document.querySelector(".video-container");
    expect(containerEl?.contains(created)).toBe(true);
  });
});
