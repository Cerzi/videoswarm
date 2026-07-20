import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  getFullscreenRecordIdentity,
  useFullScreenModal,
} from "./useFullScreenModal";

const makeVideos = () => [
  { id: "one", name: "one.mp4", reviewState: "unreviewed" },
  { id: "two", name: "two.mp4", reviewState: "unreviewed" },
  { id: "three", name: "three.mp4", reviewState: "unreviewed" },
];

const renderController = (initialItems = makeVideos(), owner = "profile-a:/root") =>
  renderHook(
    ({ items, ownerKey }) =>
      useFullScreenModal({
        collectionOwnerKey: ownerKey,
        orderedVideos: items,
      }),
    { initialProps: { items: initialItems, ownerKey: owner } }
  );

describe("useFullScreenModal", () => {
  it("opens against the full order and navigates without wrapping", () => {
    const videos = makeVideos();
    const { result } = renderController(videos);

    let opened;
    act(() => {
      opened = result.current.open(videos[1]);
    });
    expect(opened).toBe(videos[1]);
    expect(result.current).toMatchObject({
      isOpen: true,
      currentVideo: videos[1],
      currentIndex: 1,
      currentViewIndex: 1,
      count: 3,
      isInCurrentView: true,
      previousId: "one",
      nextId: "three",
      canGoPrevious: true,
      canGoNext: true,
      isAtStart: false,
      isAtEnd: false,
    });
    const sessionToken = result.current.sessionToken;
    expect(sessionToken).toMatch(/^fullscreen-/);

    act(() => result.current.previous());
    expect(result.current.currentVideo).toBe(videos[0]);
    expect(result.current.isAtStart).toBe(true);

    let boundaryResult;
    act(() => {
      boundaryResult = result.current.previous();
    });
    expect(boundaryResult).toBeNull();
    expect(result.current.currentVideo).toBe(videos[0]);

    act(() => result.current.goTo("three"));
    expect(result.current.currentVideo).toBe(videos[2]);
    expect(result.current.isAtEnd).toBe(true);
    expect(result.current.sessionToken).toBe(sessionToken);

    act(() => {
      boundaryResult = result.current.next();
    });
    expect(boundaryResult).toBeNull();
    expect(result.current.currentVideo).toBe(videos[2]);
  });

  it("retains stable identity and playback session across metadata-only replacement", () => {
    const videos = makeVideos();
    const rendered = renderController(videos);

    act(() => rendered.result.current.open("two"));
    const sessionToken = rendered.result.current.sessionToken;
    const identity = rendered.result.current.currentIdentity;
    expect(identity).toBe(getFullscreenRecordIdentity(videos[1]));

    const replaced = videos.map((video) => ({
      ...video,
      reviewState: video.id === "two" ? "pick" : video.reviewState,
      rating: video.id === "two" ? 5 : null,
    }));
    rendered.rerender({ items: replaced, ownerKey: "profile-a:/root" });

    expect(rendered.result.current.currentVideo).toBe(replaced[1]);
    expect(rendered.result.current.currentIdentity).toBe(identity);
    expect(rendered.result.current.sessionToken).toBe(sessionToken);
    expect(rendered.result.current.currentIndex).toBe(1);
  });

  it("retains a filtered current record and follows its captured neighbor", () => {
    const videos = makeVideos();
    const rendered = renderController(videos);

    act(() => rendered.result.current.open("two"));
    const updatedCurrent = { ...videos[1], reviewState: "pick" };
    rendered.rerender({
      items: [videos[0], updatedCurrent, videos[2]],
      ownerKey: "profile-a:/root",
    });
    rendered.rerender({
      items: [videos[0], videos[2]],
      ownerKey: "profile-a:/root",
    });

    expect(rendered.result.current).toMatchObject({
      currentVideo: updatedCurrent,
      currentIndex: 1,
      currentViewIndex: -1,
      count: 2,
      isInCurrentView: false,
      previousId: "one",
      nextId: "three",
      canGoPrevious: true,
      canGoNext: true,
    });

    act(() => rendered.result.current.next());
    expect(rendered.result.current.currentVideo).toBe(videos[2]);
    expect(rendered.result.current.currentViewIndex).toBe(1);
  });

  it("closes on owner change even when the new collection reuses the same ID", () => {
    const videos = makeVideos();
    const rendered = renderController(videos, "profile-a:/root-a");

    act(() => rendered.result.current.open("two"));
    const firstToken = rendered.result.current.sessionToken;
    const replacement = videos.map((video) => ({
      ...video,
      name: `other-${video.name}`,
    }));

    rendered.rerender({
      items: replacement,
      ownerKey: "profile-b:/root-b",
    });
    expect(rendered.result.current).toMatchObject({
      isOpen: false,
      currentVideo: null,
      sessionToken: null,
      collectionOwnerKey: null,
    });

    rendered.rerender({ items: videos, ownerKey: "profile-a:/root-a" });
    expect(rendered.result.current.currentVideo).toBeNull();

    act(() => rendered.result.current.open("two"));
    expect(rendered.result.current.sessionToken).not.toBe(firstToken);
    expect(rendered.result.current.currentVideo).toBe(videos[1]);
  });

  it("uses an explicit source-removal fallback without treating filtering as removal", () => {
    const videos = makeVideos();
    const rendered = renderController(videos);

    act(() => rendered.result.current.open("two"));
    rendered.rerender({
      items: [videos[0], videos[2]],
      ownerKey: "profile-a:/root",
    });
    expect(rendered.result.current.currentVideo?.id).toBe("two");

    act(() => rendered.result.current.sourceRemoved("two"));
    expect(rendered.result.current.currentVideo).toBe(videos[2]);

    act(() => rendered.result.current.goTo("one"));
    rendered.rerender({ items: [], ownerKey: "profile-a:/root" });
    act(() => rendered.result.current.sourceRemoved("one"));
    expect(rendered.result.current.isOpen).toBe(false);
  });

  it("automatically advances records explicitly marked missing", () => {
    const videos = makeVideos();
    const rendered = renderController(videos);
    act(() => rendered.result.current.open("two"));

    const withMissingCurrent = [
      videos[0],
      { ...videos[1], present: false },
      videos[2],
    ];
    rendered.rerender({
      items: withMissingCurrent,
      ownerKey: "profile-a:/root",
    });

    expect(rendered.result.current.currentVideo).toBe(videos[2]);
    expect(rendered.result.current.sessionToken).not.toBeNull();
  });

  it("keeps direct navigation within the active owner and exposes legacy aliases", () => {
    const videos = makeVideos();
    const rendered = renderHook(() => useFullScreenModal(videos));

    expect(rendered.result.current.goTo("two")).toBeNull();
    act(() => rendered.result.current.openFullScreen(videos[0]));
    const sessionToken = rendered.result.current.sessionToken;

    expect(rendered.result.current).toMatchObject({
      fullScreenIndex: 0,
      fullScreenCount: 3,
      hasPrevious: false,
      hasNext: true,
      isCurrentInView: true,
      capturedPreviousId: null,
      capturedNextId: "two",
    });

    let navigated;
    act(() => {
      navigated = rendered.result.current.navigateFullScreen("next");
    });
    expect(navigated).toBe(videos[1]);
    expect(rendered.result.current.fullScreenVideo).toBe(videos[1]);
    expect(rendered.result.current.sessionToken).toBe(sessionToken);

    act(() => {
      navigated = rendered.result.current.goToFullScreen("three");
    });
    expect(navigated).toBe(videos[2]);
    expect(rendered.result.current.fullScreenVideo).toBe(videos[2]);

    let missing;
    act(() => {
      missing = rendered.result.current.goTo("missing");
    });
    expect(missing).toBeNull();
    expect(rendered.result.current.fullScreenVideo).toBe(videos[2]);

    let closingRecord;
    act(() => {
      closingRecord = rendered.result.current.closeFullScreen();
    });
    expect(closingRecord).toBe(videos[2]);
    expect(rendered.result.current.isOpen).toBe(false);
  });

  it("skips matching content only when auto-advance explicitly requests it", () => {
    const videos = [
      { id: "first", fingerprint: "same" },
      { id: "duplicate", fingerprint: "same" },
      { id: "distinct", fingerprint: "other" },
    ];
    const rendered = renderController(videos);
    act(() => rendered.result.current.openFullScreen("first"));

    let navigated;
    act(() => {
      navigated = rendered.result.current.navigateFullScreen("next");
    });
    expect(navigated).toBe(videos[1]);

    act(() => rendered.result.current.goToFullScreen("first"));
    expect(
      rendered.result.current.peekNavigation("next", {
        skipFingerprint: "same",
      })
    ).toBe(videos[2]);
    act(() => {
      navigated = rendered.result.current.navigateFullScreen("next", {
        skipFingerprint: "same",
      });
    });
    expect(navigated).toBe(videos[2]);
    expect(rendered.result.current.fullScreenVideo).toBe(videos[2]);
    expect(
      rendered.result.current.peekNavigation("next", {
        skipFingerprint: "same",
      })
    ).toBeNull();

    act(() => rendered.result.current.goToFullScreen("first"));
    rendered.rerender({
      items: [videos[1], videos[2]],
      ownerKey: "profile-a:/root",
    });
    expect(rendered.result.current.isCurrentInView).toBe(false);
    act(() => {
      navigated = rendered.result.current.navigateFullScreen("next", {
        skipFingerprint: "same",
      });
    });
    expect(navigated).toBe(videos[2]);
  });

  it("finds a distinct successor after filters remove current and captured duplicate", () => {
    const videos = [
      { id: "current", fingerprint: "same" },
      { id: "duplicate", fingerprint: "same" },
      { id: "distinct", fingerprint: "other" },
    ];
    const rendered = renderController(videos);
    act(() => rendered.result.current.open("current"));

    rendered.rerender({
      items: [videos[2]],
      ownerKey: "profile-a:/root",
    });

    expect(
      rendered.result.current.peekNavigation("next", {
        skipFingerprint: "same",
      })
    ).toBe(videos[2]);
    act(() =>
      rendered.result.current.navigateFullScreen("next", {
        skipFingerprint: "same",
      })
    );
    expect(rendered.result.current.currentVideo).toBe(videos[2]);
  });
});
