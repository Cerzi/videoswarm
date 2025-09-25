// src/components/VideoCard/VideoCard.test.jsx
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent, createEvent } from "@testing-library/react";
import VideoCard from "../VideoCard";
import { toFileURL } from "../videoDom";

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
  vi.restoreAllMocks();
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
};

describe("VideoCard", () => {
  it("shows terminal error for non-local code 4 and does not retry", async () => {
    // Override the base createElement mock JUST for this test to make load() throw during init.
    document.createElement.mockImplementation((tag, opts) => {
      const el = NATIVE_CREATE_ELEMENT(tag, opts);
      if (tag === "video") {
        // Ensure media stubs exist
        if (!el.pause) el.pause = vi.fn();
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

  describe("native drag integration", () => {
    let originalElectronApi;
    let startDragMock;

    beforeEach(() => {
      originalElectronApi = window.electronAPI;
      startDragMock = vi.fn().mockResolvedValue({ success: true });
      window.electronAPI = {
        startDrag: startDragMock,
      };
    });

    afterEach(() => {
      window.electronAPI = originalElectronApi;
    });

    it("initiates a native drag with web-safe payload by default", () => {
      const video = {
        id: "dragme",
        name: "clip.mp4",
        fullPath: "/tmp/clip.mp4",
        isElectronFile: true,
      };

      const { container } = render(
        <VideoCard
          {...baseProps}
          video={video}
          isVisible
          isLoaded={false}
          isLoading={false}
          scheduleInit={() => {}}
        />
      );

      const card = container.querySelector('[data-video-id="dragme"]');
      expect(card).toBeTruthy();
      expect(card?.getAttribute("draggable")).toBe("true");

      const dataTransfer = {
        effectAllowed: "",
        dropEffect: "",
        setData: vi.fn(),
      };
      act(() => {
        fireEvent.dragStart(card, {
          dataTransfer,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        });
      });
      expect(dataTransfer.effectAllowed).toBe("copy");
      expect(dataTransfer.dropEffect).toBe("copy");
      expect(dataTransfer.setData).not.toHaveBeenCalled();
      expect(startDragMock).toHaveBeenCalledWith(video.fullPath, {
        includeLinkMetadata: false,
      });
    });

    it("adds native-friendly flavors when Alt is held", () => {
      const video = {
        id: "dragme-alt",
        name: "clip.mp4",
        fullPath: "/tmp/clip.mp4",
        isElectronFile: true,
      };

      const { container } = render(
        <VideoCard
          {...baseProps}
          video={video}
          isVisible
          isLoaded={false}
          isLoading={false}
          scheduleInit={() => {}}
        />
      );

      const card = container.querySelector('[data-video-id="dragme-alt"]');
      const dataTransfer = {
        effectAllowed: "",
        dropEffect: "",
        setData: vi.fn(),
      };

      const dragEvent = createEvent.dragStart(card, { dataTransfer });
      Object.defineProperty(dragEvent, "altKey", { get: () => true });
      Object.defineProperty(dragEvent, "nativeEvent", {
        value: {
          altKey: true,
          getModifierState: (key) => key === "Alt",
        },
      });
      Object.defineProperty(dragEvent, "getModifierState", {
        value: (key) => key === "Alt",
      });
      Object.defineProperty(dragEvent, "preventDefault", {
        value: vi.fn(),
      });
      Object.defineProperty(dragEvent, "stopPropagation", {
        value: vi.fn(),
      });

      act(() => {
        fireEvent(card, dragEvent);
      });

      const fileUrl = toFileURL(video.fullPath);
      expect(dataTransfer.setData).toHaveBeenCalledWith(
        "text/uri-list",
        `${fileUrl}\n`
      );
      expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", video.fullPath);
      expect(dataTransfer.setData).toHaveBeenCalledWith(
        "DownloadURL",
        `video/mp4:clip.mp4:${fileUrl}`
      );
      expect(dataTransfer.setData).toHaveBeenCalledWith(
        "text/x-moz-url",
        `${fileUrl}\nclip.mp4`
      );
      expect(dataTransfer.setData).toHaveBeenCalledWith(
        "text/x-moz-url-data",
        fileUrl
      );
      expect(dataTransfer.setData).toHaveBeenCalledWith(
        "text/x-moz-url-desc",
        "clip.mp4"
      );
      expect(dataTransfer.setData).toHaveBeenCalledWith(
        "text/html",
        `<a href="${fileUrl}">clip.mp4</a>`
      );
      expect(dataTransfer.setData).toHaveBeenCalledWith(
        "x-special/gnome-copied-files",
        `copy\n${fileUrl}\n`
      );
      expect(dataTransfer.setData).toHaveBeenCalledWith(
        "application/octet-stream",
        video.fullPath
      );
      expect(startDragMock).toHaveBeenCalledWith(video.fullPath, {
        includeLinkMetadata: true,
      });
    });

    it("sanitizes filenames when populating native payloads", () => {
      const video = {
        id: "dragme2",
        name: "clip:final & <v>.mp4",
        fullPath: "/tmp/clip:final & <v>.mp4",
        isElectronFile: true,
      };

      const { container } = render(
        <VideoCard
          {...baseProps}
          video={video}
          isVisible
          isLoaded={false}
          isLoading={false}
          scheduleInit={() => {}}
        />
      );

      const card = container.querySelector('[data-video-id="dragme2"]');
      const dataTransfer = {
        effectAllowed: "",
        dropEffect: "",
        setData: vi.fn(),
      };

      const dragEvent = createEvent.dragStart(card, { dataTransfer });
      Object.defineProperty(dragEvent, "altKey", { get: () => true });
      Object.defineProperty(dragEvent, "nativeEvent", {
        value: {
          altKey: true,
          getModifierState: (key) => key === "Alt",
        },
      });
      Object.defineProperty(dragEvent, "getModifierState", {
        value: (key) => key === "Alt",
      });
      Object.defineProperty(dragEvent, "preventDefault", {
        value: vi.fn(),
      });
      Object.defineProperty(dragEvent, "stopPropagation", {
        value: vi.fn(),
      });

      act(() => {
        fireEvent(card, dragEvent);
      });

      const fileUrl = toFileURL(video.fullPath);
      const calls = new Map(dataTransfer.setData.mock.calls.map(([type, value]) => [type, value]));

      expect(calls.get("DownloadURL")).toBe(
        `video/mp4:clip_final & <v>.mp4:${fileUrl}`
      );
      expect(calls.get("text/html")).toBe(
        `<a href="${fileUrl}">clip:final &amp; &lt;v&gt;.mp4</a>`
      );
      expect(calls.get("text/x-moz-url")).toBe(
        `${fileUrl}\nclip:final & <v>.mp4`
      );
      expect(calls.get("text/uri-list")).toBe(`${fileUrl}\n`);
      expect(calls.get("x-special/gnome-copied-files")).toBe(`copy\n${fileUrl}\n`);
      expect(calls.get("application/octet-stream")).toBe(video.fullPath);
    });

    it("ignores native drag when the file is not local", () => {
      const video = {
        id: "remotefile",
        name: "remote.mp4",
        fullPath: "/mnt/share/remote.mp4",
        isElectronFile: false,
      };

      const { container } = render(
        <VideoCard
          {...baseProps}
          video={video}
          isVisible
          isLoaded={false}
          isLoading={false}
          scheduleInit={() => {}}
        />
      );

      const card = container.querySelector('[data-video-id="remotefile"]');
      expect(card).toBeTruthy();
      expect(card?.getAttribute("draggable")).toBe("false");

      const dataTransfer = {
        effectAllowed: "",
        dropEffect: "",
        setData: vi.fn(),
      };
      act(() => {
        fireEvent.dragStart(card, {
          dataTransfer,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        });
      });
      expect(dataTransfer.setData).not.toHaveBeenCalled();
      expect(startDragMock).not.toHaveBeenCalled();
    });
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
});
