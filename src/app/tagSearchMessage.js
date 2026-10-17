/**
 * Say what actually came back empty.
 *
 * A library search is defined by its tags, its match mode and its rating, so
 * "No clips carry that tag" is wrong for every case except a single tag: it
 * names a tag the user did not search for when several were selected, and
 * names a tag at all when none were.
 */
const ratingPhrase = ({ minRating = null, exactRating = null } = {}) => {
  if (exactRating != null) return `rated exactly ${exactRating} star${exactRating === 1 ? "" : "s"}`;
  if (minRating != null) return `rated ${minRating} star${minRating === 1 ? "" : "s"} or more`;
  return "";
};

export function emptyTagSearchMessage(tags, matchMode, rating = {}) {
  const selected = (Array.isArray(tags) ? tags : [])
    .map((tag) => (tag ?? "").toString().trim())
    .filter(Boolean);
  const rated = ratingPhrase(rating);
  if (rating.mightBe) return `No other clips look like "${rating.mightBe}" with these filters`;
  if (rating.promptQuery) return "No clips match those prompt words and filters";

  if (selected.length === 0) {
    return rated ? `No clips are ${rated}` : "The library has no clips to show";
  }
  const also = rated ? ` and are ${rated}` : "";
  if (selected.length === 1) return `No clips carry "${selected[0]}"${also}`;
  return matchMode === "any"
    ? `No clips carry any of those tags${also}`
    : `No clips carry all of those tags${also}`;
}
