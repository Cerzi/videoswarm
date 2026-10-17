import { act, renderHook } from "@testing-library/react";
import { useStackFrames } from "./useStackFrames";

const member = (id, instanceId) => ({ id, instanceId });
const stacksOf = (...groups) =>
  new Map(groups.map((members, at) => [`k${at}`, { key: `k${at}`, members }]));

async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(400);
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

describe("useStackFrames", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    delete window.electronAPI;
  });

  function install() {
    let listener = null;
    const api = {
      frameFingerprints: vi.fn(async (ids) => ({
        success: true,
        hashes: Object.fromEntries(ids.filter((id) => id === 1).map((id) => [id, "00000000000000ff"])),
        pending: ids.length - 1,
      })),
      frameStills: vi.fn(async (ids) => ({
        success: true,
        stills: Object.fromEntries(ids.map((id) => [id, `data:image/jpeg;base64,${id}`])),
      })),
      onFrameFingerprints: vi.fn((callback) => {
        listener = callback;
        return () => {
          listener = null;
        };
      }),
    };
    window.electronAPI = { stacks: api };
    return { api, push: (payload) => listener?.(payload) };
  }

  it("asks for every stack member's fingerprint once, and takes the rest as they come", async () => {
    const { api, push } = install();
    const stacks = stacksOf([member("a", 1), member("b", 2)], [member("c", 3), member("d", 4)]);
    const { result, rerender } = renderHook((props) => useStackFrames(props), {
      initialProps: { stacks, enabled: true },
    });
    await settle();
    expect(api.frameFingerprints).toHaveBeenCalledWith([1, 2, 3, 4]);
    expect(result.current.hashOf(member("a", 1))).toBe("00000000000000ff");
    expect(result.current.hashOf(member("b", 2))).toBeNull();
    act(() => push({ hashes: { 2: "ff00000000000000" } }));
    expect(result.current.hashOf(member("b", 2))).toBe("ff00000000000000");

    rerender({ stacks: stacksOf([member("a", 1), member("b", 2), member("e", 5)]), enabled: true });
    await settle();
    expect(api.frameFingerprints).toHaveBeenLastCalledWith([5]);
  });

  it("asks for stills only of the rows wanted now", async () => {
    const { api } = install();
    const { result, rerender } = renderHook((props) => useStackFrames(props), {
      initialProps: { stacks: new Map(), enabled: true, stillIds: [3, 4] },
    });
    await settle();
    expect(api.frameStills).toHaveBeenCalledWith([3, 4]);
    expect(result.current.stillOf(member("c", 3))).toBe("data:image/jpeg;base64,3");
    rerender({ stacks: new Map(), enabled: true, stillIds: [3, 4, 9] });
    await settle();
    expect(api.frameStills).toHaveBeenLastCalledWith([9]);
  });

  it("asks nothing while stacking is off, and starts afresh for another collection", async () => {
    const { api } = install();
    const stacks = stacksOf([member("a", 1), member("b", 2)]);
    const { rerender } = renderHook((props) => useStackFrames(props), {
      initialProps: { stacks, enabled: false, resetKey: "one" },
    });
    await settle();
    expect(api.frameFingerprints).not.toHaveBeenCalled();
    rerender({ stacks, enabled: true, resetKey: "one" });
    await settle();
    rerender({ stacks: stacksOf([member("a", 1), member("b", 2)]), enabled: true, resetKey: "two" });
    await settle();
    expect(api.frameFingerprints).toHaveBeenCalledTimes(2);
  });
});
