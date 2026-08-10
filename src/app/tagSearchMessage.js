/**
 * Say what actually came back empty.
 *
 * A library search is defined by its tags and its match mode, so "No clips
 * carry that tag" is wrong for every case except a single tag: it names a tag
 * the user did not search for when several were selected, and names a tag at
 * all when none were.
 */
export function emptyTagSearchMessage(tags, matchMode) {
  const selected = (Array.isArray(tags) ? tags : [])
    .map((tag) => (tag ?? "").toString().trim())
    .filter(Boolean);

  if (selected.length === 0) return "The library has no clips to show";
  if (selected.length === 1) return `No clips carry "${selected[0]}"`;
  return matchMode === "any"
    ? "No clips carry any of those tags"
    : "No clips carry all of those tags";
}
