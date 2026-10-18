// How many clips one action takes at once, as main bounds its requests:
// trash confirms at most 2,000 paths (main.js, confirm-move-to-trash), and
// moving, copying, linking, tags, ratings and review decisions name at most
// 20,000 (ACCEPTED_COPY_MAX_MEDIA, IPC_LIMITS.maxArrayEntries). A selection
// past them says so beside its count, rather than failing when acted on.
export const SELECTION_LIMITS = Object.freeze({ trash: 2_000, batch: 20_000 });

// From here a selection's count stands out, so a Ctrl+A over a large
// library is never mistaken for a handful of clips.
export const LARGE_SELECTION = 1_000;

const format = (value) => value.toLocaleString();

/** What a selection this large cannot do in one go, or null. */
export function selectionWarning(count) {
  const size = Number(count) || 0;
  if (size > SELECTION_LIMITS.batch) {
    return `Too many to move, copy, tag or rate at once (${format(SELECTION_LIMITS.batch)} at most)`;
  }
  if (size > SELECTION_LIMITS.trash) {
    return `Too many to trash at once (${format(SELECTION_LIMITS.trash)} at most)`;
  }
  return null;
}
