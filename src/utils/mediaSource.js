const OPAQUE_MEDIA_SCHEME = "videoswarm-media:";

export function normalizeOpaqueMediaSource(value) {
  if (typeof value !== "string" || !value || value.length > 2048) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== OPAQUE_MEDIA_SCHEME ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.hash ||
      (parsed.hostname !== "instance" && parsed.hostname !== "proxy")
    ) {
      return null;
    }
    if (parsed.hostname === "instance") {
      const versions = parsed.searchParams.getAll("v");
      const generations = parsed.searchParams.getAll("g");
      if (
        !/^\/[1-9]\d*$/.test(parsed.pathname) ||
        [...parsed.searchParams.keys()].some(
          (key) => key !== "v" && key !== "g"
        ) ||
        versions.length > 1 ||
        generations.length > 1 ||
        (versions[0] && versions[0].length > 128) ||
        (generations[0] !== undefined && !/^\d+$/.test(generations[0]))
      ) {
        return null;
      }
    } else {
      const generations = parsed.searchParams.getAll("g");
      if (
        !/^\/[a-f0-9]{64}$/i.test(parsed.pathname) ||
        [...parsed.searchParams.keys()].some((key) => key !== "g") ||
        generations.length > 1 ||
        (generations[0] !== undefined && !/^\d+$/.test(generations[0]))
      ) {
        return null;
      }
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function getOpaqueMediaSource(video) {
  return normalizeOpaqueMediaSource(video?.sourceUrl);
}

export function getWebMediaSource(video) {
  if (!video || video.isElectronFile) return null;
  if (typeof video.blobUrl === "string" && video.blobUrl) {
    return video.blobUrl;
  }
  const candidate = video.fullPath || video.relativePath;
  return typeof candidate === "string" && candidate ? candidate : null;
}
