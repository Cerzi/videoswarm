import { normalizeReviewState } from "../review/reviewState";

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
  const sanitizedDimensions =
    Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
      ? {
          width: Math.round(width),
          height: Math.round(height),
          aspectRatio:
            Number.isFinite(rawDimensions?.aspectRatio) && rawDimensions.aspectRatio > 0
              ? rawDimensions.aspectRatio
              : width / height,
        }
      : null;

  const aspectRatio = (() => {
    const candidate = Number(video?.aspectRatio);
    if (Number.isFinite(candidate) && candidate > 0) return candidate;
    return sanitizedDimensions ? sanitizedDimensions.aspectRatio : null;
  })();
  const hasAudio =
    typeof video.hasAudio === "boolean" ? video.hasAudio : null;

  return {
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
};
