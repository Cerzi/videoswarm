import React, { createRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FullScreenModal from "./FullScreenModal";
import { createMediaSlotScheduler } from "../services/mediaSlotScheduler";

describe("FullScreenModal media ownership", () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  let pauseSpy;
  let loadSpy;
  let playSpy;

  beforeEach(() => {
    if (typeof URL.createObjectURL !== "function") {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: vi.fn(),
      });
    }
    if (typeof URL.revokeObjectURL !== "function") {
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: vi.fn(),
      });
    }
    pauseSpy = vi
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(() => {});
    loadSpy = vi
      .spyOn(HTMLMediaElement.prototype, "load")
      .mockImplementation(() => {});
    playSpy = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    document.body.style.overflow = "";
    document.getElementById("fullscreen-test-background")?.remove();
    vi.restoreAllMocks();
    if (originalCreateObjectURL) {
      URL.createObjectURL = originalCreateObjectURL;
    } else {
      delete URL.createObjectURL;
    }
    if (originalRevokeObjectURL) {
      URL.revokeObjectURL = originalRevokeObjectURL;
    } else {
      delete URL.revokeObjectURL;
    }
  });

  it("uses its opaque native source URL and releases its element on close", () => {
    const video = {
      id: "local",
      instanceId: 81,
      name: "local.mp4",
      fullPath: "C:\\clips\\a b#c.mp4",
      sourceUrl: "videoswarm-media://instance/81?v=4",
      isElectronFile: true,
    };
    const rendered = render(
      <FullScreenModal
        video={video}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        showFilenames
      />
    );
    const element = document.body.querySelector("video");
    expect(element.src).toBe("videoswarm-media://instance/81?v=4");
    expect(element.crossOrigin).toBe("anonymous");
    expect(element.src).not.toContain(video.fullPath);

    rendered.unmount();
    expect(pauseSpy).toHaveBeenCalled();
    expect(loadSpy).toHaveBeenCalled();
    expect(element.getAttribute("src")).toBeNull();
  });

  it("owns the only fullscreen keyboard handler", () => {
    const onNavigate = vi.fn();
    render(
      <FullScreenModal
        video={{ id: "one", name: "one.mp4", fullPath: "/one.mp4" }}
        onClose={vi.fn()}
        onNavigate={onNavigate}
        showFilenames={false}
      />
    );

    act(() => {
      fireEvent.keyDown(document, { key: "ArrowRight" });
    });
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith("next");
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("revokes only the blob URL it creates", () => {
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:fullscreen-owned");
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const rendered = render(
      <FullScreenModal
        video={{ id: "blob", name: "blob.mp4", file: new Blob(["video"]) }}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        showFilenames={false}
      />
    );

    expect(createObjectURL).toHaveBeenCalledOnce();
    rendered.unmount();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fullscreen-owned");
  });

  it("releases its scheduler lane and owned blob immediately on media error", () => {
    const scheduler = createMediaSlotScheduler({ maxExternalDecoders: 1 });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fullscreen-error");
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const rendered = render(
      <FullScreenModal
        video={{ id: "broken", name: "broken.mp4", file: new Blob(["video"]) }}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        showFilenames={false}
        mediaScheduler={scheduler}
      />
    );
    const element = document.body.querySelector("video");
    expect(scheduler.getSnapshot().externalDecoders).toBe(1);

    act(() => element.dispatchEvent(new Event("error")));

    expect(scheduler.getSnapshot().externalDecoders).toBe(0);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fullscreen-error");
    expect(element.getAttribute("src")).toBeNull();
  });

  it("never revokes a caller-owned blob URL", () => {
    const scheduler = createMediaSlotScheduler({ maxExternalDecoders: 1 });
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const rendered = render(
      <FullScreenModal
        video={{ id: "external", name: "external.mp4", blobUrl: "blob:caller" }}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        showFilenames={false}
        mediaScheduler={scheduler}
      />
    );

    expect(scheduler.getSnapshot().externalDecoders).toBe(1);
    rendered.unmount();
    expect(scheduler.getSnapshot().externalDecoders).toBe(0);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("releases the previous owned blob before navigation acquires the next", () => {
    const scheduler = createMediaSlotScheduler({ maxExternalDecoders: 1 });
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:first-fullscreen")
      .mockReturnValueOnce("blob:second-fullscreen");
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const common = {
      onClose: vi.fn(),
      onNavigate: vi.fn(),
      showFilenames: false,
      mediaScheduler: scheduler,
    };
    const rendered = render(
      <FullScreenModal
        {...common}
        video={{ id: "first", name: "first.mp4", file: new Blob(["first"]) }}
      />
    );

    rendered.rerender(
      <FullScreenModal
        {...common}
        video={{ id: "second", name: "second.mp4", file: new Blob(["second"]) }}
      />
    );

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:first-fullscreen");
    expect(scheduler.getSnapshot().externalDecoders).toBe(1);
    rendered.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:second-fullscreen");
    expect(scheduler.getSnapshot().externalDecoders).toBe(0);
  });

  it("releases fullscreen media while work is suspended and will not restart by keyboard", () => {
    const scheduler = createMediaSlotScheduler({ maxExternalDecoders: 1 });
    const common = {
      video: {
        id: "suspend",
        name: "suspend.mp4",
        fullPath: "/suspend.mp4",
        sourceUrl: "videoswarm-media://instance/82?v=4",
        isElectronFile: true,
      },
      onClose: vi.fn(),
      onNavigate: vi.fn(),
      showFilenames: false,
      mediaScheduler: scheduler,
    };
    const rendered = render(<FullScreenModal {...common} />);
    expect(scheduler.getSnapshot().externalDecoders).toBe(1);

    rendered.rerender(<FullScreenModal {...common} workSuspended />);
    expect(scheduler.getSnapshot().externalDecoders).toBe(0);
    fireEvent.keyDown(document, { key: " " });
    expect(playSpy).not.toHaveBeenCalled();

    rendered.rerender(<FullScreenModal {...common} workSuspended={false} />);
    expect(scheduler.getSnapshot().externalDecoders).toBe(1);
  });

  it("synchronously mutes, detaches, and releases before close completes", () => {
    const scheduler = createMediaSlotScheduler({ maxExternalDecoders: 1 });
    const onClose = vi.fn();
    render(
      <FullScreenModal
        video={{
          id: "close-now",
          name: "close-now.mp4",
          fullPath: "/close-now.mp4",
          sourceUrl: "videoswarm-media://instance/90?v=1",
          isElectronFile: true,
        }}
        onClose={onClose}
        onNavigate={vi.fn()}
        mediaScheduler={scheduler}
      />
    );
    const element = document.body.querySelector("video");
    element.muted = false;

    fireEvent.click(
      screen.getByRole("button", { name: "Close fullscreen review" })
    );

    expect(onClose).toHaveBeenCalledWith("button");
    expect(element.muted).toBe(true);
    expect(element.getAttribute("src")).toBeNull();
    expect(element.srcObject).toBeNull();
    expect(pauseSpy).toHaveBeenCalled();
    expect(loadSpy).toHaveBeenCalled();
    expect(scheduler.getSnapshot().externalDecoders).toBe(0);
  });

  it("uses the same synchronous release path for Escape and backdrop dismissal", () => {
    const scheduler = createMediaSlotScheduler({ maxExternalDecoders: 1 });
    const onClose = vi.fn();
    const rendered = render(
      <FullScreenModal
        video={{ id: "escape", name: "escape.mp4", blobUrl: "blob:escape" }}
        onClose={onClose}
        onNavigate={vi.fn()}
        mediaScheduler={scheduler}
      />
    );
    const element = document.body.querySelector("video");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith("escape");
    expect(element.getAttribute("src")).toBeNull();
    expect(scheduler.getSnapshot().externalDecoders).toBe(0);

    rendered.unmount();
    render(
      <FullScreenModal
        video={{ id: "backdrop", name: "backdrop.mp4", blobUrl: "blob:backdrop" }}
        onClose={onClose}
        onNavigate={vi.fn()}
        mediaScheduler={scheduler}
      />
    );
    expect(scheduler.getSnapshot().externalDecoders).toBe(1);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenLastCalledWith("backdrop");
    expect(scheduler.getSnapshot().externalDecoders).toBe(0);
  });

  it("exposes idempotent releaseNow and preserves session audio only for navigation", () => {
    const scheduler = createMediaSlotScheduler({ maxExternalDecoders: 1 });
    const playerRef = createRef();
    const first = {
      id: "first",
      name: "first.mp4",
      sourceUrl: "videoswarm-media://instance/91?v=1",
      isElectronFile: true,
    };
    const rendered = render(
      <FullScreenModal
        ref={playerRef}
        video={first}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        mediaScheduler={scheduler}
      />
    );
    const element = document.body.querySelector("video");
    fireEvent.click(screen.getByRole("button", { name: "Turn audio on" }));
    expect(element.muted).toBe(false);

    let firstRelease;
    let secondRelease;
    act(() => {
      firstRelease = playerRef.current.releaseNow({ resetAudio: false });
      secondRelease = playerRef.current.releaseNow({ resetAudio: false });
    });
    expect(firstRelease).toBe(true);
    expect(secondRelease).toBe(false);
    expect(scheduler.getSnapshot().externalDecoders).toBe(0);

    rendered.rerender(
      <FullScreenModal
        ref={playerRef}
        video={{
          ...first,
          id: "second",
          name: "second.mp4",
          sourceUrl: "videoswarm-media://instance/92?v=1",
        }}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        mediaScheduler={scheduler}
      />
    );
    expect(document.body.querySelector("video").muted).toBe(false);

    act(() => playerRef.current.releaseNow());
    expect(document.body.querySelector("video").muted).toBe(true);
  });

  it("does not restart media for metadata-only record replacement", () => {
    const scheduler = createMediaSlotScheduler({ maxExternalDecoders: 1 });
    const common = {
      id: "stable",
      instanceId: 93,
      name: "stable.mp4",
      fullPath: "/stable.mp4",
      sourceUrl: "videoswarm-media://instance/93?v=1",
      isElectronFile: true,
    };
    const rendered = render(
      <FullScreenModal
        video={{ ...common, reviewState: "unreviewed", rating: null }}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        mediaScheduler={scheduler}
      />
    );
    const loadCount = loadSpy.mock.calls.length;
    const pauseCount = pauseSpy.mock.calls.length;

    rendered.rerender(
      <FullScreenModal
        video={{ ...common, reviewState: "pick", rating: 5, tags: ["best"] }}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        mediaScheduler={scheduler}
      />
    );

    expect(loadSpy).toHaveBeenCalledTimes(loadCount);
    expect(pauseSpy).toHaveBeenCalledTimes(pauseCount);
    expect(scheduler.getSnapshot().externalDecoders).toBe(1);
  });

  it("keeps boundary and rejected navigation attached for the App coordinator", () => {
    const scheduler = createMediaSlotScheduler({ maxExternalDecoders: 1 });
    const onNavigate = vi.fn(() => false);
    const { rerender } = render(
      <FullScreenModal
        video={{ id: "one", name: "one.mp4", blobUrl: "blob:one" }}
        onClose={vi.fn()}
        onNavigate={onNavigate}
        canNavigatePrevious={false}
        canNavigateNext={false}
        mediaScheduler={scheduler}
      />
    );
    const element = document.body.querySelector("video");
    const source = element.getAttribute("src");

    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(element.getAttribute("src")).toBe(source);
    expect(scheduler.getSnapshot().externalDecoders).toBe(1);
    expect(screen.getByText("End of current view")).toBeTruthy();

    rerender(
      <FullScreenModal
        video={{ id: "one", name: "one.mp4", blobUrl: "blob:one" }}
        onClose={vi.fn()}
        onNavigate={onNavigate}
        canNavigatePrevious={false}
        canNavigateNext
        mediaScheduler={scheduler}
      />
    );
    fireEvent.keyDown(document, { key: "e" });
    expect(onNavigate).toHaveBeenCalledWith("next");
    expect(element.getAttribute("src")).toBe(source);
    expect(scheduler.getSnapshot().externalDecoders).toBe(1);
  });

  it("reports rejected Space playback without an unhandled rejection", async () => {
    render(
      <FullScreenModal
        video={{ id: "blocked", name: "blocked.mp4", blobUrl: "blob:blocked" }}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
      />
    );
    playSpy.mockRejectedValueOnce(new Error("decoder rejected"));

    fireEvent.keyDown(document, { key: " " });

    await waitFor(() =>
      expect(screen.getByText(/Playback did not start/)).toBeTruthy()
    );
  });

  it("keeps transient Escape layered and ignores editable/repeated shortcuts", () => {
    const onClose = vi.fn();
    const onDismissTransient = vi.fn();
    const onNavigate = vi.fn();
    render(
      <FullScreenModal
        video={{ id: "layered", name: "layered.mp4", blobUrl: "blob:layered" }}
        onClose={onClose}
        onNavigate={onNavigate}
        transientOpen
        onDismissTransient={onDismissTransient}
        detailsOpen
        detailsDock={<input aria-label="Tag editor" />}
      />
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismissTransient).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();

    const input = screen.getByRole("textbox", { name: "Tag editor" });
    fireEvent.keyDown(input, { key: "ArrowRight" });
    fireEvent.keyDown(document, { key: "ArrowRight", repeat: true });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("applies modal semantics, inertness, focus containment, and exact cleanup", () => {
    const background = document.createElement("div");
    background.id = "fullscreen-test-background";
    const returnButton = document.createElement("button");
    document.body.append(background, returnButton);
    returnButton.focus();
    const returnFocusRef = { current: returnButton };
    document.body.style.overflow = "scroll";

    const rendered = render(
      <FullScreenModal
        video={{ id: "a11y", name: "a11y.mp4", blobUrl: "blob:a11y" }}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        appRootId="fullscreen-test-background"
        returnFocusRef={returnFocusRef}
        detailsOpen
        detailsDock={<button type="button">Last control</button>}
      />
    );
    const dialog = screen.getByRole("dialog", { name: "Fullscreen review" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(background).toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe("hidden");

    const closeButton = screen.getByRole("button", {
      name: "Close fullscreen review",
    });
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);

    rendered.unmount();
    expect(background).not.toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe("scroll");
    expect(document.activeElement).toBe(returnButton);
    background.remove();
    returnButton.remove();
    document.body.style.overflow = "";
  });

  it("repeats identity transitions without leaking external decoder leases", () => {
    const scheduler = createMediaSlotScheduler({ maxExternalDecoders: 1 });
    const common = {
      onClose: vi.fn(),
      onNavigate: vi.fn(),
      mediaScheduler: scheduler,
    };
    const rendered = render(
      <FullScreenModal
        {...common}
        video={{ id: "repeat-0", name: "repeat-0.mp4", blobUrl: "blob:0" }}
      />
    );
    for (let index = 1; index <= 8; index += 1) {
      rendered.rerender(
        <FullScreenModal
          {...common}
          video={{
            id: `repeat-${index}`,
            name: `repeat-${index}.mp4`,
            blobUrl: `blob:${index}`,
          }}
        />
      );
      expect(scheduler.getSnapshot().externalDecoders).toBe(1);
    }
    rendered.unmount();
    expect(scheduler.getSnapshot().externalDecoders).toBe(0);
  });
});
