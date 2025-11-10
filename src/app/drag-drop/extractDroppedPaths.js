const FILE_URI_PREFIX = /^file:\/\//i;
const URI_LIST_TYPES = ["text/uri-list", "text/x-moz-url"];
const FALLBACK_TEXT_TYPES = ["text/plain", "text/x-vscode-resource", "text/x-moz-url-data"];

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

function safeArrayFrom(value) {
  if (!value) {
    return [];
  }

  try {
    return Array.from(value);
  } catch (error) {
    console.warn("Failed to iterate drop payload", error);
    return [];
  }
}

function parsePlainTextList(value, addPath) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }

  const lines = value.split(/\r?\n/);
  let added = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    addPath(line);
    added = true;
  }
  return added;
}

function parseUriList(value, addPath, { stopAfterFirst = false } = {}) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }

  const lines = value.split(/\r?\n/);
  let added = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    addPath(line);
    added = true;

    if (stopAfterFirst) {
      break;
    }
  }
  return added;
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

  const files = dataTransfer?.files;
  const items = dataTransfer?.items;

  if (files && typeof files.length === "number") {
    for (const file of safeArrayFrom(files)) {
      if (typeof file?.path === "string") {
        addPath(file.path);
      }
    }
  }

  if (items && typeof items.length === "number") {
    for (const item of safeArrayFrom(items)) {
      if (item?.kind === "file" && typeof item.getAsFile === "function") {
        const file = item.getAsFile();
        if (file && typeof file.path === "string") {
          addPath(file.path);
        }
      }
    }
  }

  if (typeof dataTransfer?.getData === "function") {
    for (const type of URI_LIST_TYPES) {
      try {
        const consumed = parseUriList(
          dataTransfer.getData(type),
          addPath,
          { stopAfterFirst: type !== "text/uri-list" }
        );
        if (consumed && type !== "text/uri-list" && uniquePaths.size > 0) {
          break;
        }
      } catch (error) {
        console.warn(`Failed to read ${type} from drop payload`, error);
      }
    }

    if (uniquePaths.size === 0) {
      for (const type of FALLBACK_TEXT_TYPES) {
        try {
          const consumed = parsePlainTextList(dataTransfer.getData(type), addPath);
          if (consumed && type !== "text/plain") {
            break;
          }
        } catch (error) {
          if (type === "text/plain") {
            // Ignore plain-text errors silently to avoid noisy logs
            continue;
          }
          console.warn(`Failed to read ${type} from drop payload`, error);
        }
      }
    }
  }

  return Array.from(uniquePaths);
}

export function dropContainsDirectory(eventOrDataTransfer) {
  const dataTransfer = eventOrDataTransfer?.dataTransfer
    ? eventOrDataTransfer.dataTransfer
    : eventOrDataTransfer;

  const items = dataTransfer?.items;
  if (!items || typeof items.length !== "number") {
    return false;
  }

  for (const item of safeArrayFrom(items)) {
    if (typeof item?.webkitGetAsEntry === "function") {
      try {
        const entry = item.webkitGetAsEntry();
        if (entry?.isDirectory) {
          return true;
        }
      } catch (error) {
        console.warn("Failed to inspect drop entry", error);
      }
    }
  }

  return false;
}
