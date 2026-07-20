import { act, renderHook, waitFor } from "@testing-library/react";
import { useLibraryCatalog } from "./useLibraryCatalog";

describe("useLibraryCatalog", () => {
  beforeEach(() => {
    window.electronAPI = {
      library: {
        listRoots: vi.fn().mockResolvedValue({
          success: true,
          roots: [{ rootPath: "/one", pinned: true }],
        }),
        getTree: vi.fn().mockResolvedValue({
          success: true,
          root: { rootPath: "/two", pinned: false },
          directories: [{ relativePath: "", name: "two" }],
        }),
        setPinned: vi.fn().mockResolvedValue({
          success: true,
          root: { rootPath: "/two", pinned: true },
        }),
      },
    };
  });

  afterEach(() => {
    delete window.electronAPI;
  });

  it("uses the fresh scan tree and lists pinned roots", async () => {
    const root = { rootPath: "/one", pinned: true };
    const directories = [{ relativePath: "", name: "one" }];
    const { result } = renderHook(() =>
      useLibraryCatalog({
        activeRootPath: "/one",
        scannedRoot: root,
        scannedDirectories: directories,
      })
    );

    await waitFor(() => expect(result.current.pinnedRoots).toHaveLength(1));
    expect(result.current.currentRoot).toEqual(root);
    expect(result.current.directories).toEqual(directories);
    expect(window.electronAPI.library.getTree).not.toHaveBeenCalled();
  });

  it("loads a tree on root changes and updates pin state", async () => {
    const { result } = renderHook(() =>
      useLibraryCatalog({
        activeRootPath: "/two",
        scannedRoot: null,
        scannedDirectories: [],
      })
    );

    await waitFor(() =>
      expect(result.current.currentRoot).toMatchObject({ rootPath: "/two" })
    );
    expect(window.electronAPI.library.getTree).toHaveBeenCalledWith("/two");
    window.electronAPI.library.listRoots.mockResolvedValue({
      success: true,
      roots: [
        { rootPath: "/one", pinned: true },
        { rootPath: "/two", pinned: true },
      ],
    });

    await act(async () => {
      await result.current.setPinned("/two", true);
    });

    expect(result.current.currentRoot.pinned).toBe(true);
    expect(result.current.pinnedRoots).toEqual(
      expect.arrayContaining([expect.objectContaining({ rootPath: "/two" })])
    );
  });

  it("refreshes after concurrent pin mutations so committed changes converge", async () => {
    const pinned = new Set();
    let resolveOne;
    let resolveTwo;
    window.electronAPI.library.listRoots.mockImplementation(async () => ({
      success: true,
      roots: ["/one", "/two"].map((rootPath) => ({
        rootPath,
        pinned: pinned.has(rootPath),
      })),
    }));
    window.electronAPI.library.setPinned.mockImplementation(
      (rootPath) =>
        new Promise((resolve) => {
          const finish = () => {
            pinned.add(rootPath);
            resolve({ success: true, root: { rootPath, pinned: true } });
          };
          if (rootPath === "/one") resolveOne = finish;
          else resolveTwo = finish;
        })
    );

    const { result } = renderHook(() =>
      useLibraryCatalog({ activeRootPath: null, scannedRoot: null })
    );
    await waitFor(() => expect(window.electronAPI.library.listRoots).toHaveBeenCalled());

    let first;
    let second;
    act(() => {
      first = result.current.setPinned("/one", true);
      second = result.current.setPinned("/two", true);
    });
    await act(async () => {
      resolveTwo();
      await second;
      resolveOne();
      await first;
    });

    expect(result.current.pinnedRoots.map((root) => root.rootPath).sort()).toEqual([
      "/one",
      "/two",
    ]);
  });
});
