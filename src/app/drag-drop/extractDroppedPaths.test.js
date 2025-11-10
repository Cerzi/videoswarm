import { describe, it, expect, vi, afterEach } from "vitest";
import {
  dropContainsDirectory,
  extractDroppedPaths,
  normalizeDroppedPath,
} from "./extractDroppedPaths";

describe("normalizeDroppedPath", () => {
  it("returns empty string for non-string", () => {
    expect(normalizeDroppedPath(null)).toBe("");
  });

  it("trims whitespace-only entries", () => {
    expect(normalizeDroppedPath("   ")).toBe("");
  });

  it("passes through absolute paths", () => {
    expect(normalizeDroppedPath("/Users/demo/Videos", "darwin")).toBe(
      "/Users/demo/Videos"
    );
  });

  it("converts file URIs on mac/linux", () => {
    expect(
      normalizeDroppedPath("file:///Users/demo/Videos", "darwin")
    ).toBe("/Users/demo/Videos");
  });

  it("converts file URIs on windows", () => {
    expect(
      normalizeDroppedPath("file:///C:/Users/demo/Videos", "win32")
    ).toBe("C:\\Users\\demo\\Videos");
  });

  it("converts windows network shares", () => {
    expect(
      normalizeDroppedPath("file://server/share/Videos", "win32")
    ).toBe("\\\\server\\share\\Videos");
  });
});

describe("extractDroppedPaths", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts file paths from FileList", () => {
    const event = {
      dataTransfer: {
        files: [{ path: "/videos/one" }, { path: "" }],
      },
    };

    expect(extractDroppedPaths(event, "darwin")).toEqual(["/videos/one"]);
  });

  it("de-dupes paths across sources", () => {
    const dataTransfer = {
      files: [{ path: "/videos/one" }],
      items: [
        {
          kind: "file",
          getAsFile: () => ({ path: "/videos/one" }),
        },
      ],
      getData: vi.fn(() => "file:///videos/one"),
    };

    expect(extractDroppedPaths({ dataTransfer }, "darwin")).toEqual([
      "/videos/one",
    ]);
    expect(dataTransfer.getData).toHaveBeenCalledWith("text/uri-list");
  });

  it("falls back to uri-list payloads when FileList is empty", () => {
    const dataTransfer = {
      files: [],
      items: [],
      getData: vi.fn((type) =>
        type === "text/uri-list" ? "file:///videos/one\n#comment" : ""
      ),
    };

    expect(extractDroppedPaths({ dataTransfer }, "darwin")).toEqual([
      "/videos/one",
    ]);
  });

  it("ignores uri parsing errors", () => {
    const dataTransfer = {
      files: [],
      items: [],
      getData: vi.fn(() => {
        throw new Error("nope");
      }),
    };

    expect(extractDroppedPaths({ dataTransfer }, "darwin")).toEqual([]);
  });

  it("consumes additional uri-like payloads", () => {
    const dataTransfer = {
      files: [],
      items: [],
      getData: vi.fn((type) =>
        type === "text/x-moz-url" ? "file:///videos/alt\nVideos" : ""
      ),
    };

    expect(extractDroppedPaths({ dataTransfer }, "darwin")).toEqual([
      "/videos/alt",
    ]);
  });

  it("parses plain-text windows paths", () => {
    const dataTransfer = {
      files: [],
      items: [],
      getData: vi.fn((type) =>
        type === "text/plain" ? "C:\\Users\\demo\\Videos" : ""
      ),
    };

    expect(extractDroppedPaths({ dataTransfer }, "win32")).toEqual([
      "C:\\Users\\demo\\Videos",
    ]);
  });
});

describe("dropContainsDirectory", () => {
  it("returns false without items", () => {
    expect(dropContainsDirectory({})).toBe(false);
  });

  it("detects directory entries", () => {
    const dataTransfer = {
      items: [
        {
          webkitGetAsEntry: () => ({ isDirectory: false }),
        },
        {
          webkitGetAsEntry: () => ({ isDirectory: true }),
        },
      ],
    };

    expect(dropContainsDirectory({ dataTransfer })).toBe(true);
  });

  it("handles inspection errors gracefully", () => {
    const dataTransfer = {
      items: [
        {
          webkitGetAsEntry: () => {
            throw new Error("boom");
          },
        },
      ],
    };

    expect(dropContainsDirectory({ dataTransfer })).toBe(false);
  });
});
