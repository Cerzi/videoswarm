import { describe, test, expect } from "vitest";
import { toFileURL } from "./videoDom";

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
});
