import { useCallback, useEffect, useRef, useState } from "react";

const projectsApi = () => window.electronAPI?.projects || null;

const assertSuccess = (result, fallback) => {
  if (result?.success === false) {
    const error = new Error(result.error || fallback);
    if (result.code) error.code = result.code;
    throw error;
  }
  return result;
};

const byName = (left, right) =>
  String(left?.name || "").localeCompare(String(right?.name || ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });

/**
 * The next free "Project N" name, so a project created straight from a
 * selection never collides with one the user already named.
 */
export function nextProjectName(projects = []) {
  const taken = new Set(
    (Array.isArray(projects) ? projects : []).map((project) =>
      String(project?.name || "").toLowerCase()
    )
  );
  let ordinal = (Array.isArray(projects) ? projects.length : 0) + 1;
  while (taken.has(`project ${ordinal}`)) ordinal += 1;
  return `Project ${ordinal}`;
}

/**
 * Named, unordered groups of clips (docs/architecture/projects.md).
 *
 * The list lives here; opening a project is the caller's job, because it
 * replaces the open collection and that state belongs to the folder lifecycle.
 * Every write returns the updated project and re-reads the list, so member
 * counts in the sidebar stay true after an add or remove.
 */
export function useProjects() {
  const [projects, setProjects] = useState([]);
  const [error, setError] = useState(null);
  const requestRef = useRef(0);
  const profileEpochRef = useRef(0);

  const refreshProjects = useCallback(async () => {
    const api = projectsApi();
    if (!api?.list) return [];
    const requestId = ++requestRef.current;
    try {
      const result = assertSuccess(await api.list(), "Could not load projects");
      if (requestId !== requestRef.current) return [];
      const next = Array.isArray(result?.projects)
        ? [...result.projects].sort(byName)
        : [];
      setProjects(next);
      setError(null);
      return next;
    } catch (nextError) {
      if (requestId === requestRef.current) {
        setError(nextError?.message || "Could not load projects");
      }
      return [];
    }
  }, []);

  // Runs one write, keeps the list fresh, and drops the answer if the profile
  // changed underneath it: a late reply belongs to a database no longer open.
  const runWrite = useCallback(
    async (call, fallback) => {
      const profileEpoch = profileEpochRef.current;
      try {
        const result = assertSuccess(await call(), fallback);
        if (profileEpoch !== profileEpochRef.current) return null;
        await refreshProjects();
        if (profileEpoch !== profileEpochRef.current) return null;
        setError(null);
        return result;
      } catch (nextError) {
        if (profileEpoch === profileEpochRef.current) {
          setError(nextError?.message || fallback);
          throw nextError;
        }
        return null;
      }
    },
    [refreshProjects]
  );

  const createProject = useCallback(
    async (name) => {
      const api = projectsApi();
      if (!api?.create) return null;
      const result = await runWrite(
        () => api.create(name),
        "Could not create this project"
      );
      return result?.project ?? null;
    },
    [runWrite]
  );

  const renameProject = useCallback(
    async (id, name) => {
      const api = projectsApi();
      if (!api?.rename) return null;
      const result = await runWrite(
        () => api.rename(id, name),
        "Could not rename this project"
      );
      return result?.project ?? null;
    },
    [runWrite]
  );

  const setProjectArchived = useCallback(
    async (id, archived) => {
      const api = projectsApi();
      if (!api?.setArchived) return null;
      const result = await runWrite(
        () => api.setArchived(id, archived === true),
        archived ? "Could not archive this project" : "Could not restore this project"
      );
      return result?.project ?? null;
    },
    [runWrite]
  );

  const deleteProject = useCallback(
    async (id) => {
      const api = projectsApi();
      if (!api?.remove) return false;
      const result = await runWrite(
        () => api.remove(id),
        "Could not delete this project"
      );
      return Boolean(result?.deleted);
    },
    [runWrite]
  );

  const addClips = useCallback(
    async (id, fingerprints) => {
      const api = projectsApi();
      if (!api?.addClips) return null;
      return runWrite(
        () => api.addClips(id, fingerprints),
        "Could not add these clips"
      );
    },
    [runWrite]
  );

  const removeClips = useCallback(
    async (id, fingerprints) => {
      const api = projectsApi();
      if (!api?.removeClips) return null;
      return runWrite(
        () => api.removeClips(id, fingerprints),
        "Could not remove these clips"
      );
    },
    [runWrite]
  );

  useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    const subscribe = window.electronAPI?.profiles?.onChanged;
    if (!subscribe) return undefined;
    return subscribe(() => {
      requestRef.current += 1;
      profileEpochRef.current += 1;
      setProjects([]);
      setError(null);
      refreshProjects();
    });
  }, [refreshProjects]);

  return {
    available: Boolean(projectsApi()),
    projects,
    error,
    refreshProjects,
    createProject,
    renameProject,
    setProjectArchived,
    deleteProject,
    addClips,
    removeClips,
  };
}
