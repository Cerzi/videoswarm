import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
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
    const element = rendered.container.querySelector("video");
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
    const element = rendered.container.querySelector("video");
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
});
