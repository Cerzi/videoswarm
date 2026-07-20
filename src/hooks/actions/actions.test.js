// src/hooks/actions/actions.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { actionRegistry, ActionIds, resolveVideoSource } from "./actions";
import { createMediaSlotScheduler } from "../../services/mediaSlotScheduler";

const makeVideo = (p) => ({
  id: p,
  name: p.split("/").pop(),
  isElectronFile: true,
  fullPath: p,
});

describe("resolveVideoSource", () => {
  it("uses opaque protocol URLs without exposing a native file path", () => {
    const video = {
      isElectronFile: true,
      fullPath: "/private/library/clip.mp4",
      sourceUrl: "videoswarm-media://instance/91?v=5",
    };

    expect(resolveVideoSource(video)).toEqual({
      src: "videoswarm-media://instance/91?v=5",
    });
  });

  it("does not turn an Electron path into a file URL", () => {
    expect(
      resolveVideoSource({
        isElectronFile: true,
        fullPath: "/private/library/clip.mp4",
      })
    ).toEqual({});
  });
});

describe("actionRegistry → MOVE_TO_TRASH (bulk)", () => {
  let electronAPI;
  let notify;
  let confirmMoveToTrash;
  let postConfirmRecovery;
  let releaseVideoHandlesForAsync;
  let onItemsRemoved;

  beforeEach(() => {
    notify = vi.fn();
    confirmMoveToTrash = vi.fn(async () => ({
      confirmed: true,
      confirmationToken: "confirmed-token",
      lastFocusedSelector: '.tag-input',
    }));
    postConfirmRecovery = vi.fn();
    releaseVideoHandlesForAsync = vi.fn(async () => {});
    onItemsRemoved = vi.fn();

    electronAPI = {
      // default: everything moves; tests will override per-case
      bulkMoveToTrash: vi.fn(async (paths) => ({
        success: true,
        moved: [...paths],
        failed: [],
      })),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("moves all items in one bulk call; releases handles pre/post; prunes and notifies", async () => {
    const videos = [makeVideo("/x"), makeVideo("/y")];

    await actionRegistry[ActionIds.MOVE_TO_TRASH](videos, {
      electronAPI,
      notify,
      confirmMoveToTrash,
      postConfirmRecovery,
      releaseVideoHandlesForAsync,
      onItemsRemoved,
    });

    // confirmation
    expect(confirmMoveToTrash).toHaveBeenCalledTimes(1);

    // bulk called once with all paths
    expect(electronAPI.bulkMoveToTrash).toHaveBeenCalledTimes(1);
    expect(electronAPI.bulkMoveToTrash).toHaveBeenCalledWith(
      ["/x", "/y"],
      "confirmed-token"
    );

    // handle releases: pre + post (with moved)
    expect(releaseVideoHandlesForAsync).toHaveBeenCalledTimes(2);
    expect(releaseVideoHandlesForAsync.mock.calls[0][0]).toEqual(["/x", "/y"]); // pre
    expect(new Set(releaseVideoHandlesForAsync.mock.calls[1][0])).toEqual(
      new Set(["/x", "/y"])
    ); // post

    // pruning includes moved paths
    expect(onItemsRemoved).toHaveBeenCalledTimes(1);
    const pruned = onItemsRemoved.mock.calls[0][0];
    expect(pruned instanceof Set).toBe(true);
    expect(pruned.has("/x")).toBe(true);
    expect(pruned.has("/y")).toBe(true);

    // some toast was shown (exact wording not enforced)
    expect(notify).toHaveBeenCalled();
  });

  it("retries transient failures and succeeds on retry; prunes moved; shows some toast", async () => {
    const videos = [makeVideo("/ok"), makeVideo("/locked")];

    // 1st call: '/locked' transient failure; 2nd (retry): moves '/locked'
    electronAPI.bulkMoveToTrash
      .mockResolvedValueOnce({
        success: true,
        moved: ["/ok"],
        failed: [{ path: "/locked", error: "EBUSY: in use" }],
        retryConfirmationToken: "retry-token",
      })
      .mockResolvedValueOnce({
        success: true,
        moved: ["/locked"],
        failed: [],
      });

    await actionRegistry[ActionIds.MOVE_TO_TRASH](videos, {
      electronAPI,
      notify,
      confirmMoveToTrash,
      postConfirmRecovery,
      releaseVideoHandlesForAsync,
      onItemsRemoved,
    });

    // call shapes: initial with both, retry with just the failed
    const calls = electronAPI.bulkMoveToTrash.mock.calls.map((c) => c[0]);
    expect(
      calls.some(
        (a) => Array.isArray(a) && a.length === 2 && a.includes("/ok") && a.includes("/locked")
      )
    ).toBe(true);
    expect(calls.some((a) => Array.isArray(a) && a.length === 1 && a[0] === "/locked")).toBe(true);
    expect(electronAPI.bulkMoveToTrash.mock.calls.map(([, token]) => token)).toEqual([
      "confirmed-token",
      "retry-token",
    ]);

    // pruning: union of all prune calls must include both moved items
    expect(onItemsRemoved).toHaveBeenCalled();
    const prunedUnion = new Set(onItemsRemoved.mock.calls.flatMap((c) => Array.from(c[0] || [])));
    expect(prunedUnion.has("/ok")).toBe(true);
    expect(prunedUnion.has("/locked")).toBe(true);

    // some toast shown
    expect(notify).toHaveBeenCalled();
  });

  it("retries transient failures and still fails one; prunes what moved; shows some toast", async () => {
    const videos = [makeVideo("/ok"), makeVideo("/locked")];

    // 1st: move '/ok', then exhaust two one-shot retry grants for '/locked'.
    electronAPI.bulkMoveToTrash
      .mockResolvedValueOnce({
        success: true,
        moved: ["/ok"],
        failed: [{ path: "/locked", error: "EBUSY: in use" }],
        retryConfirmationToken: "retry-token-1",
      })
      .mockResolvedValueOnce({
        success: true,
        moved: [],
        failed: [{ path: "/locked", error: "EBUSY" }],
        retryConfirmationToken: "retry-token-2",
      })
      .mockResolvedValueOnce({
        success: true,
        moved: [],
        failed: [{ path: "/locked", error: "EBUSY" }],
      });

    await actionRegistry[ActionIds.MOVE_TO_TRASH](videos, {
      electronAPI,
      notify,
      confirmMoveToTrash,
      postConfirmRecovery,
      releaseVideoHandlesForAsync,
      onItemsRemoved,
    });

    // call shapes: initial all, retry subset
    const calls = electronAPI.bulkMoveToTrash.mock.calls.map((c) => c[0]);
    expect(
      calls.some(
        (a) => Array.isArray(a) && a.length === 2 && a.includes("/ok") && a.includes("/locked")
      )
    ).toBe(true);
    expect(calls.some((a) => Array.isArray(a) && a.length === 1 && a[0] === "/locked")).toBe(true);

    // pruning includes '/ok' at least
    expect(onItemsRemoved).toHaveBeenCalled();
    const prunedUnion = new Set(onItemsRemoved.mock.calls.flatMap((c) => Array.from(c[0] || [])));
    expect(prunedUnion.has("/ok")).toBe(true);

    // some toast shown (success or warning/error depending on implementation)
    expect(notify).toHaveBeenCalled();
  });

  it("aborts when user cancels confirmation", async () => {
    confirmMoveToTrash.mockResolvedValue({ confirmed: false, lastFocusedSelector: '.tag-input' });
    const videos = [makeVideo("/x")];

    await actionRegistry[ActionIds.MOVE_TO_TRASH](videos, {
      electronAPI,
      notify,
      confirmMoveToTrash,
      postConfirmRecovery,
      releaseVideoHandlesForAsync,
      onItemsRemoved,
    });

    expect(confirmMoveToTrash).toHaveBeenCalledTimes(1);
    expect(electronAPI.bulkMoveToTrash).not.toHaveBeenCalled();
    expect(onItemsRemoved).not.toHaveBeenCalled();
    expect(releaseVideoHandlesForAsync).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(postConfirmRecovery).not.toHaveBeenCalled();
  });

  it('handles "nothing to trash" and shows info toast', async () => {
    const videos = [
      { id: "a", name: "a", isElectronFile: false, fullPath: "" },
      { id: "b", name: "b" }, // no fullPath
    ];

    await actionRegistry[ActionIds.MOVE_TO_TRASH](videos, {
      electronAPI,
      notify,
      confirmMoveToTrash,
      postConfirmRecovery,
      releaseVideoHandlesForAsync,
      onItemsRemoved,
    });

    expect(electronAPI.bulkMoveToTrash).not.toHaveBeenCalled();
    expect(releaseVideoHandlesForAsync).not.toHaveBeenCalled();
    expect(onItemsRemoved).not.toHaveBeenCalled();
    expect(
      notify.mock.calls.some((c) => typeof c?.[0] === "string" && /nothing to trash/i.test(c[0]))
    ).toBe(true);
  });

  it("calls postConfirmRecovery after successful run", async () => {
    const videos = [makeVideo("/x")];

    await actionRegistry[ActionIds.MOVE_TO_TRASH](videos, {
      electronAPI,
      notify,
      confirmMoveToTrash,
      postConfirmRecovery,
      releaseVideoHandlesForAsync,
      onItemsRemoved,
    });

    expect(postConfirmRecovery).toHaveBeenCalled();
    const lastCall = postConfirmRecovery.mock.calls.pop();
    expect(lastCall?.[0]?.cancelled).toBe(false);
  });

  it("keeps failed paths blocked until native trash work is finished", async () => {
    const videos = [makeVideo("/stays")];
    let blocked = false;
    const beginMediaMutation = vi.fn(() => { blocked = true; });
    const endMediaMutation = vi.fn(() => { blocked = false; });
    releaseVideoHandlesForAsync.mockImplementation(async () => {
      expect(blocked).toBe(true);
    });
    electronAPI.bulkMoveToTrash.mockImplementation(async () => {
      expect(blocked).toBe(true);
      return {
        success: false,
        moved: [],
        failed: [{ path: "/stays", error: "Permission denied" }],
      };
    });

    await actionRegistry[ActionIds.MOVE_TO_TRASH](videos, {
      electronAPI,
      notify,
      confirmMoveToTrash,
      postConfirmRecovery,
      releaseVideoHandlesForAsync,
      beginMediaMutation,
      endMediaMutation,
      onItemsRemoved,
    });

    expect(beginMediaMutation).toHaveBeenCalledWith(["/stays"]);
    expect(endMediaMutation).toHaveBeenCalledWith(
      ["/stays"],
      new Set()
    );
    expect(blocked).toBe(false);
    expect(onItemsRemoved).not.toHaveBeenCalled();
  });
});

describe("actionRegistry → COPY_LAST_FRAME", () => {
  const originalCreateElement = document.createElement;
  const createElementMock = vi.fn();

  beforeEach(() => {
    createElementMock.mockReset();
    vi.spyOn(document, "createElement").mockImplementation(createElementMock);
  });

  afterEach(() => {
    document.createElement.mockRestore();
    createElementMock.mockReset();
    if (document.querySelector?.mockRestore) {
      document.querySelector.mockRestore();
    }
  });

  const setupVideoCaptureMocks = ({ existingVideo = null } = {}) => {
    const videoListeners = new Map();
    const pauseMock = vi.fn();
    const playMock = vi.fn(() => Promise.resolve());
    const videoEl = {
      preload: "",
      muted: false,
      playsInline: false,
      crossOrigin: "",
      src: "",
      srcObject: null,
      duration: 10,
      videoWidth: 320,
      videoHeight: 180,
      currentTime: 0,
      paused: true,
      readyState: 2,
      addEventListener: vi.fn((event, handler) => {
        if (!videoListeners.has(event)) {
          videoListeners.set(event, new Set());
        }
        videoListeners.get(event).add(handler);
        if (event === "loadedmetadata" || event === "seeked") {
          handler();
        }
      }),
      removeEventListener: vi.fn((event, handler) => {
        videoListeners.get(event)?.delete(handler);
      }),
      pause: pauseMock,
      removeAttribute: vi.fn(),
      load: vi.fn(),
      remove: vi.fn(),
      play: playMock,
    };

    const ctx = {
      drawImage: vi.fn(),
    };
    const canvasEl = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ctx),
      toDataURL: vi.fn(() => "data:image/png;base64,abc"),
      toBlob: vi.fn((cb) => cb(new Blob(["x"], { type: "image/png" }))),
    };

    createElementMock.mockImplementation((tag) => {
      if (tag === "video") return videoEl;
      if (tag === "canvas") return canvasEl;
      return originalCreateElement.call(document, tag);
    });

    if (existingVideo) {
      vi.spyOn(document, "querySelector").mockReturnValue(existingVideo);
    }

    return { videoEl, canvasEl, pauseMock, playMock };
  };

  it("copies the last frame to clipboard via electron API and notifies", async () => {
    setupVideoCaptureMocks();
    const notify = vi.fn();
    const electronAPI = {
      copyImageToClipboard: vi.fn(async () => ({ success: true })),
    };

    await actionRegistry[ActionIds.COPY_LAST_FRAME](
      [{ blobUrl: "blob:test", name: "test" }],
      { electronAPI, notify }
    );

    expect(electronAPI.copyImageToClipboard).toHaveBeenCalledWith(
      "data:image/png;base64,abc"
    );
    expect(
      notify.mock.calls.some((call) => /last frame copied/i.test(call[0]))
    ).toBe(true);
  });

  it("owns a bounded auxiliary decoder while temporary capture media exists", async () => {
    setupVideoCaptureMocks();
    const scheduler = createMediaSlotScheduler({ maxExternalDecoders: 1 });
    const mediaScheduler = {
      reserveAuxiliaryDecoder: vi.fn((id) => {
        const lease = scheduler.reserveAuxiliaryDecoder(id);
        expect(scheduler.getSnapshot().auxiliaryDecoders).toBe(1);
        return lease;
      }),
      releaseDecoder: vi.fn((lease) => scheduler.releaseDecoder(lease)),
    };
    const electronAPI = {
      copyImageToClipboard: vi.fn(async () => ({ success: true })),
    };

    await actionRegistry[ActionIds.COPY_LAST_FRAME](
      [{ blobUrl: "blob:scheduled", name: "scheduled" }],
      { electronAPI, notify: vi.fn(), mediaScheduler }
    );

    expect(mediaScheduler.reserveAuxiliaryDecoder).toHaveBeenCalledOnce();
    expect(mediaScheduler.releaseDecoder).toHaveBeenCalledOnce();
    expect(scheduler.getSnapshot().auxiliaryDecoders).toBe(0);
  });

  it("prefers ffmpeg IPC when available for electron files", async () => {
    const notify = vi.fn();
    const electronAPI = {
      copyLastFrameFromFile: vi.fn(async () => ({ success: true })),
    };

    await actionRegistry[ActionIds.COPY_LAST_FRAME](
      [{ fullPath: "/tmp/video.mp4", isElectronFile: true, name: "test" }],
      { electronAPI, notify }
    );

    expect(electronAPI.copyLastFrameFromFile).toHaveBeenCalledWith("/tmp/video.mp4");
    expect(
      notify.mock.calls.some((call) => /last frame copied/i.test(call[0]))
    ).toBe(true);
  });

  it("does not start native or renderer frame capture while work is suspended", async () => {
    const notify = vi.fn();
    const electronAPI = {
      copyLastFrameFromFile: vi.fn(async () => ({ success: true })),
      copyImageToClipboard: vi.fn(async () => ({ success: true })),
    };
    const mediaScheduler = {
      reserveAuxiliaryDecoder: vi.fn(),
    };

    await actionRegistry[ActionIds.COPY_LAST_FRAME](
      [{ fullPath: "/tmp/video.mp4", isElectronFile: true, name: "test" }],
      { electronAPI, notify, mediaScheduler, workSuspended: true }
    );

    expect(electronAPI.copyLastFrameFromFile).not.toHaveBeenCalled();
    expect(electronAPI.copyImageToClipboard).not.toHaveBeenCalled();
    expect(mediaScheduler.reserveAuxiliaryDecoder).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "Restore the app before capturing a frame",
      "error"
    );
  });

  it("seeks to the last frame when reusing an existing video element", async () => {
    const assignedTimes = [];
    const loopAssignments = [];
    const existingVideo = {
      _time: 2,
      get currentTime() {
        return this._time;
      },
      set currentTime(value) {
        this._time = value;
        assignedTimes.push(value);
      },
      loop: true,
      duration: 8,
      seekable: {
        length: 1,
        end: () => 8,
      },
      videoWidth: 320,
      videoHeight: 180,
      paused: false,
      readyState: 4,
      dataset: { playbackDesired: "true" },
      addEventListener: vi.fn((event, handler) => {
        if (event === "seeked") handler();
      }),
      removeEventListener: vi.fn(),
      pause: vi.fn(),
      play: vi.fn(() => Promise.resolve()),
    };

    Object.defineProperty(existingVideo, "loop", {
      get() {
        return this._loop;
      },
      set(value) {
        this._loop = value;
        loopAssignments.push(value);
      },
    });
    existingVideo._loop = true;

    setupVideoCaptureMocks({ existingVideo });
    const notify = vi.fn();
    const electronAPI = {
      copyImageToClipboard: vi.fn(async () => ({ success: true })),
    };

    const hadCreateObjectURL = typeof URL.createObjectURL === "function";
    if (!hadCreateObjectURL) {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: vi.fn(),
      });
    }
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:must-not-be-created");

    await actionRegistry[ActionIds.COPY_LAST_FRAME](
      [{ id: "video-1", name: "test", file: new Blob(["video"]) }],
      { electronAPI, notify }
    );

    expect(assignedTimes.some((value) => Math.abs(value - 7.95) < 0.02)).toBe(true);
    expect(existingVideo.currentTime).toBe(2);
    expect(existingVideo.pause).toHaveBeenCalled();
    expect(existingVideo.dataset.mediaOperation).toBeUndefined();
    expect(existingVideo.play).toHaveBeenCalled();
    expect(loopAssignments).toContain(false);
    expect(loopAssignments[loopAssignments.length - 1]).toBe(true);
    expect(createObjectURL).not.toHaveBeenCalled();

    if (!hadCreateObjectURL) delete URL.createObjectURL;
  });

  it("restores an existing element even when capture fails", async () => {
    const assignedTimes = [];
    const existingVideo = {
      _time: 3,
      get currentTime() { return this._time; },
      set currentTime(value) {
        this._time = value;
        assignedTimes.push(value);
      },
      loop: true,
      duration: 8,
      videoWidth: 0,
      videoHeight: 0,
      paused: false,
      readyState: 4,
      addEventListener: vi.fn((event, handler) => {
        if (event === "seeked") handler();
      }),
      removeEventListener: vi.fn(),
      pause: vi.fn(),
      play: vi.fn(() => Promise.resolve()),
    };

    setupVideoCaptureMocks({ existingVideo });
    await actionRegistry[ActionIds.COPY_LAST_FRAME](
      [{ id: "restore-on-failure", name: "broken" }],
      { electronAPI: { copyImageToClipboard: vi.fn() }, notify: vi.fn() }
    );

    expect(existingVideo.currentTime).toBe(3);
    expect(existingVideo.loop).toBe(true);
    expect(existingVideo.play).toHaveBeenCalled();
    expect(assignedTimes).toContain(3);
  });

  it("times out a missing frame callback and fully releases temporary media", async () => {
    vi.useFakeTimers();
    const hadCreateObjectURL = typeof URL.createObjectURL === "function";
    const hadRevokeObjectURL = typeof URL.revokeObjectURL === "function";
    if (!hadCreateObjectURL) {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: vi.fn(),
      });
    }
    if (!hadRevokeObjectURL) {
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: vi.fn(),
      });
    }
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:frame-timeout");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { videoEl } = setupVideoCaptureMocks();
    videoEl.requestVideoFrameCallback = vi.fn(() => 77);
    videoEl.cancelVideoFrameCallback = vi.fn();
    const notify = vi.fn();

    const capture = actionRegistry[ActionIds.COPY_LAST_FRAME](
      [{ id: "timeout", name: "timeout", file: new Blob(["video"]) }],
      { electronAPI: { copyImageToClipboard: vi.fn() }, notify }
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2100);
    await capture;

    expect(videoEl.cancelVideoFrameCallback).toHaveBeenCalledWith(77);
    expect(videoEl.pause).toHaveBeenCalled();
    expect(videoEl.removeAttribute).toHaveBeenCalledWith("src");
    expect(videoEl.srcObject).toBeNull();
    expect(videoEl.load).toHaveBeenCalled();
    expect(videoEl.remove).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:frame-timeout");
    expect(notify).toHaveBeenCalledWith("Failed to copy last frame", "error");

    vi.useRealTimers();
    if (!hadCreateObjectURL) delete URL.createObjectURL;
    if (!hadRevokeObjectURL) delete URL.revokeObjectURL;
  });

  it("notifies failure when clipboard copy fails", async () => {
    setupVideoCaptureMocks();
    const notify = vi.fn();
    const electronAPI = {
      copyImageToClipboard: vi.fn(async () => ({ success: false, error: "NO" })),
    };

    await actionRegistry[ActionIds.COPY_LAST_FRAME](
      [{ blobUrl: "blob:test", name: "test" }],
      { electronAPI, notify }
    );

    expect(
      notify.mock.calls.some((call) => /failed to copy last frame/i.test(call[0]))
    ).toBe(true);
  });
});
