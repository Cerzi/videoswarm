import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import usePlaybackCapabilities, {
  describeDecodeCapability,
} from "./usePlaybackCapabilities";

describe("playback capabilities", () => {
  it("never promises Linux hardware decode", () => {
    expect(
      describeDecodeCapability({
        platform: "linux",
        hardwareDecodeDetected: true,
      })
    ).toMatch(/detected, not guaranteed/i);
    expect(
      describeDecodeCapability({
        platform: "linux",
        hardwareDecodeDetected: false,
      })
    ).toMatch(/not detected/i);
  });

  it("accepts a late capability response while mounted", async () => {
    let resolve;
    window.electronAPI = {
      platform: "linux",
      playback: {
        getCapabilities: vi.fn(
          () => new Promise((done) => {
            resolve = done;
          })
        ),
      },
    };

    const { result } = renderHook(() => usePlaybackCapabilities());
    await act(async () => {
      resolve({
        platform: "linux",
        hardwareDecodeDetected: true,
        videoDecodeStatus: "enabled",
      });
      await Promise.resolve();
    });

    expect(result.current.capabilities.videoDecodeStatus).toBe("enabled");
    expect(result.current.statusText).toMatch(/not guaranteed/i);
  });

  it("ignores a response after unmount", async () => {
    let resolve;
    window.electronAPI = {
      platform: "linux",
      playback: {
        getCapabilities: () =>
          new Promise((done) => {
            resolve = done;
          }),
      },
    };
    const { unmount } = renderHook(() => usePlaybackCapabilities());
    unmount();
    await act(async () => {
      resolve({ hardwareDecodeDetected: true });
      await Promise.resolve();
    });
  });
});
