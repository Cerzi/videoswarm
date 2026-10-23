import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import SmartViewsContext from "./SmartViewsContext";

// The smart views one clip is part of, checked in main with the grid's own
// filter test against the whole definition (a folder view counts wherever it
// is applied). Read lazily, and again whenever the clip's rating, review
// state or tags change, or a view is saved, changed or deleted.

export const SMART_VIEWS_DEBOUNCE_MS = 200;

const IGNORED_LABELS = {
  companionFilters: "companion filters",
  companionHideSent: "companion sends",
  companionTags: "companion tags",
  mightBe: "Might be",
};

const getApi = () =>
  typeof window === "undefined" ? null : window.electronAPI?.library || null;

const clipSignature = (video) =>
  [
    video?.instanceId ?? "",
    video?.rating ?? "",
    video?.reviewState ?? "",
    Array.isArray(video?.tags) ? video.tags.join("\u0001") : "",
  ].join("\u0000");

const viewsSignature = (views) =>
  (Array.isArray(views) ? views : []).map((view) => `${view.id}:${view.updatedAt ?? ""}`).join(",");

export default function MetadataSmartViewsSection({ video, active = true }) {
  const smartViews = useContext(SmartViewsContext);
  const savedViews = smartViews?.savedViews || [];
  const enabled = Boolean(active && video?.instanceId && savedViews.length);
  const signature = `${clipSignature(video)}\u0000${viewsSignature(savedViews)}`;
  const [state, setState] = useState({ loading: false, views: [], unknown: [], error: null });
  const requestRef = useRef(0);

  useEffect(() => {
    const api = getApi();
    const requestId = ++requestRef.current;
    if (!enabled || typeof api?.viewsForClip !== "function") {
      setState({ loading: false, views: [], unknown: [], error: null });
      return undefined;
    }
    setState((previous) => ({ ...previous, loading: true, error: null }));
    const timer = setTimeout(async () => {
      let result = null;
      try {
        result = await api.viewsForClip(video.instanceId);
      } catch {
        result = { success: false };
      }
      if (requestRef.current !== requestId) return;
      if (!result || result.success === false) {
        setState({ loading: false, views: [], unknown: [], error: "Smart views could not be checked." });
        return;
      }
      setState({
        loading: false,
        views: Array.isArray(result.views) ? result.views : [],
        unknown: Array.isArray(result.unknown) ? result.unknown : [],
        error: null,
      });
    }, SMART_VIEWS_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // The signature stands in for the clip and the views.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, signature]);

  const byId = useMemo(() => new Map(savedViews.map((view) => [view.id, view])), [savedViews]);
  if (!enabled) return null;
  const { loading, views, unknown, error } = state;
  const apply = (entry) => {
    const view = byId.get(entry.id);
    if (view) smartViews?.onApply?.(view);
  };

  return (
    <section className="metadata-panel__section metadata-panel__smart-views">
      <div className="metadata-panel__section-header">
        <span title="Smart views whose filters this clip passes. Click one to apply it.">Smart views</span>
        <span className="metadata-panel__badge">{views.length}</span>
      </div>
      {error ? (
        <p className="metadata-panel__generation-status metadata-panel__generation-status--error">{error}</p>
      ) : loading && views.length === 0 && unknown.length === 0 ? (
        <p className="metadata-panel__generation-status">Checking smart views…</p>
      ) : views.length === 0 && unknown.length === 0 ? (
        <p className="metadata-panel__generation-status">
          In none of your {savedViews.length.toLocaleString()} smart view{savedViews.length === 1 ? "" : "s"}.
        </p>
      ) : (
        <ul className="metadata-panel__smart-views-list">
          {views.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className="metadata-panel__smart-view"
                onClick={() => apply(entry)}
                title={`Apply “${entry.name}”`}
              >
                <span className="metadata-panel__smart-view-name">{entry.name}</span>
                {entry.searchScope === "library" ? (
                  <span className="metadata-panel__badge">Library</span>
                ) : null}
              </button>
              {entry.ignored?.length ? (
                <span className="metadata-panel__smart-view-note">
                  Also filters on {entry.ignored.map((part) => IGNORED_LABELS[part] || part).join(", ")},
                  not checked here
                </span>
              ) : null}
            </li>
          ))}
          {unknown.map((entry) => (
            <li key={`unknown-${entry.id}`} className="is-unknown">
              <span className="metadata-panel__smart-view metadata-panel__smart-view--unknown">
                <span className="metadata-panel__smart-view-name">{entry.name}</span>
              </span>
              <span className="metadata-panel__smart-view-note">
                Can't tell yet: its prompt or workflow has not been read
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
