import { normalizeReviewState } from "../review/reviewState";

const GENERATION_KEY_PATTERN = /^gk\d+-[0-9a-f]{32}$/;

export const normalizeVideoFromMain = (video) => {
  if (!video || typeof video !== "object") return video;
  const fullPath =
    typeof video.fullPath === "string" && video.fullPath
      ? video.fullPath
      : video.isElectronFile === true && typeof video.id === "string"
        ? video.id
        : null;
  const basename =
    typeof video.basename === "string" && video.basename
      ? video.basename
      : typeof video.name === "string"
        ? video.name
        : "";
  const fingerprint =
    typeof video.fingerprint === "string" && video.fingerprint.length > 0
      ? video.fingerprint
      : null;
  const rating =
    typeof video.rating === "number" && Number.isFinite(video.rating)
      ? Math.max(0, Math.min(5, Math.round(video.rating)))
      : null;
  const tags = Array.isArray(video.tags)
    ? Array.from(
        new Set(
          video.tags
            .map((tag) => (tag ?? "").toString().trim())
            .filter(Boolean)
        )
      )
    : [];

  const rawDimensions = video?.dimensions;
  const width = Number(rawDimensions?.width);
  const height = Number(rawDimensions?.height);
  const durationMs = Number(rawDimensions?.durationMs);
  const frameRate = Number(rawDimensions?.frameRate);
  const sanitizedDimensions =
    Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
      ? {
          width: Math.round(width),
          height: Math.round(height),
          aspectRatio:
            Number.isFinite(rawDimensions?.aspectRatio) && rawDimensions.aspectRatio > 0
              ? rawDimensions.aspectRatio
              : width / height,
          ...(Number.isFinite(durationMs) && durationMs > 0 ? { durationMs } : {}),
          ...(Number.isFinite(frameRate) && frameRate > 0 ? { frameRate } : {}),
        }
      : null;

  const aspectRatio = (() => {
    const candidate = Number(video?.aspectRatio);
    if (Number.isFinite(candidate) && candidate > 0) return candidate;
    return sanitizedDimensions ? sanitizedDimensions.aspectRatio : null;
  })();
  const hasAudio =
    typeof video.hasAudio === "boolean" ? video.hasAudio : null;

  const normalized = {
    ...video,
    fullPath,
    basename,
    fingerprint,
    rating,
    tags,
    reviewState: normalizeReviewState(video.reviewState),
    dimensions: sanitizedDimensions,
    aspectRatio,
    hasAudio,
  };
  // Generation-key fields are only rewritten when the incoming record states
  // them, so a record that says nothing never erases a key already known.
  if ("generationKey" in video) {
    normalized.generationKey =
      typeof video.generationKey === "string" &&
      GENERATION_KEY_PATTERN.test(video.generationKey)
        ? video.generationKey
        : null;
  }
  if ("generationKeyChecked" in video) {
    normalized.generationKeyChecked = video.generationKeyChecked === true;
  }
  return normalized;
};
