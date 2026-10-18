const fs = require("fs");
const { createTaggedLibraryFiles } = require("./cached-library-snapshot");

/**
 * Library roots whose folder can no longer be opened.
 *
 * A folder that was moved or deleted is never rescanned, so the catalog keeps
 * reporting its clips as present and a tag view would list them as broken
 * links. This is checked per request rather than recorded, so a drive that is
 * merely unmounted reappears in tag views as soon as it is back.
 */
async function findUnavailableRootPaths(rootPaths, { stat = fs.promises.stat } = {}) {
  const checks = await Promise.all(
    (Array.isArray(rootPaths) ? rootPaths : []).map(async (rootPath) => {
      try {
        const stats = await stat(rootPath);
        return stats.isDirectory() ? null : rootPath;
      } catch {
        return rootPath;
      }
    })
  );
  return checks.filter(Boolean);
}

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
  const {
    tagNames,
    matchMode,
    minRating = null,
    exactRating = null,
    promptKeys = null,
    mightBeTag = null,
    unavailableRootPaths,
    generation,
    assertActive,
  } = options;
  const snapshot = metadataStore.getTaggedLibrarySnapshot({
    tagNames,
    matchMode,
    minRating,
    exactRating,
    ...(promptKeys ? { promptKeys } : {}),
    ...(mightBeTag ? { mightBeTag } : {}),
    unavailableRootPaths,
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
 * Build the renderer's answer for the versions view: every present version of
 * one clip's generation, library-wide, one record per content in version
 * order, in the same playable shape as a tag view
 * (docs/architecture/generation-versions.md, Section 8).
 */
function buildGenerationVersionsResponse(metadataStore, options = {}) {
  const { instanceId, unavailableRootPaths, generation, assertActive } = options;
  const found = metadataStore.getGenerationVersionRecords(instanceId, {
    unavailableRootPaths,
    assertActive,
  });
  return {
    generationKey: found.generationKey,
    records: createTaggedLibraryFiles(found.records, { generation }),
    truncated: Boolean(found.truncated),
    rootPaths: found.rootPaths,
  };
}

module.exports = {
  buildGenerationVersionsResponse,
  buildTaggedSnapshotResponse,
  findUnavailableRootPaths,
};
