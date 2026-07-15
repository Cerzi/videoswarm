export const MAX_METADATA_SUGGESTION_TAGS = 15;
export const MAX_FULLSCREEN_METADATA_SUGGESTION_TAGS = 100;

const asFiniteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export const deriveMetadataSelectionCount = (
  selectionCount,
  selectedVideos = []
) => {
  const numeric = Number(selectionCount);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return Array.isArray(selectedVideos) ? selectedVideos.length : 0;
};

export const deriveMetadataSelectionKey = (selectedVideos = [], key = null) => {
  if (key != null) return String(key);
  return (Array.isArray(selectedVideos) ? selectedVideos : [])
    .map((video, index) =>
      String(
        video?.instanceId ??
          video?.id ??
          video?.fingerprint ??
          video?.fullPath ??
          video?.name ??
          index
      )
    )
    .join("|");
};

const parseDate = (value) => {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
};

const formatDateTime = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date);
  } catch {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
      date.getDate()
    )} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
      date.getSeconds()
    )}`;
  }
};

const formatFileSize = (bytes) => {
  if (bytes === null || bytes === undefined || bytes === "") return null;
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return null;
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value / 1024;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  return `${scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2)} ${
    units[unitIndex]
  }`;
};

export const deriveMetadataFilename = (video) => {
  const fromMetadata = video?.metadata?.filename || video?.metadata?.fileName;
  const primary =
    video?.name || video?.filename || video?.fileName || fromMetadata;
  if (primary) return String(primary);

  const path = video?.fullPath || video?.path || video?.sourcePath;
  if (typeof path !== "string" || !path.trim()) return null;
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) || null;
};

export const deriveMetadataRelativePath = (video) => {
  const explicit =
    video?.relativePath || video?.relative_path || video?.webkitRelativePath;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.replace(/\\/g, "/").replace(/^\/+/, "");
  }

  const filename = deriveMetadataFilename(video);
  const directory =
    typeof video?.dirname === "string"
      ? video.dirname.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
      : "";
  return filename ? (directory ? `${directory}/${filename}` : filename) : null;
};

export const deriveSingleSelectionInfo = (
  selectedVideos = [],
  selectionCount = selectedVideos.length
) => {
  if (selectionCount !== 1 || !Array.isArray(selectedVideos)) return null;
  const video = selectedVideos[0];
  if (!video) return null;

  const createdDate =
    parseDate(video?.metadata?.dateCreatedFormatted) ||
    parseDate(video?.createdMs) ||
    parseDate(video?.dateCreated) ||
    parseDate(video?.metadata?.dateCreated);
  let created = formatDateTime(createdDate);
  if (!created && typeof video?.metadata?.dateCreatedFormatted === "string") {
    created = video.metadata.dateCreatedFormatted;
  }

  const width = asFiniteNumber(video?.dimensions?.width);
  const height = asFiniteNumber(video?.dimensions?.height);
  const resolution =
    width > 0 && height > 0 ? `${width}×${height}` : null;
  const filename = deriveMetadataFilename(video);
  const relativePath = deriveMetadataRelativePath(video);
  const sizeBytes = asFiniteNumber(video?.size ?? video?.file?.size);

  if (!filename && !created && !resolution && !relativePath && sizeBytes === null) {
    return null;
  }

  return {
    filename,
    relativePath,
    created,
    resolution,
    sizeBytes,
  };
};

export const buildMetadataInfoLineItems = (
  info,
  { includeRelativePath = false } = {}
) => {
  if (!info) return [];
  const items = [];
  if (info.filename) {
    items.push({
      key: "filename",
      label: info.filename,
      title: info.filename,
      className: "metadata-panel__info-item--filename",
    });
  }
  if (
    includeRelativePath &&
    info.relativePath &&
    info.relativePath !== info.filename
  ) {
    items.push({
      key: "relative-path",
      label: info.relativePath,
      title: info.relativePath,
      className: "metadata-panel__info-item--path",
    });
  }
  if (info.resolution) {
    items.push({ key: "resolution", label: info.resolution });
  }
  const formattedSize = formatFileSize(info.sizeBytes);
  if (formattedSize) {
    items.push({ key: "size", label: formattedSize });
  }
  if (info.created) items.push({ key: "created", label: info.created });
  return items;
};

export const deriveMetadataTagSummary = (
  selectedVideos = [],
  selectionCount = selectedVideos.length
) => {
  const counts = new Map();
  for (const video of Array.isArray(selectedVideos) ? selectedVideos : []) {
    for (const tag of Array.isArray(video?.tags) ? video.tags : []) {
      const key = (tag ?? "").toString().trim();
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  const sharedTags = [];
  const partialTags = [];
  if (selectionCount > 0) {
    counts.forEach((count, tag) => {
      if (count === selectionCount) sharedTags.push(tag);
      else if (count > 0 && count < selectionCount) {
        partialTags.push({ tag, count });
      }
    });
  }
  sharedTags.sort((left, right) => left.localeCompare(right));
  partialTags.sort((left, right) => left.tag.localeCompare(right.tag));
  return { sharedTags, partialTags };
};

export const normalizeMetadataAvailableTags = (availableTags = []) => {
  const deduped = new Map();
  for (const entry of Array.isArray(availableTags) ? availableTags : []) {
    const name = entry?.name?.trim();
    if (!name) continue;
    const usageCount = Number.isFinite(entry.usageCount) ? entry.usageCount : 0;
    const existing = deduped.get(name);
    if (!existing || existing.usageCount < usageCount) {
      deduped.set(name, { name, usageCount });
    }
  }
  return Array.from(deduped.values());
};

const tagRank = (left, right) =>
  (right.usageCount || 0) - (left.usageCount || 0) ||
  left.name.localeCompare(right.name);

export const selectMetadataTagSuggestions = ({
  availableTags = [],
  sharedTags = [],
  query = "",
  limit = MAX_METADATA_SUGGESTION_TAGS,
} = {}) => {
  const shared = new Set(sharedTags);
  const normalizedQuery = String(query || "").trim().toLowerCase();
  return normalizeMetadataAvailableTags(availableTags)
    .filter((entry) => !shared.has(entry.name))
    .filter(
      (entry) =>
        !normalizedQuery || entry.name.toLowerCase().includes(normalizedQuery)
    )
    .sort(tagRank)
    .slice(0, Math.max(0, Number(limit) || 0));
};

export const selectMetadataTagCompletion = (availableTags, query) => {
  const normalizedQuery = String(query || "").trim().toLowerCase();
  if (!normalizedQuery) return null;
  return (
    normalizeMetadataAvailableTags(availableTags)
      .filter((entry) => entry.name.toLowerCase().startsWith(normalizedQuery))
      .sort(tagRank)[0]?.name || null
  );
};

export const parseMetadataTagInput = (value) =>
  String(value || "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);

export const buildGenerationMetadataFacts = (metadata = {}) => {
  const facts = [
    ["Seed", metadata?.seed],
    ["Model", metadata?.models?.join(", ") || metadata?.model],
    ["Sampler", metadata?.samplers?.join(", ") || metadata?.sampler],
    ["Run", metadata?.generationRun],
    ["Source", metadata?.sourceImages?.join(", ") || metadata?.sourceImage],
  ];
  return facts
    .filter(([, value]) => Boolean(value))
    .map(([label, value]) => ({ label, value: String(value) }));
};
