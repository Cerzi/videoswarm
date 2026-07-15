const normalizeText = (value) => {
  const text = typeof value === "string" ? value : "";
  return typeof text.normalize === "function" ? text.normalize("NFC") : text;
};

const normalizeNonNegativeInteger = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number));
};

export const normalizeWebFileName = (file) =>
  normalizeText(file?.name) || "unnamed-video";

export const normalizeWebFileRelativePath = (file) => {
  const fallback = normalizeWebFileName(file);
  const raw = normalizeText(file?.webkitRelativePath) || fallback;
  const segments = [];

  for (const part of raw.replace(/\\/g, "/").split("/")) {
    const segment = normalizeText(part);
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.join("/") || fallback;
};

export const createWebFileIdentity = (file, selectionOrdinal = 0) => {
  const tuple = [
    normalizeWebFileRelativePath(file),
    normalizeWebFileName(file),
    normalizeNonNegativeInteger(file?.size),
    normalizeNonNegativeInteger(file?.lastModified),
    normalizeNonNegativeInteger(selectionOrdinal),
  ];
  // JSON tuple encoding is unambiguous even when filenames contain punctuation
  // used by hand-built delimiter formats.
  return `web-file:${JSON.stringify(tuple)}`;
};

export const createWebVideoRecord = (file, selectionOrdinal = 0) => {
  const relativePath = normalizeWebFileRelativePath(file);
  const segments = relativePath.split("/");
  const dirname = segments.length > 1 ? segments.slice(0, -1).join("/") : "";
  const name = normalizeWebFileName(file);

  return {
    id: createWebFileIdentity(file, selectionOrdinal),
    name,
    file,
    loaded: false,
    isElectronFile: false,
    basename: name,
    dirname,
    relativePath,
    createdMs: normalizeNonNegativeInteger(file?.lastModified),
    fingerprint: null,
    tags: [],
    rating: null,
  };
};
