import { act, renderHook } from "@testing-library/react";
import {
  COMPANION_FOCUS_REFRESH_MS,
  COMPANION_POLL_MS,
  COMPANION_RETRY_MS,
  useCompanion,
} from "./useCompanion";

const clips = (count, start = 1) =>
  Array.from({ length: count }, (_, index) => ({ id: `c${start + index}`, instanceId: start + index }));
const stage = (phase) => ({ phase, why: "" });

// Advances time in small steps, letting renders, effects and promises run
// between them.
async function flush(ms = 0, step = 50) {
  let elapsed = 0;
  do {
    const advance = Math.min(step, ms - elapsed);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.max(0, advance));
    });
    elapsed += Math.max(advance, 1);
  } while (elapsed < ms);
}

function createApi({ phaseOf = () => "not-sent", enabled = true } = {}) {
  let changed = null;
  const api = {
    getConnection: vi.fn(async () => ({ enabled, url: "http://127.0.0.1:9" })),
    onConnectionChanged: vi.fn((callback) => {
      changed = callback;
      return () => {
        changed = null;
      };
    }),
    describe: vi.fn(async () => ({
      success: true,
      name: "Helper",
      actions: [{ id: "polish", label: "Polish", send: "Send to polish" }],
    })),
    lookup: vi.fn(async (ids) => ({
      success: true,
      results: Object.fromEntries(
        ids.map((id) => [id, { kind: "render", chip: null, actions: { polish: stage(phaseOf(id)) } }])
      ),
    })),
  };
  window.electronAPI = { companion: api };
  return { api, change: (value) => changed?.(value) };
}

describe("useCompanion", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    delete window.electronAPI;
  });

  it("stays off and asks nothing while not connected", async () => {
    const { api } = createApi({ enabled: false });
    const { result } = renderHook(() => useCompanion({ videos: clips(3) }));
    await flush(1000);
    expect(result.current.status).toBe("off");
    expect(api.describe).not.toHaveBeenCalled();
    expect(api.lookup).not.toHaveBeenCalled();
  });

  it("describes the companion and looks up the whole collection in chunks", async () => {
    const { api } = createApi();
    const { result } = renderHook(() => useCompanion({ videos: clips(1200) }));
    await flush(1000);
    expect(result.current.status).toBe("online");
    expect(result.current.name).toBe("Helper");
    expect(result.current.actions.map((action) => action.id)).toEqual(["polish"]);
    expect(api.lookup.mock.calls.map(([ids]) => ids.length)).toEqual([500, 500, 200]);
    expect(result.current.entries.get(1200).actions.polish.phase).toBe("not-sent");
  });

  it("asks again only about clips under way, and about new clips once", async () => {
    const { api } = createApi({ phaseOf: (id) => (id === 2 ? "under-way" : "done") });
    const { rerender } = renderHook(({ videos }) => useCompanion({ videos }), {
      initialProps: { videos: clips(3) },
    });
    await flush(1000);
    api.lookup.mockClear();
    await flush(COMPANION_POLL_MS);
    expect(api.lookup).toHaveBeenCalledWith([2]);

    api.lookup.mockClear();
    rerender({ videos: [...clips(3), ...clips(1, 9)] });
    await flush(500);
    expect(api.lookup).toHaveBeenCalledWith([9]);
  });

  it("goes offline when a lookup fails, and catches up when it answers again", async () => {
    const { api } = createApi();
    api.lookup.mockResolvedValueOnce({ success: false, code: "COMPANION_UNAVAILABLE" });
    const { result } = renderHook(() => useCompanion({ videos: clips(2) }));
    await flush(1000);
    expect(result.current.status).toBe("offline");
    await flush(COMPANION_RETRY_MS + 1000, 500);
    expect(result.current.status).toBe("online");
    expect(api.describe).toHaveBeenCalledTimes(2);
    expect(result.current.entries.size).toBe(2);
  });

  it("refreshes everything on focus, at most twice a minute", async () => {
    const { api } = createApi();
    renderHook(() => useCompanion({ videos: clips(2) }));
    await flush(1000);
    api.lookup.mockClear();
    act(() => window.dispatchEvent(new Event("focus")));
    await flush();
    expect(api.lookup).not.toHaveBeenCalled();
    await flush(COMPANION_FOCUS_REFRESH_MS, 1000);
    api.lookup.mockClear();
    act(() => window.dispatchEvent(new Event("focus")));
    await flush();
    expect(api.lookup).toHaveBeenCalledWith([1, 2]);
  });

  it("starts afresh when the connection changes", async () => {
    const { api, change } = createApi();
    const { result } = renderHook(() => useCompanion({ videos: clips(2) }));
    await flush(1000);
    expect(result.current.entries.size).toBe(2);
    act(() => change({ enabled: false, url: null }));
    await flush();
    expect(result.current.status).toBe("off");
    expect(result.current.entries.size).toBe(0);
    expect(api.lookup).toHaveBeenCalledTimes(1);
  });
});
