import {
  createWebFileIdentity,
  createWebVideoRecord,
  normalizeWebFileRelativePath,
} from "./webFileIdentity";

const webFile = (overrides = {}) => ({
  name: "clip.mp4",
  webkitRelativePath: "run-a/clip.mp4",
  size: 1024,
  lastModified: 123456,
  type: "video/mp4",
  ...overrides,
});

describe("web file identity", () => {
  it("separates duplicate names/sizes by normalized relative path", () => {
    const first = webFile({ webkitRelativePath: "run-a/clip.mp4" });
    const second = webFile({ webkitRelativePath: "run-b\\clip.mp4" });

    expect(createWebFileIdentity(first, 0)).not.toBe(
      createWebFileIdentity(second, 0)
    );
    expect(normalizeWebFileRelativePath(second)).toBe("run-b/clip.mp4");
  });

  it("uses the original selection ordinal for otherwise identical entries", () => {
    const file = webFile();
    expect(createWebFileIdentity(file, 3)).not.toBe(
      createWebFileIdentity(file, 4)
    );
    expect(createWebFileIdentity(file, 3)).toBe(
      createWebFileIdentity({ ...file }, 3)
    );
  });

  it("canonicalizes dot segments and builds a relative-path-aware record", () => {
    const file = webFile({
      name: "clip.mp4",
      webkitRelativePath: "root\\temp\\..\\clip.mp4",
    });
    const record = createWebVideoRecord(file, 2);

    expect(record).toMatchObject({
      name: "clip.mp4",
      basename: "clip.mp4",
      dirname: "root",
      relativePath: "root/clip.mp4",
      createdMs: 123456,
      isElectronFile: false,
    });
    expect(record.id).toContain("root/clip.mp4");
    expect(record.file).toBe(file);
  });
});
