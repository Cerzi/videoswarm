const path = require("path");
const { createTaggedLibraryFiles } = require("./cached-library-snapshot");

/**
 * Build the renderer's answer to a sequence snapshot.
 *
 * Like `library-tag-view.js`, this lives outside the IPC handler so a test can
 * execute it rather than only read it, and for the same reason: the catalog
 * projection is not the wire shape. Without `id`, `sourceUrl` and `name` a
 * renderer receives clips it cannot key, play or label.
 *
 * Order is the whole point of a sequence, so entries keep their position and a
 * missing one keeps its slot with a null video. Dropping it here would shorten
 * the story silently, which is exactly what the panel exists to make visible.
 */
function buildSequenceSnapshotResponse(metadataStore, options = {}) {
  const { sequenceId, preferredRootPath, generation } = options;
  const snapshot = metadataStore.getSequenceSnapshot(sequenceId, {
    preferredRootPath,
  });
  if (!snapshot) return { sequence: null };

  const present = snapshot.entries.filter((entry) => entry.instance);
  const videos = createTaggedLibraryFiles(
    present.map((entry) => entry.instance),
    { generation }
  );
  // createTaggedLibraryFiles drops a record it cannot project, so pair by
  // absolute path rather than by index -- a positional zip would silently
  // shift every following entry onto the wrong clip. The record's id is a
  // resolved path, so the lookup key has to be resolved the same way.
  const videoByPath = new Map(videos.map((video) => [video.id, video]));
  const videoForEntry = (entry) => {
    const absolutePath = entry.instance?.absolutePath;
    if (typeof absolutePath !== "string" || !absolutePath) return null;
    return videoByPath.get(path.resolve(absolutePath)) || null;
  };

  return {
    sequence: {
      id: snapshot.id,
      name: snapshot.name,
      entryCount: snapshot.entryCount,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      entries: snapshot.entries.map((entry) => ({
        id: entry.id,
        position: entry.position,
        fingerprint: entry.fingerprint,
        addedAt: entry.addedAt,
        video: videoForEntry(entry),
      })),
      missingCount: snapshot.entries.filter((entry) => !videoForEntry(entry))
        .length,
    },
  };
}

module.exports = { buildSequenceSnapshotResponse };
