// src/utils/releaseVideoHandles.js
// Backward compatible: keep releaseVideoHandlesFor(...)
// Add a thorough async variant and preserve valid POSIX `?`/`#` filenames.

function normalizeFsPath(p = "") {
  let normalized = String(p || "").trim().replace(/\\/g, "/");
  const isDrivePath = /^\/?[A-Za-z]:\//.test(normalized);
  if (isDrivePath && normalized.startsWith("/")) normalized = normalized.slice(1);
  const isUncPath = normalized.startsWith("//");
  return isDrivePath || isUncPath ? normalized.toLowerCase() : normalized;
}

function normalizeSrc(value = "") {
  const source = String(value || "").trim();
  if (!/^file:/i.test(source)) return normalizeFsPath(source);

  try {
    const parsed = new URL(source);
    const pathname = decodeURIComponent(parsed.pathname || "");
    const rawPath = parsed.host
      ? `//${decodeURIComponent(parsed.host)}${pathname}`
      : pathname;
    return normalizeFsPath(rawPath);
  } catch {
    return normalizeFsPath(source.replace(/^file:\/\//i, ""));
  }
}

function revokeIfBlob(url) {
  try {
    if (typeof url === "string" && url.startsWith("blob:")) {
      URL.revokeObjectURL(url);
    }
  } catch {}
}

function hardReleaseVideoElement(v) {
  try { v.pause(); } catch {}

  // Revoke object URLs on the element and <source> children.
  try { revokeIfBlob(v.src); } catch {}
  let sourceElements = [];
  try { sourceElements = Array.from(v.querySelectorAll("source")); } catch {}
  for (const source of sourceElements) {
    try { revokeIfBlob(source.src); } catch {}
  }

  try { v.removeAttribute("src"); } catch {}
  try { v.srcObject = null; } catch {}
  for (const source of sourceElements) {
    try { source.remove(); } catch {}
  }
  try { v.removeAttribute("poster"); } catch {}
  try { v.preload = "none"; } catch {}
  try { v.load(); } catch {}
}

/** Original sync API (kept) */
export function releaseVideoHandlesFor(paths) {
  if (
    !Array.isArray(paths) ||
    !paths.length ||
    typeof document === "undefined"
  ) {
    return;
  }
  const targets = new Set(paths.map(normalizeFsPath));

  const matchesTarget = (norm) => targets.has(norm);

  document.querySelectorAll("video").forEach((v) => {
    try {
      const srcs = [
        v.currentSrc,
        v.src,
        v.getAttribute("src"),
        ...Array.from(v.querySelectorAll("source")).map((s) => s.getAttribute("src")),
        v.getAttribute("data-file-path"),
        ...Array.from(v.querySelectorAll("source")).map((s) => s.getAttribute("data-file-path")),
      ].filter(Boolean);

      const anyMatch = srcs.some((s) => matchesTarget(normalizeSrc(s)));
      if (anyMatch) hardReleaseVideoElement(v);
    } catch {}
  });
}

const waitForNextFrame = ({ timeoutMs = 50 } = {}) =>
  new Promise((resolve) => {
    let settled = false;
    let frameId = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve();
    };
    const timeoutId = setTimeout(() => {
      if (
        frameId !== null &&
        typeof cancelAnimationFrame === "function"
      ) {
        try { cancelAnimationFrame(frameId); } catch {}
      }
      finish();
    }, timeoutMs);

    if (typeof requestAnimationFrame === "function") {
      try {
        frameId = requestAnimationFrame(finish);
        return;
      } catch {}
    }
    setTimeout(finish, 0);
  });

/** New async helper: two passes + RAFs so Chromium actually drops OS handles */
export async function releaseVideoHandlesForAsync(paths, { extraPassDelayMs = 80 } = {}) {
  releaseVideoHandlesFor(paths);
  await new Promise((r) => setTimeout(r, extraPassDelayMs));
  await waitForNextFrame();
  releaseVideoHandlesFor(paths);
  await waitForNextFrame();
}
