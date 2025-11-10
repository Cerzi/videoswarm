import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { useDroppedFolderOpener } from "./useDroppedFolderOpener";

afterEach(() => {
  cleanup();
  delete window.electronAPI;
});

function HookHarness({ notify }) {
  useDroppedFolderOpener({ notify });
  return null;
}

describe("useDroppedFolderOpener", () => {
  it("invokes openDroppedFolder with extracted paths", async () => {
    const openDroppedFolder = vi.fn().mockResolvedValue({ success: true });
    window.electronAPI = {
      openDroppedFolder,
      platform: "darwin",
    };
    const notify = vi.fn();

    render(<HookHarness notify={notify} />);

    const dropEvent = new Event("drop");
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: {
        files: [{ path: "file:///Users/demo/Videos" }],
        types: ["Files"],
        getData: vi.fn(() => ""),
        items: [],
      },
    });
    dropEvent.preventDefault = vi.fn();

    window.dispatchEvent(dropEvent);

    await waitFor(() => {
      expect(openDroppedFolder).toHaveBeenCalledWith({
        paths: ["/Users/demo/Videos"],
        source: "drop",
      });
    });

    expect(notify).not.toHaveBeenCalled();
  });

  it("notifies when no directories are present", async () => {
    const openDroppedFolder = vi
      .fn()
      .mockResolvedValue({ success: false, reason: "NO_DIRECTORY" });
    window.electronAPI = {
      openDroppedFolder,
      platform: "darwin",
    };
    const notify = vi.fn();

    render(<HookHarness notify={notify} />);

    const dropEvent = new Event("drop");
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: {
        files: [{ path: "/Users/demo/file.mp4" }],
        types: ["Files"],
        getData: vi.fn(() => ""),
        items: [],
      },
    });
    dropEvent.preventDefault = vi.fn();

    window.dispatchEvent(dropEvent);

    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith(
        "Dropped items didn't contain a folder. Drop a folder to open it.",
        "info"
      );
    });
  });

  it("offers a picker fallback when the path is missing but a directory is detected", async () => {
    const openDroppedFolder = vi
      .fn()
      .mockResolvedValue({ success: true });
    const selectFolder = vi.fn().mockResolvedValue({
      success: true,
      folderPath: "/Users/demo/Picked",
    });
    window.electronAPI = {
      openDroppedFolder,
      selectFolder,
      platform: "win32",
    };
    const notify = vi.fn();

    render(<HookHarness notify={notify} />);

    const dropEvent = new Event("drop");
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: {
        files: [],
        items: [
          {
            webkitGetAsEntry: () => ({ isDirectory: true }),
          },
        ],
        types: {
          includes: (value) => value === "Files",
        },
        getData: vi.fn(() => ""),
      },
    });
    dropEvent.preventDefault = vi.fn();

    window.dispatchEvent(dropEvent);

    await waitFor(() => {
      expect(selectFolder).toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(
        "Windows didn't share the folder's location with VideoSwarm, so we couldn't open it automatically. Please use Open Folder and pick it manually.",
        "warning"
      );
      expect(openDroppedFolder).toHaveBeenCalledWith({
        paths: ["/Users/demo/Picked"],
        source: "drop-fallback",
      });
    });
  });

  it("explains missing paths when no directory is detected", async () => {
    const openDroppedFolder = vi.fn();
    const notify = vi.fn();
    window.electronAPI = {
      openDroppedFolder,
      platform: "linux",
    };

    render(<HookHarness notify={notify} />);

    const dropEvent = new Event("drop");
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: {
        files: [],
        items: [],
        types: ["Files"],
        getData: vi.fn(() => ""),
      },
    });
    dropEvent.preventDefault = vi.fn();

    window.dispatchEvent(dropEvent);

    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith(
        "We couldn't read that drop. Drop a folder to open it.",
        "info"
      );
      expect(openDroppedFolder).not.toHaveBeenCalled();
    });
  });
});
