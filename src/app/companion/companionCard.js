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

const NO_QUICK_ACTIONS = Object.freeze([]);

/**
 * A card's one-click companion buttons: every action an app marks `quick`
 * that it says this clip has not been sent for. Nothing while an app has not
 * answered for the clip, so a button never offers what might be done.
 */
export function companionQuickActions(companions, instanceId) {
  const buttons = [];
  for (const companion of companions || []) {
    if (companion.status !== "online") continue;
    const entry = companion.entries?.get(instanceId);
    if (!entry) continue;
    for (const action of companion.actions || []) {
      if (action.quick !== true || entry.actions?.[action.id]?.phase !== "not-sent") continue;
      buttons.push({
        key: `${companion.id}/${action.id}`,
        companionId: companion.id,
        actionId: action.id,
        label: action.label,
        title:
          companions.length > 1 && companion.name
            ? `${action.send} · ${companion.name}`
            : action.hint
              ? `${action.send}: ${action.hint}`
              : action.send,
      });
    }
  }
  return buttons.length ? buttons : NO_QUICK_ACTIONS;
}

/** As createCompanionChipCache, for the one-click buttons. */
export function createCompanionQuickActionCache() {
  const held = new Map();
  return (companions, instanceId) => {
    const buttons = companionQuickActions(companions, instanceId);
    if (buttons === NO_QUICK_ACTIONS) {
      held.delete(instanceId);
      return NO_QUICK_ACTIONS;
    }
    const signature = JSON.stringify(buttons);
    const previous = held.get(instanceId);
    if (previous?.signature === signature) return previous.buttons;
    held.set(instanceId, { signature, buttons });
    return buttons;
  };
}
