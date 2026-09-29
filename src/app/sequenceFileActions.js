/**
 * Positions (counting from one) of entries whose clip has no present file.
 */
export function missingSequencePositions(sequence) {
  const entries = Array.isArray(sequence?.entries) ? sequence.entries : [];
  const positions = [];
  entries.forEach((entry, index) => {
    if (!entry?.video) positions.push(index + 1);
  });
  return positions;
}

const listPositions = (positions) => {
  if (positions.length === 1) return `position ${positions[0]}`;
  const shown = positions.slice(0, 12).join(", ");
  const more = positions.length > 12 ? ` and ${positions.length - 12} more` : "";
  return `positions ${shown}${more}`;
};

/**
 * Why a sequence cannot be exported or renumbered yet, or null.
 *
 * Export and renumber refuse while any entry is missing (clip-sequences.md,
 * Section 7): a shortened export looks finished. The main process refuses
 * too; saying so here first avoids a destination picker that leads nowhere.
 */
export function describeSequenceBlocker(sequence, verb = "export") {
  const entries = Array.isArray(sequence?.entries) ? sequence.entries : [];
  if (!entries.length) return "This sequence has no clips yet";
  const missing = missingSequencePositions(sequence);
  if (!missing.length) return null;
  return (
    `Cannot ${verb} while clips are missing: ${listPositions(missing)}. ` +
    "Restore them or remove them from the sequence first."
  );
}
