import { COMPANION_PHASE_LABELS } from "./companionFilters";

const NO_CHIP = Object.freeze({
  companionChipLabel: null,
  companionChipTone: null,
  companionChipTitle: null,
});

/**
 * A card's companion chip as primitives, so a memoized card re-renders only
 * when its own chip changes. The label and tone are the companion's; the
 * tooltip lists each action's phase and reason.
 */
export function companionCardProps(entry, actions = []) {
  const label = entry?.chip?.label;
  if (!label) return NO_CHIP;
  const lines = [];
  for (const action of actions) {
    const stage = entry.actions?.[action.id];
    if (!stage || stage.phase === "n/a") continue;
    lines.push(`${action.label}: ${stage.why || COMPANION_PHASE_LABELS[stage.phase] || stage.phase}`);
  }
  return {
    companionChipLabel: label,
    companionChipTone: entry.chip.tone || "info",
    companionChipTitle: lines.length ? lines.join("\n") : label,
  };
}
