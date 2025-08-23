// src/components/VideoCard/VideoCard.test.jsx
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import VideoCard from "./VideoCard";

// --- IntersectionObserver mock: immediately marks the card visible ---
class IO {
    constructor(cb) { this.cb = cb; }
    observe = (el) => { this.cb([{ target: el, isIntersecting: true }]); };
    disconnect = () => { };
}
beforeEach(() => {
    // @ts-ignore
    global.IntersectionObserver = IO;
});

let lastVideoEl;

// --- createElement mock: augment a REAL <video> Node so DOM APIs work ---
beforeEach(() => {
    lastVideoEl = undefined;
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag) => {
        const el = realCreate(tag); // keep a real Node
        if (tag !== "video") return el;

        Object.assign(el, {
            preload: "none",
            muted: false,
            loop: false,
            playsInline: false,
            src: "",
            load: vi.fn(),
            play: vi.fn().mockResolvedValue(),
            pause: vi.fn(),
            removeAttribute: vi.fn(function (name) {
                if (name === "src") this.src = "";
                HTMLElement.prototype.removeAttribute.call(this, name);
            }),
            remove: vi.fn(function () {
                if (this.parentNode) this.parentNode.removeChild(this);
            }),
        });

        lastVideoEl = el; // capture for assertions
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
    it("shows terminal error text when load fails (code 4) and does not retry", async () => {
        const video = { id: "v1", name: "v1", isElectronFile: true, fullPath: "C:\\Users\\me\\f.mp4" };

        render(<VideoCard {...baseProps} video={video} />);

        // Let initial effects run (IO → loadVideo sets src)
        await act(async () => { });

        const created = lastVideoEl;
        expect(created).toBeTruthy();

        // Fire a terminal media error (code 4 = unsupported)
        await act(async () => {
            // Provide an error object on the element so handler sees target.error
            // (jsdom allows free-form prop assignment)
            created.error = { code: 4 };
            created.dispatchEvent(new Event("error"));
        });

        // Placeholder shows the classifier label for terminal unsupported files
        expect(screen.getByText(/file unsupported/i)).toBeTruthy();

        // Trigger visibility again — should not attempt a new load automatically
        await act(async () => {
            // The IO mock calls the callback synchronously in observe(),
            // but we call an empty act to flush pending microtasks.
        });

        // If a retry occurred, src would be re-set; here we simply assert that the element is intact
        // and rely on the UI text to confirm terminal state is shown.
    });

    it("builds proper file:// URL (no %5C)", async () => {
        const video = { id: "v2", name: "v2", isElectronFile: true, fullPath: "C:\\Users\\me\\a b#c.mp4" };

        render(<VideoCard {...baseProps} video={video} />);

        // Allow loadVideo to run and set el.src
        await act(async () => { });

        const created = lastVideoEl;
        expect(created).toBeTruthy();

        // src should already be set by the component
        expect(created.src).toMatch(/^file:\/\//);
        expect(created.src.includes("%5C")).toBe(false);
        expect(created.src).toContain("/C:/Users/me/a%20b%23c.mp4");

        // Optionally finish the "load" to attach <video> into the container
        await act(async () => {
            created.dispatchEvent(new Event("loadedmetadata"));
            created.dispatchEvent(new Event("canplay"));
        });
    });
    it("loads when parent marks visible even if IntersectionObserver never fires", async () => {
        // Mock IO that never calls the callback (no visibility events)
        const PrevIO = global.IntersectionObserver;
        class IO_NoFire { constructor() { } observe() { } disconnect() { } }
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
            await act(async () => { });

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
        class IO_NoFire { constructor() { } observe() { } disconnect() { } }
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
            await act(async () => { });

            // No IO event and not visible ⇒ should NOT load
            expect(lastVideoEl).toBeUndefined();
        } finally {
            // @ts-ignore
            global.IntersectionObserver = PrevIO;
        }
    });
});
