/**
 * The selected clips' fingerprints, in the order the collection is sorted.
 *
 * A selection is a Set, so iterating it yields click order. That order is real
 * but it is not a contract: it is invisible while being built, and a shift-click
 * or box select rebuilds the Set in grid order without saying so. Reading the
 * visible sort order instead gives the same answer every time for the same
 * grid, and arbitrary order is produced by reordering afterwards, where it can
 * be seen and corrected.
 *
 * Duplicate content collapses: two selected copies of identical bytes share a
 * fingerprint and are one clip, not two shots.
 */
export function orderSelectedFingerprints(orderedVideos, selectedIds) {
  if (!Array.isArray(orderedVideos) || !orderedVideos.length) return [];
  const selected =
    selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
  if (!selected.size) return [];

  const seen = new Set();
  const ordered = [];
  for (const video of orderedVideos) {
    if (!video || !selected.has(video.id)) continue;
    const fingerprint = video.fingerprint;
    if (!fingerprint || seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    ordered.push(fingerprint);
  }
  return ordered;
}
