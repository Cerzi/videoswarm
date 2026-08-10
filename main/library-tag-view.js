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

module.exports = { buildTaggedSnapshotResponse };
