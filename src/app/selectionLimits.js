// How many clips one action takes at once, as main bounds its requests:
// trash confirms at most 20,000 paths (DEFAULT_MAX_TRASH_ITEMS), and moving,
// copying and linking at most 50,000 (ACCEPTED_COPY_MAX_MEDIA, as many as a
// library view holds). Tags, ratings and review decisions go in batches, so
// they take any number. A selection past a limit says so beside its count,
// rather than failing when acted on.
export const SELECTION_LIMITS = Object.freeze({ trash: 20_000, transfer: 50_000 });

// From here a selection's count stands out, so a Ctrl+A over a large
// library is never mistaken for a handful of clips.
export const LARGE_SELECTION = 1_000;

const format = (value) => value.toLocaleString();

/** What a selection this large cannot do in one go, or null. */
export function selectionWarning(count) {
  const size = Number(count) || 0;
  if (size > SELECTION_LIMITS.transfer) {
    return `Too many to move or copy at once (${format(SELECTION_LIMITS.transfer)} at most)`;
  }
  if (size > SELECTION_LIMITS.trash) {
    return `Too many to trash at once (${format(SELECTION_LIMITS.trash)} at most)`;
  }
  return null;
}
