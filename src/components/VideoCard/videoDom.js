const encodePathSegments = (value) =>
  value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

export function toFileURL(absPath) {
  let normalized = String(absPath || "").replace(/\\/g, "/");

  // UNC paths carry their server as the URL authority.
  if (normalized.startsWith("//")) {
    const uncPath = normalized.replace(/^\/+/, "");
    return `file://${encodePathSegments(uncPath)}`;
  }

  normalized = normalized.replace(/^([A-Za-z]):/, "/$1:");
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;

  const encoded = encodePathSegments(normalized).replace(
    /^\/([A-Za-z])%3A(?=\/|$)/i,
    "/$1:"
  );
  return `file://${encoded}`;
}

export function hardDetach(el, { revokeBlobUrl = true } = {}) {
  if (!el) return;
  try { el.pause(); } catch {}
  if (
    revokeBlobUrl &&
    typeof el.src === "string" &&
    el.src.startsWith("blob:")
  ) {
    try { URL.revokeObjectURL(el.src); } catch {}
  }
  try { el.removeAttribute("src"); } catch {}
  try { el.srcObject = null; } catch {}
  try { el.load(); } catch {}
}
