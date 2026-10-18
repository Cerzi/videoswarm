import { describe, expect, it } from "vitest";
import {
  buildVersionMembers,
  versionCardLabel,
  versionLocation,
  versionSizeLabel,
} from "./versionView";

const hd = { width: 1920, height: 1080 };
const sd = { width: 640, height: 360 };

describe("versions view", () => {
  it("uses the collection's own clips where it holds a version, and guests for the rest", () => {
    const draft = { id: "/a/draft.mp4", fingerprint: "fd", dimensions: sd, rating: 2 };
    const draftCopy = { id: "/a/copy/draft.mp4", fingerprint: "fd", dimensions: sd };
    const records = [
      { id: "/b/final.mp4", fingerprint: "ff", dimensions: hd },
      { id: "/a/copy/draft.mp4", fingerprint: "fd", dimensions: sd },
    ];
    const { members, guests } = buildVersionMembers(records, {
      videos: [draftCopy, draft],
      originId: draft.id,
    });
    // Version order kept; the clip it was opened from stands for its content.
    expect(members.map((video) => video.id)).toEqual(["/b/final.mp4", "/a/draft.mp4"]);
    expect(members[1]).toBe(draft);
    expect(guests.map((video) => video.id)).toEqual(["/b/final.mp4"]);
  });

  it("shows the clip it was opened from until the versions arrive", () => {
    const draft = { id: "/a/draft.mp4", fingerprint: "fd" };
    expect(buildVersionMembers([], { videos: [draft], originId: draft.id })).toEqual({
      members: [draft],
      guests: [],
    });
    expect(buildVersionMembers([], { videos: [], originId: "gone" }).members).toEqual([]);
  });

  it("labels each version by size, the best first, and says where it lives", () => {
    expect(versionCardLabel(0, { dimensions: hd })).toBe("Best · 1920×1080");
    expect(versionCardLabel(1, { dimensions: sd })).toBe("640×360");
    expect(versionSizeLabel({})).toBe("Unknown size");
    expect(versionLocation({ rootPath: "/library/finals/", relativePath: "day1/a.mp4" })).toBe(
      "finals/day1/a.mp4"
    );
    expect(versionLocation({ rootPath: "C:\\Library\\Drafts", relativePath: "a.mp4" })).toBe("Drafts/a.mp4");
    expect(versionLocation({ name: "a.mp4" })).toBe("a.mp4");
  });
});
