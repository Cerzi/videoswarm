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
    window.electronAPI = { openDroppedFolder, platform: "darwin" };
    const notify = vi.fn();

    render(<HookHarness notify={notify} />);

    const dropEvent = new Event("drop");
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: {
        files: [{ path: "file:///Users/demo/Videos" }],
        types: ["Files"],
        getData: vi.fn(() => ""),
      },
    });
    dropEvent.preventDefault = vi.fn();

    window.dispatchEvent(dropEvent);

    await waitFor(() => {
      expect(openDroppedFolder).toHaveBeenCalledWith([
        "/Users/demo/Videos",
      ]);
    });

    expect(notify).not.toHaveBeenCalled();
  });

  it("notifies when no directories are present", async () => {
    const openDroppedFolder = vi
      .fn()
      .mockResolvedValue({ success: false, reason: "NO_DIRECTORY" });
    window.electronAPI = { openDroppedFolder, platform: "darwin" };
    const notify = vi.fn();

    render(<HookHarness notify={notify} />);

    const dropEvent = new Event("drop");
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: {
        files: [{ path: "/Users/demo/file.mp4" }],
        types: ["Files"],
        getData: vi.fn(() => ""),
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
});
