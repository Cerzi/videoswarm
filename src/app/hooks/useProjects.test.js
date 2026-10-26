import { act, renderHook, waitFor } from "@testing-library/react";
import { nextProjectName, useProjects } from "./useProjects";

const project = (id, name, extra = {}) => ({
  id,
  name,
  memberCount: 0,
  archived: false,
  ...extra,
});

describe("nextProjectName", () => {
  it("picks the next free Project N, case-insensitively", () => {
    expect(nextProjectName([])).toBe("Project 1");
    expect(nextProjectName([project(1, "Pitch")])).toBe("Project 2");
    expect(
      nextProjectName([project(1, "project 2"), project(2, "PROJECT 3")])
    ).toBe("Project 4");
  });
});

describe("useProjects", () => {
  let profileListener;

  beforeEach(() => {
    profileListener = null;
    window.electronAPI = {
      projects: {
        list: vi.fn().mockResolvedValue({
          success: true,
          projects: [project(2, "zeta"), project(1, "Alpha")],
        }),
        create: vi.fn().mockResolvedValue({
          success: true,
          project: project(3, "Beta"),
        }),
        rename: vi.fn(),
        setArchived: vi.fn().mockResolvedValue({
          success: true,
          project: project(1, "Alpha", { archived: true }),
        }),
        remove: vi.fn().mockResolvedValue({ success: true, deleted: true }),
        addClips: vi.fn().mockResolvedValue({
          success: true,
          added: 2,
          project: project(1, "Alpha", { memberCount: 2 }),
        }),
        removeClips: vi.fn(),
      },
      profiles: {
        onChanged: vi.fn((listener) => {
          profileListener = listener;
          return () => {};
        }),
      },
    };
  });

  afterEach(() => delete window.electronAPI);

  it("loads the list sorted by name", async () => {
    const { result } = renderHook(() => useProjects());
    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    expect(result.current.available).toBe(true);
    expect(result.current.projects.map((entry) => entry.name)).toEqual([
      "Alpha",
      "zeta",
    ]);
  });

  it("re-reads the list after every write so counts stay true", async () => {
    const { result } = renderHook(() => useProjects());
    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    const api = window.electronAPI.projects;

    let created;
    await act(async () => {
      created = await result.current.createProject("Beta");
    });
    expect(api.create).toHaveBeenCalledWith("Beta");
    expect(created).toMatchObject({ id: 3, name: "Beta" });

    let added;
    await act(async () => {
      added = await result.current.addClips(1, ["fp-a", "fp-b"]);
    });
    expect(api.addClips).toHaveBeenCalledWith(1, ["fp-a", "fp-b"]);
    expect(added.added).toBe(2);

    await act(async () => {
      await result.current.setProjectArchived(1, true);
    });
    expect(api.setArchived).toHaveBeenCalledWith(1, true);

    let deleted;
    await act(async () => {
      deleted = await result.current.deleteProject(1);
    });
    expect(deleted).toBe(true);
    // Initial load plus one refresh per write.
    expect(api.list).toHaveBeenCalledTimes(5);
  });

  it("surfaces a refused write with its code", async () => {
    window.electronAPI.projects.create.mockResolvedValueOnce({
      success: false,
      error: 'A project named "Alpha" already exists',
      code: "PROJECT_NAME_TAKEN",
    });
    const { result } = renderHook(() => useProjects());
    await waitFor(() => expect(result.current.projects).toHaveLength(2));

    let caught = null;
    await act(async () => {
      try {
        await result.current.createProject("alpha");
      } catch (error) {
        caught = error;
      }
    });
    expect(caught?.code).toBe("PROJECT_NAME_TAKEN");
    expect(result.current.error).toMatch(/already exists/);
  });

  it("clears and reloads the list when the profile changes", async () => {
    const { result } = renderHook(() => useProjects());
    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    window.electronAPI.projects.list.mockResolvedValueOnce({
      success: true,
      projects: [project(9, "Other profile")],
    });

    await act(async () => {
      profileListener();
    });
    await waitFor(() =>
      expect(result.current.projects.map((entry) => entry.name)).toEqual([
        "Other profile",
      ])
    );
  });

  it("reports itself unavailable without the bridge", async () => {
    delete window.electronAPI.projects;
    const { result } = renderHook(() => useProjects());
    expect(result.current.available).toBe(false);
    expect(await result.current.createProject("x")).toBeNull();
  });
});
