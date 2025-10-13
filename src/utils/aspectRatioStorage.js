const STORAGE_KEY = "videoswarm:aspect-ratios:v1";
const MIN_RATIO = 0.05;
const MAX_RATIO = 20;

function getLocalStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage || null;
  } catch (err) {
    return null;
  }
}

export function sanitizeAspectRatioHint(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (num <= MIN_RATIO || num >= MAX_RATIO) return null;
  return Math.round(num * 1000) / 1000;
}

export function loadAspectRatioHints() {
  const storage = getLocalStorage();
  if (!storage) return new Map();

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return new Map();

    const entries = Object.entries(parsed)
      .map(([key, value]) => [key, sanitizeAspectRatioHint(value)])
      .filter(([key, value]) => key && value !== null);

    return new Map(entries);
  } catch (err) {
    return new Map();
  }
}

export function persistAspectRatioHints(map) {
  const storage = getLocalStorage();
  if (!storage || !(map instanceof Map)) return;

  try {
    const serialized = {};
    for (const [key, value] of map.entries()) {
      const sanitized = sanitizeAspectRatioHint(value);
      if (!key || sanitized === null) continue;
      serialized[key] = sanitized;
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(serialized));
  } catch (err) {
    // Swallow quota / JSON errors silently; hints are opportunistic.
  }
}

export { sanitizeAspectRatioHint as __sanitizeAspectRatioForTests };
export { STORAGE_KEY as __ASPECT_RATIO_STORAGE_KEY };
