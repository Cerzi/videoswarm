import { afterEach, describe, expect, it } from "vitest";
import {
  fileManagerName,
  moveToTrashLabel,
  showInFileManagerLabel,
  trashName,
} from "./fileManagerTerms";

describe("file manager terms", () => {
  afterEach(() => {
    delete window.electronAPI;
  });

  it("uses each platform's own words", () => {
    expect([trashName("win32"), trashName("darwin"), trashName("linux")]).toEqual(["Recycle Bin", "Trash", "Trash"]);
    expect([fileManagerName("win32"), fileManagerName("darwin"), fileManagerName("linux")]).toEqual([
      "Explorer",
      "Finder",
      "File Manager",
    ]);
    expect(moveToTrashLabel("linux")).toBe("Move to Trash");
    expect(showInFileManagerLabel("win32")).toBe("Show in Explorer");
  });

  it("reads the platform the preload bridge reports", () => {
    window.electronAPI = { platform: "darwin" };
    expect(showInFileManagerLabel()).toBe("Show in Finder");
    expect(moveToTrashLabel()).toBe("Move to Trash");
  });
});
