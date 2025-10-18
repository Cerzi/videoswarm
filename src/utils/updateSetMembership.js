// src/utils/updateSetMembership.js
export function updateSetMembership(prevSet, id, shouldHave) {
  if (!(prevSet instanceof Set)) {
    throw new TypeError("updateSetMembership expects a Set as the first argument");
  }
  const has = prevSet.has(id);
  if (has === shouldHave) {
    return prevSet;
  }
  const next = new Set(prevSet);
  if (shouldHave) {
    next.add(id);
  } else {
    next.delete(id);
  }
  return next;
}

export function removeManyFromSet(prevSet, ids) {
  if (!(prevSet instanceof Set)) {
    throw new TypeError("removeManyFromSet expects a Set as the first argument");
  }
  if (!ids || typeof ids[Symbol.iterator] !== "function") {
    return prevSet;
  }
  let mutated = false;
  const next = new Set(prevSet);
  for (const id of ids) {
    if (next.delete(id)) {
      mutated = true;
    }
  }
  return mutated ? next : prevSet;
}
