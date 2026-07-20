import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toFileURL } from "../components/VideoCard/videoDom";
import {
  releaseVideoHandlesFor,
  releaseVideoHandlesForAsync,
} from "./releaseVideoHandles";

const appendVideo = (path) => {
  const element = document.createElement("video");
  element.setAttribute("src", toFileURL(path));
  document.body.appendChild(element);
  return element;
};

describe("releaseVideoHandles", () => {
  let pauseSpy;
  let loadSpy;

  beforeEach(() => {
    pauseSpy = vi
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(() => {});
    loadSpy = vi
      .spyOn(HTMLMediaElement.prototype, "load")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("matches encoded POSIX reserved characters without folding case", () => {
    const targetPath = "/tmp/Run?seed=4#final.mp4";
    const target = appendVideo(targetPath);
    const differentCase = appendVideo("/tmp/run?seed=4#final.mp4");

    releaseVideoHandlesFor([targetPath]);

    expect(target.getAttribute("src")).toBeNull();
    expect(differentCase.getAttribute("src")).not.toBeNull();
    expect(pauseSpy).toHaveBeenCalledOnce();
    expect(loadSpy).toHaveBeenCalledOnce();
  });

  it.each([
    ["C:\\Clips\\A B.mp4", "c:\\clips\\a b.mp4"],
    ["\\\\SERVER\\Share\\A B.mp4", "\\\\server\\share\\a b.mp4"],
  ])("matches case-insensitive Windows paths for %s", (sourcePath, targetPath) => {
    const element = appendVideo(sourcePath);

    releaseVideoHandlesFor([targetPath]);

    expect(element.getAttribute("src")).toBeNull();
  });

  it("matches an opaque Electron source through its owned native path", () => {
    const element = document.createElement("video");
    element.setAttribute(
      "src",
      "videoswarm-media://instance/42?v=100-200&g=3"
    );
    element.setAttribute("data-file-path", "/library/run/clip.mp4");
    document.body.appendChild(element);

    releaseVideoHandlesFor(["/library/run/clip.mp4"]);

    expect(element.getAttribute("src")).toBeNull();
    expect(element.getAttribute("data-file-path")).toBeNull();
    expect(pauseSpy).toHaveBeenCalledOnce();
    expect(loadSpy).toHaveBeenCalledOnce();
  });

  it("finishes async release when animation frames are suspended", async () => {
    vi.useFakeTimers();
    const element = appendVideo("/tmp/hidden-window.mp4");
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = vi.fn(() => 42);
    globalThis.cancelAnimationFrame = vi.fn();

    const release = releaseVideoHandlesForAsync(
      ["/tmp/hidden-window.mp4"],
      { extraPassDelayMs: 10 }
    );
    await vi.advanceTimersByTimeAsync(150);
    await release;

    expect(element.getAttribute("src")).toBeNull();
    expect(globalThis.cancelAnimationFrame).toHaveBeenCalled();
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCaf;
  });
});
