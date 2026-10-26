const { createTaggedLibraryFiles } = require("./cached-library-snapshot");

/**
 * Build the renderer's answer to a library-wide tag search.
 *
 * This lives outside the IPC handler so it can be executed by a test rather
 * than only read by one. The handler around it does argument validation and
 * profile ownership; the part that decides what the renderer actually receives
 * is here.
 *
 * The catalog projection is deliberately not the wire shape. It carries no
 * `id`, `sourceUrl` or `name`, so a renderer handed it adopts a collection it
 * cannot key, play or label - which presents as an empty library rather than
 * as an error.
 */
function buildTaggedSnapshotResponse(metadataStore, options = {}) {
  const { tagNames, matchMode, generation, assertActive } = options;
  const snapshot = metadataStore.getTaggedLibrarySnapshot({
    tagNames,
    matchMode,
    assertActive,
  });
  return {
    tags: snapshot.tags,
    records: createTaggedLibraryFiles(snapshot.records, { generation }),
    truncated: Boolean(snapshot.truncated),
    recordLimit: snapshot.recordLimit,
    rootPaths: snapshot.rootPaths,
  };
}

/**
 * The renderer's answer to opening a project (docs/architecture/projects.md).
 *
 * Same wire shape as a tag view, so the renderer adopts it through the same
 * rootless-collection path. A missing project is reported rather than shown as
 * an empty one: a deleted project and a project with no clips are different
 * answers.
 */
function buildProjectSnapshotResponse(metadataStore, options = {}) {
  const { projectId, generation, assertActive } = options;
  const snapshot = metadataStore.getProjectSnapshot(projectId, { assertActive });
  if (!snapshot) {
    const error = new Error("This project no longer exists");
    error.code = "PROJECT_NOT_FOUND";
    throw error;
  }
  return {
    project: snapshot.project,
    records: createTaggedLibraryFiles(snapshot.records, { generation }),
    missingCount: Number(snapshot.missingCount || 0),
    truncated: Boolean(snapshot.truncated),
    recordLimit: snapshot.recordLimit,
    rootPaths: snapshot.rootPaths,
  };
}

module.exports = { buildTaggedSnapshotResponse, buildProjectSnapshotResponse };
