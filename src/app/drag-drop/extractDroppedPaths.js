const FILE_URI_PREFIX = /^file:\/\//i;

function decodeFileUri(uri, platform = "unknown") {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:") {
      return "";
    }

    const hostname = url.hostname || "";
    let pathname = decodeURIComponent(url.pathname || "");

    if (platform === "win32") {
      if (hostname) {
        const normalizedPath = pathname.replace(/\//g, "\\");
        return `\\\\${hostname}${normalizedPath}`;
      }

      if (pathname.startsWith("/")) {
        pathname = pathname.slice(1);
      }

      return pathname.replace(/\//g, "\\");
    }

    if (hostname) {
      return `//${hostname}${pathname}`;
    }

    return pathname || "/";
  } catch (error) {
    console.warn("Failed to decode file URI", uri, error);
    return "";
  }
}

export function normalizeDroppedPath(rawPath, platform = "unknown") {
  if (typeof rawPath !== "string") {
    return "";
  }

  const trimmed = rawPath.trim();
  if (!trimmed) {
    return "";
  }

  if (FILE_URI_PREFIX.test(trimmed)) {
    return decodeFileUri(trimmed, platform);
  }

  return trimmed;
}

export function extractDroppedPaths(eventOrDataTransfer, platform = "unknown") {
  const dataTransfer = eventOrDataTransfer?.dataTransfer
    ? eventOrDataTransfer.dataTransfer
    : eventOrDataTransfer;

  if (!dataTransfer) {
    return [];
  }

  const uniquePaths = new Set();
  const addPath = (value) => {
    const normalized = normalizeDroppedPath(value, platform);
    if (normalized) {
      uniquePaths.add(normalized);
    }
  };

  const { files, items } = dataTransfer;

  if (files && typeof files.length === "number") {
    for (const file of Array.from(files)) {
      if (typeof file?.path === "string") {
        addPath(file.path);
      }
    }
  }

  if (items && typeof items.length === "number") {
    for (const item of Array.from(items)) {
      if (item?.kind === "file" && typeof item.getAsFile === "function") {
        const file = item.getAsFile();
        if (file && typeof file.path === "string") {
          addPath(file.path);
        }
      }
    }
  }

  if (typeof dataTransfer.getData === "function") {
    const parseUriList = (value) => {
      if (typeof value !== "string" || value.trim().length === 0) {
        return;
      }

      const lines = value.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          continue;
        }
        addPath(trimmed);
      }
    };

    try {
      parseUriList(dataTransfer.getData("text/uri-list"));
    } catch (error) {
      console.warn("Failed to read text/uri-list from drop payload", error);
    }

    if (uniquePaths.size === 0) {
      try {
        parseUriList(dataTransfer.getData("text/plain"));
      } catch (error) {
        // Ignore text/plain errors silently
      }
    }
  }

  return Array.from(uniquePaths);
}
