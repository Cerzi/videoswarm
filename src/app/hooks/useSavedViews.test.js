import { act, renderHook, waitFor } from "@testing-library/react";
import { useSavedViews } from "./useSavedViews";

describe("useSavedViews", () => {
  beforeEach(() => {
    window.electronAPI = {
      library: {
        listSavedViews: vi.fn().mockResolvedValue({
          success: true,
          views: [{ id: 1, name: "Picks", definition: { version: 1 } }],
        }),
        createSavedView: vi.fn().mockResolvedValue({
          success: true,
          view: { id: 2, name: "Unreviewed", definition: { version: 1 } },
        }),
        updateSavedView: vi.fn(),
        deleteSavedView: vi.fn().mockResolvedValue({ success: true, deleted: true }),
      },
    };
  });

  afterEach(() => delete window.electronAPI);

  it("loads, creates, and deletes profile-local views", async () => {
    window.electronAPI.library.listSavedViews
      .mockResolvedValueOnce({
        success: true,
        views: [{ id: 1, name: "Picks", definition: { version: 1 } }],
      })
      .mockResolvedValueOnce({
        success: true,
        views: [
          { id: 1, name: "Picks", definition: { version: 1 } },
          { id: 2, name: "Unreviewed", definition: { version: 1 } },
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        views: [{ id: 2, name: "Unreviewed", definition: { version: 1 } }],
      });
    const { result } = renderHook(() => useSavedViews());
    await waitFor(() => expect(result.current.savedViews).toHaveLength(1));

    await act(async () => {
      await result.current.createSavedView("Unreviewed", { version: 1 });
    });
    expect(result.current.savedViews.map((view) => view.name)).toEqual([
      "Picks",
      "Unreviewed",
    ]);

    await act(async () => {
      await result.current.deleteSavedView(1);
    });
    expect(result.current.savedViews.map((view) => view.id)).toEqual([2]);
  });

  it("surfaces structured API errors", async () => {
    window.electronAPI.library.listSavedViews.mockResolvedValueOnce({
      success: false,
      error: "profile changed",
    });
    const { result } = renderHook(() => useSavedViews());
    await waitFor(() => expect(result.current.error).toBe("profile changed"));
    expect(result.current.savedViews).toEqual([]);
  });

  it("ignores a mutation that completes after a profile switch", async () => {
    let onProfileChanged;
    let resolveCreate;
    window.electronAPI.profiles = {
      onChanged: vi.fn((listener) => {
        onProfileChanged = listener;
        return vi.fn();
      }),
    };
    window.electronAPI.library.listSavedViews
      .mockResolvedValueOnce({
        success: true,
        views: [{ id: 1, name: "Picks", definition: { version: 1 } }],
      })
      .mockResolvedValue({ success: true, views: [] });
    window.electronAPI.library.createSavedView.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreate = resolve;
      })
    );

    const { result } = renderHook(() => useSavedViews());
    await waitFor(() => expect(result.current.savedViews).toHaveLength(1));

    let pendingCreate;
    act(() => {
      pendingCreate = result.current.createSavedView("Old profile view", {
        version: 1,
      });
      onProfileChanged();
    });
    await waitFor(() => expect(result.current.savedViews).toEqual([]));

    await act(async () => {
      resolveCreate({
        success: true,
        view: { id: 2, name: "Old profile view", definition: { version: 1 } },
      });
      await pendingCreate;
    });

    expect(result.current.savedViews).toEqual([]);
  });

  it("refreshes after concurrent mutations so committed views converge", async () => {
    const views = [];
    let resolveFirst;
    let resolveSecond;
    window.electronAPI.library.listSavedViews.mockImplementation(async () => ({
      success: true,
      views: [...views],
    }));
    window.electronAPI.library.createSavedView.mockImplementation(
      (name) =>
        new Promise((resolve) => {
          const view = {
            id: name === "First" ? 1 : 2,
            name,
            definition: { version: 1 },
          };
          const finish = () => {
            views.push(view);
            resolve({ success: true, view });
          };
          if (name === "First") resolveFirst = finish;
          else resolveSecond = finish;
        })
    );

    const { result } = renderHook(() => useSavedViews());
    await waitFor(() => expect(result.current.savedViews).toEqual([]));

    let first;
    let second;
    act(() => {
      first = result.current.createSavedView("First", { version: 1 });
      second = result.current.createSavedView("Second", { version: 1 });
    });
    await act(async () => {
      resolveSecond();
      await second;
      resolveFirst();
      await first;
    });

    expect(result.current.savedViews.map((view) => view.name).sort()).toEqual([
      "First",
      "Second",
    ]);
  });
});
