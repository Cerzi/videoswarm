// src/utils/releaseVideoHandles.js
// Backward compatible: keep releaseVideoHandlesFor(...)
// Add a thorough async variant and fix edge cases (blob: URLs, #t=... fragments)

function stripQueryAndHash(s = "") {
  return s.replace(/[?#].*$/, "");
}

function normalizeFsPath(p = "") {
  return stripQueryAndHash(p).trim().replace(/\\/g, "/").toLowerCase();
}

function normalizeSrc(u = "") {
  try {
    // file:///C:/path/file.mp4#t=0.1 -> c:/path/file.mp4
    const withoutScheme = String(u).replace(/^file:\/\//i, "");
    return normalizeFsPath(decodeURI(withoutScheme));
  } catch {
    return normalizeFsPath(String(u || ""));
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
  try {
    v.pause();

    // Revoke object URLs on the element and <source> children
    revokeIfBlob(v.src);
    Array.from(v.querySelectorAll("source")).forEach((s) => revokeIfBlob(s.src));

    // Fully detach sources & pipelines
    v.removeAttribute("src");
    v.src = "";
    v.srcObject = null;

    // Remove all <source> children (each can hold its own handle)
    Array.from(v.querySelectorAll("source")).forEach((s) => s.remove());

    // Be defensive
    v.removeAttribute("poster");
    v.preload = "none";

    // Force UA to drop decoders/handles
    v.load();
  } catch {}
}

/** Original sync API (kept) */
export function releaseVideoHandlesFor(paths) {
  if (!Array.isArray(paths) || !paths.length) return;
  const targets = new Set(paths.map(normalizeFsPath));

  const matchesTarget = (norm) =>
    targets.has(norm) || Array.from(targets).some((t) => norm.endsWith(t));

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

/** New async helper: two passes + RAFs so Chromium actually drops OS handles */
export async function releaseVideoHandlesForAsync(paths, { extraPassDelayMs = 80 } = {}) {
  releaseVideoHandlesFor(paths);
  await new Promise((r) => setTimeout(r, extraPassDelayMs));
  await new Promise((r) => requestAnimationFrame(() => r()));
  releaseVideoHandlesFor(paths);
  await new Promise((r) => requestAnimationFrame(() => r()));
}
