// The tag tree, built from the tag list main sends ({ name, parent }). A tag
// stands for itself and every tag under it, so filtering by "dance" also
// finds clips tagged "bellydance". Clips only ever carry the tags applied to
// them; ancestors are derived here. See docs/architecture/tag-hierarchy.md.

const MAX_TAG_DEPTH = 8;
const lower = (name) => String(name ?? "").trim().toLowerCase();

export function buildTagHierarchy(availableTags = []) {
  const parentOf = new Map();
  const displayName = new Map();
  const childrenOf = new Map();
  for (const entry of Array.isArray(availableTags) ? availableTags : []) {
    const key = lower(entry?.name);
    if (!key) continue;
    displayName.set(key, String(entry.name).trim());
    const parent = lower(entry?.parent);
    if (!parent || parent === key) continue;
    parentOf.set(key, parent);
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(key);
  }

  const expansions = new Map();
  /** The tag and every tag under it, lowercased. */
  const expand = (name) => {
    const key = lower(name);
    if (expansions.has(key)) return expansions.get(key);
    const result = new Set([key]);
    const queue = [...(childrenOf.get(key) || [])];
    while (queue.length) {
      const next = queue.shift();
      if (result.has(next)) continue;
      result.add(next);
      queue.push(...(childrenOf.get(next) || []));
    }
    expansions.set(key, result);
    return result;
  };

  /** Display names from the top of the tree down to the tag itself. */
  const pathOf = (name) => {
    const path = [];
    const seen = new Set();
    let key = lower(name);
    while (key && !seen.has(key) && path.length <= MAX_TAG_DEPTH) {
      seen.add(key);
      path.unshift(displayName.get(key) || key);
      key = parentOf.get(key);
    }
    return path;
  };

  const hasHierarchy = parentOf.size > 0;

  return {
    hasHierarchy,
    expand,
    pathOf,
    parentOf: (name) => {
      const parent = parentOf.get(lower(name));
      return parent ? displayName.get(parent) || parent : null;
    },
    childrenOf: (name) =>
      (childrenOf.get(lower(name)) || []).map((key) => displayName.get(key) || key),
  };
}

export const EMPTY_TAG_HIERARCHY = buildTagHierarchy([]);

/** Whether a clip's own tags fall under `tag` (itself or anything under it). */
export function tagsMatch(clipTags, tag, hierarchy = EMPTY_TAG_HIERARCHY) {
  const expansion = hierarchy.expand(tag);
  for (const clipTag of clipTags) {
    if (expansion.has(clipTag)) return true;
  }
  return false;
}

/** "dance › bellydance" for a nested tag, the name alone otherwise. */
export function formatTagPath(name, hierarchy = EMPTY_TAG_HIERARCHY) {
  return hierarchy.pathOf(name).join(" › ");
}
