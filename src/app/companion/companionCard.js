import { COMPANION_PHASE_LABELS } from "./companionFilters";

const NO_CHIPS = Object.freeze([]);

/**
 * A card's companion chips, one per companion with something to say about
 * the clip: its own label and tone, and a tooltip listing each action's phase
 * and reason (under the companion's name when several are connected).
 * `companions` are sessions from useCompanions.
 */
export function companionCardChips(companions, instanceId) {
  const chips = [];
  for (const companion of companions || []) {
    const entry = companion.entries?.get(instanceId);
    const label = entry?.chip?.label;
    if (!label) continue;
    const lines = [];
    for (const action of companion.actions || []) {
      const stage = entry.actions?.[action.id];
      if (!stage || stage.phase === "n/a") continue;
      lines.push(`${action.label}: ${stage.why || COMPANION_PHASE_LABELS[stage.phase] || stage.phase}`);
    }
    const reasons = lines.length ? lines.join("\n") : label;
    chips.push({
      key: companion.id,
      label,
      tone: entry.chip.tone || "info",
      title: companions.length > 1 && companion.name ? `${companion.name}\n${reasons}` : reasons,
    });
  }
  return chips.length ? chips : NO_CHIPS;
}

/**
 * `(companions, instanceId) => chips` that hands back the same array while a
 * card's chips read the same, so a memoized card re-renders only when its own
 * chips change.
 */
export function createCompanionChipCache() {
  const held = new Map();
  return (companions, instanceId) => {
    const chips = companionCardChips(companions, instanceId);
    if (chips === NO_CHIPS) {
      held.delete(instanceId);
      return NO_CHIPS;
    }
    const signature = JSON.stringify(chips);
    const previous = held.get(instanceId);
    if (previous?.signature === signature) return previous.chips;
    held.set(instanceId, { signature, chips });
    return chips;
  };
}
