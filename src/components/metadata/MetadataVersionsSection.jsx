import React, { useEffect, useRef, useState } from "react";

// Siblings of one clip's generation, library-wide, in version order. Loaded
// lazily and only for a clip known to have two or more versions. See
// docs/architecture/generation-versions.md, Section 5.

export const VERSION_SIBLINGS_DEBOUNCE_MS = 150;

const getApi = () =>
  typeof window === "undefined" ? null : window.electronAPI?.generationVersions || null;

export function formatVersionFacts(version) {
  const parts = [];
  if (version.width && version.height) {
    parts.push(`${version.width}×${version.height}`);
  } else {
    parts.push("Unknown size");
  }
  if (Number.isFinite(version.durationMs) && version.durationMs > 0) {
    parts.push(`${(version.durationMs / 1000).toFixed(1)} s`);
  }
  if (Number.isFinite(version.mtimeMs) && version.mtimeMs > 0) {
    parts.push(new Date(version.mtimeMs).toLocaleDateString());
  }
  return parts.join(" · ");
}

export function formatVersionLocation(version) {
  const root = String(version.rootPath || "")
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .filter(Boolean)
    .at(-1);
  const relative = String(version.relativePath || "");
  return root ? `${root}/${relative}` : relative;
}

function useVersionSiblings(instanceId, enabled) {
  const [state, setState] = useState({ loading: false, versions: [], truncated: false, error: null });
  const requestRef = useRef(0);

  useEffect(() => {
    const api = getApi();
    const requestId = ++requestRef.current;
    if (!enabled || !instanceId || typeof api?.siblings !== "function") {
      setState({ loading: false, versions: [], truncated: false, error: null });
      return undefined;
    }
    setState((previous) => ({ ...previous, loading: true, error: null }));
    const timer = setTimeout(async () => {
      let result = null;
      try {
        result = await api.siblings(instanceId);
      } catch {
        result = { success: false };
      }
      if (requestRef.current !== requestId) return;
      if (!result || result.success === false) {
        setState({ loading: false, versions: [], truncated: false, error: "Versions could not be read." });
        return;
      }
      setState({
        loading: false,
        versions: Array.isArray(result.versions) ? result.versions : [],
        truncated: result.truncated === true,
        error: null,
      });
    }, VERSION_SIBLINGS_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, instanceId]);

  return state;
}

const TARGET_EXPLANATIONS = {
  filtered: "Hidden by the current filters or folder scope",
  elsewhere: "In a folder that is not open",
};

/**
 * `generationVersions` is `{ index, resolveTarget, onSelect }` from the app:
 * `index` maps a video id to its version entry, `resolveTarget(instanceId)`
 * returns "available", "filtered" or "elsewhere", and `onSelect(instanceId)`
 * selects and reveals an available clip.
 */
export default function MetadataVersionsSection({ video, active = true, generationVersions }) {
  const entry = video ? generationVersions?.index?.get?.(video.id) : null;
  const enabled = Boolean(active && entry && entry.versionCount >= 2 && video?.instanceId);
  const { loading, versions, truncated, error } = useVersionSiblings(
    video?.instanceId,
    enabled
  );
  if (!enabled) return null;

  const best = versions[0] || null;
  return (
    <section className="metadata-panel__section metadata-panel__versions">
      <div className="metadata-panel__section-header">
        <span title="Re-renders, upscales and sweeps of the same generation, across every indexed folder">
          Versions
        </span>
        <span className="metadata-panel__badge">{entry.versionCount}</span>
      </div>
      {loading && versions.length === 0 ? (
        <p className="metadata-panel__generation-status">Reading versions…</p>
      ) : error ? (
        <p className="metadata-panel__generation-status metadata-panel__generation-status--error">
          {error}
        </p>
      ) : (
        <ol className="metadata-panel__versions-list">
          {versions.map((version) => {
            const target = version.isSelf
              ? "self"
              : generationVersions?.resolveTarget?.(version.instanceId) || "elsewhere";
            const selectable = target === "available";
            const location = formatVersionLocation(version);
            const content = (
              <>
                <span className="metadata-panel__versions-facts">
                  {formatVersionFacts(version)}
                  {version === best ? (
                    <span className="metadata-panel__badge metadata-panel__badge--accent">Best</span>
                  ) : null}
                  {version.isSelf ? (
                    <span className="metadata-panel__badge">This clip</span>
                  ) : null}
                </span>
                <span className="metadata-panel__versions-location" title={location}>
                  {location}
                </span>
                {TARGET_EXPLANATIONS[target] ? (
                  <span className="metadata-panel__versions-note">
                    {TARGET_EXPLANATIONS[target]}
                  </span>
                ) : null}
              </>
            );
            return (
              <li key={version.fingerprint}>
                {selectable ? (
                  <button
                    type="button"
                    className="metadata-panel__versions-item metadata-panel__versions-item--button"
                    onClick={() => generationVersions?.onSelect?.(version.instanceId)}
                    title={`Show ${location}`}
                  >
                    {content}
                  </button>
                ) : (
                  <div
                    className={`metadata-panel__versions-item${
                      version.isSelf ? " is-self" : ""
                    }`}
                  >
                    {content}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {truncated ? (
        <p className="metadata-panel__generation-status">
          Showing the first {versions.length} versions.
        </p>
      ) : null}
    </section>
  );
}
