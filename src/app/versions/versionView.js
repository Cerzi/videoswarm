// The versions view (docs/architecture/generation-versions.md, Section 8):
// every version of one clip's generation side by side, best first, including
// versions in folders that are not open.

export function versionSizeLabel(video) {
  const width = Number(video?.dimensions?.width);
  const height = Number(video?.dimensions?.height);
  return width > 0 && height > 0 ? `${width}×${height}` : "Unknown size";
}

/** The pill a version's card shows in the view: its size, and Best first. */
export function versionCardLabel(index, video) {
  const size = versionSizeLabel(video);
  return index === 0 ? `Best · ${size}` : size;
}

/** Where a version lives: its library folder's name and its path in it. */
export function versionLocation(video) {
  const root = String(video?.rootPath || "")
    .replace(/[\\/]+$/u, "")
    .split(/[\\/]/u)
    .filter(Boolean)
    .at(-1);
  const relative = String(video?.relativePath || video?.name || "");
  return root ? `${root}/${relative}` : relative;
}

/**
 * The view's clips in version order. A version the open collection holds is
 * the collection's own clip (the clip the view was opened from, for its own
 * content), so everything done to it shows in the grid behind; any other is
 * the record main sent, a guest. Without records yet, the origin alone.
 */
export function buildVersionMembers(records, { videos = [], originId = null } = {}) {
  const byId = new Map();
  const byFingerprint = new Map();
  for (const video of videos) {
    if (video?.id == null) continue;
    byId.set(video.id, video);
    if (video.fingerprint && !byFingerprint.has(video.fingerprint)) {
      byFingerprint.set(video.fingerprint, video);
    }
  }
  const origin = originId == null ? null : byId.get(originId) || null;
  if (origin?.fingerprint) byFingerprint.set(origin.fingerprint, origin);

  const members = [];
  const guests = [];
  const seen = new Set();
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || record.id == null) continue;
    const own = (record.fingerprint && byFingerprint.get(record.fingerprint)) || byId.get(record.id);
    const member = own || record;
    if (seen.has(member.id)) continue;
    seen.add(member.id);
    members.push(member);
    if (!own) guests.push(record);
  }
  if (members.length === 0 && origin) members.push(origin);
  return { members, guests };
}
