import { afterEach, describe, expect, test, vi } from "vitest";
import { hardDetach, toFileURL } from "./videoDom";

describe("toFileURL", () => {
  test("windows path → correct file:// url (no %5C)", () => {
    const url = toFileURL("C:\\Users\\me\\Videos\\clip #1.mp4");
    expect(url).toBe("file:///C:/Users/me/Videos/clip%20%231.mp4");
    expect(url.includes("%5C")).toBe(false);
  });

  test("keeps forward slashes", () => {
    const url = toFileURL("D:/media/video.webm");
    expect(url).toBe("file:///D:/media/video.webm");
  });

  test("encodes # fragment", () => {
    const url = toFileURL("E:\\a#b\\c d.mp4");
    expect(url).toBe("file:///E:/a%23b/c%20d.mp4");
  });

  test("encodes query-like characters in POSIX filenames", () => {
    expect(toFileURL("/tmp/run?seed=4#final.mp4")).toBe(
      "file:///tmp/run%3Fseed%3D4%23final.mp4"
    );
  });

  test("preserves UNC authority while encoding its path", () => {
    expect(toFileURL("\\\\server\\share\\clip 1.mp4")).toBe(
      "file://server/share/clip%201.mp4"
    );
  });
});

describe("hardDetach", () => {
  const originalRevokeObjectURL = URL.revokeObjectURL;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalRevokeObjectURL) {
      URL.revokeObjectURL = originalRevokeObjectURL;
    } else {
      delete URL.revokeObjectURL;
    }
  });

  test("pauses, revokes an owned blob source, clears media, and reloads", () => {
    if (typeof URL.revokeObjectURL !== "function") {
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: vi.fn(),
      });
    }
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const element = {
      src: "blob:owned-card-media",
      srcObject: { stream: true },
      pause: vi.fn(),
      removeAttribute: vi.fn(),
      load: vi.fn(),
    };

    hardDetach(element);

    expect(element.pause).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("blob:owned-card-media");
    expect(element.removeAttribute).toHaveBeenCalledWith("src");
    expect(element.srcObject).toBeNull();
    expect(element.load).toHaveBeenCalledOnce();
  });
});
