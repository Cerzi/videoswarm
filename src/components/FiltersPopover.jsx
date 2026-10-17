import React, { useId, useMemo, useState, forwardRef } from "react";
import {
  REVIEW_FILTERS,
  normalizeReviewFilter,
} from "../review/reviewState";
import { sanitizeMegapixels } from "../app/filters/filtersUtils";
import {
  VERSION_FILTERS,
  VERSION_FILTER_LABELS,
  normalizeVersionFilter,
} from "../app/filters/generationVersions";
import "./FiltersPopover.css";
import {
  COMPANION_PHASE_LABELS,
  normalizeCompanionFilters,
} from "../app/companion/companionFilters";
import { hasLibrarySearchCriteria, librarySearchCriteria } from "../app/librarySearch";

const MIN_RATING_OPTIONS = [
  { value: null, label: "Any" },
  { value: 1, label: "★☆☆☆☆+" },
  { value: 2, label: "★★☆☆☆+" },
  { value: 3, label: "★★★☆☆+" },
  { value: 4, label: "★★★★☆+" },
  { value: 5, label: "★★★★★" },
];

const EXACT_RATING_OPTIONS = [
  { value: null, label: "Any" },
  { value: 1, label: "★☆☆☆☆" },
  { value: 2, label: "★★☆☆☆" },
  { value: 3, label: "★★★☆☆" },
  { value: 4, label: "★★★★☆" },
  { value: 5, label: "★★★★★" },
];

const MAX_DEFAULT_TAGS = 10;

// Draft generations cluster well below a megapixel, finished ones above, so a
// short threshold list answers "which of these came out small" directly.
const RESOLUTION_OPTIONS = [
  { value: null, label: "Any" },
  { value: 0.5, label: "\u2264 0.5 MP" },
  { value: 1, label: "\u2264 1 MP" },
  { value: 2, label: "\u2264 2 MP" },
];
const RESOLUTION_MIN_OPTIONS = [
  { value: null, label: "Any" },
  { value: 1, label: "\u2265 1 MP" },
  { value: 2, label: "\u2265 2 MP" },
  { value: 4, label: "\u2265 4 MP" },
];

const VERSION_OPTIONS = [
  VERSION_FILTERS.ANY,
  VERSION_FILTERS.SUPERSEDED,
  VERSION_FILTERS.BEST,
].map((value) => ({ value, label: VERSION_FILTER_LABELS[value] }));

// One line saying what the version filters can currently see, because while
// keys are still being read the answer is provisional.
function describeVersionIndexStatus(status, pendingCount) {
  if (status?.running && status.scope === "library") {
    return `Finding versions across the library… ${Number(
      status.processed || 0
    ).toLocaleString()} of ${Number(status.total || 0).toLocaleString()}`;
  }
  if (pendingCount > 0) {
    return `Finding versions… ${pendingCount.toLocaleString()} clip${
      pendingCount === 1 ? "" : "s"
    } left. Results are provisional until then.`;
  }
  if (status?.failed) return "Versions could not be read for this collection.";
  return "Versions are matched across every indexed folder.";
}

const REVIEW_OPTIONS = [
  { value: REVIEW_FILTERS.ANY, label: "Any" },
  { value: REVIEW_FILTERS.UNREVIEWED, label: "Unreviewed" },
  { value: REVIEW_FILTERS.REVIEWED, label: "Reviewed" },
  { value: REVIEW_FILTERS.PICK, label: "Accept" },
  { value: REVIEW_FILTERS.REJECT, label: "Reject" },
];

function renderTagChip(tag, onRemove, variant) {
  return (
    <button
      key={`${variant}-${tag}`}
      type="button"
      className={`filters-chip filters-chip--${variant}`}
      onClick={() => onRemove(tag)}
      title={`Remove ${variant} tag`}
    >
      #{tag}
      <span className="filters-chip__remove">×</span>
    </button>
  );
}

// Phases a companion action can be filtered by (src/app/companion/companionFilters.js).
const COMPANION_FILTER_OPTIONS = [
  { value: "any", label: "Any" },
  ...["not-sent", "sent", "under-way", "done", "stopped"].map((value) => ({
    value,
    label: COMPANION_PHASE_LABELS[value],
  })),
];

const FiltersPopover = forwardRef(
  (
    {
      filters,
      availableTags = [],
      onChange,
      onReset,
      onClose,
      style,
      reviewModeEnabled = true,
      librarySearchScope = "folder",
      onSearchScopeChange,
      onRefreshLibrary,
      canReturnToFolder = true,
      libraryResultCount = null,
      libraryTruncated = false,
      versionIndexStatus = null,
      versionPendingCount = 0,
      onFindVersionsInLibrary,
      onSetTagParent,
      // A connected companion app: `{ name, actions, status }`, or null.
      companion = null,
      // Prompt search status: `{ pending, unread }` (usePromptSearch).
      promptSearch = null,
    },
    ref
  ) => {
    const companionFilters = normalizeCompanionFilters(filters?.companionFilters);
    const includeTags = filters?.includeTags ?? [];
    const excludeTags = filters?.excludeTags ?? [];
    const minRating = filters?.minRating ?? null;
    const exactRating =
      filters?.exactRating === 0 ? 0 : filters?.exactRating ?? null;
    const reviewFilter = normalizeReviewFilter(filters?.reviewFilter);
    const searchScope = librarySearchScope === "library" ? "library" : "folder";
    // Tags, a rating, or both define a library search.
    const canSearchLibrary = hasLibrarySearchCriteria(librarySearchCriteria(filters || {}));
    const includeTagsMode = filters?.includeTagsMode === "any" ? "any" : "all";
    const maxMegapixels = sanitizeMegapixels(filters?.maxMegapixels);
    const minMegapixels = sanitizeMegapixels(filters?.minMegapixels);
    const versionFilter = normalizeVersionFilter(filters?.versionFilter);
    const libraryVersionSearchRunning =
      versionIndexStatus?.running === true && versionIndexStatus.scope === "library";

    const [tagQuery, setTagQuery] = useState("");
    // The tag whose parent is being edited, with the draft and any refusal.
    const [parentEdit, setParentEdit] = useState(null);
    const tagNames = useMemo(
      () =>
        (Array.isArray(availableTags) ? availableTags : [])
          .map((entry) => (typeof entry === "string" ? entry : entry?.name))
          .filter(Boolean),
      [availableTags]
    );
    const parentListId = useId();

    const startParentEdit = (tag) =>
      setParentEdit({ tag: tag.name, draft: tag.parent || "", error: null, saving: false });
    const saveParent = async (parentName) => {
      if (!parentEdit || !onSetTagParent) return;
      const tag = parentEdit.tag;
      setParentEdit((edit) => edit && { ...edit, saving: true, error: null });
      const result = await onSetTagParent(tag, parentName?.trim() || null);
      setParentEdit((edit) =>
        edit?.tag !== tag
          ? edit
          : result?.success
            ? null
            : { ...edit, saving: false, error: result?.error || "Could not move the tag" }
      );
    };

    const normalizedTags = useMemo(() => {
      const source = Array.isArray(availableTags) ? availableTags : [];
      const deduped = new Map();

      source.forEach((entry) => {
        if (entry == null) return;
        let name = "";
        let usageCount = 0;
        let parent = null;

        if (typeof entry === "string") {
          name = entry.trim();
        } else if (typeof entry === "object") {
          name = (entry.name ?? "").toString().trim();
          if (Number.isFinite(entry.usageCount)) {
            usageCount = Number(entry.usageCount);
          }
          parent = entry.parent ? String(entry.parent).trim() || null : null;
        } else {
          name = entry.toString().trim();
        }

        if (!name) return;
        const existing = deduped.get(name);
        if (!existing || existing.usageCount < usageCount) {
          deduped.set(name, { name, usageCount, parent });
        }
      });

      let list = Array.from(deduped.values());
      const query = tagQuery.trim().toLowerCase();

      if (query) {
        list = list
          .filter((item) => item.name.toLowerCase().includes(query))
          .sort((a, b) => {
            const usageDiff = (b.usageCount || 0) - (a.usageCount || 0);
            if (usageDiff !== 0) return usageDiff;
            return a.name.localeCompare(b.name);
          });
        return list;
      }

      list.sort((a, b) => {
        const usageDiff = (b.usageCount || 0) - (a.usageCount || 0);
        if (usageDiff !== 0) return usageDiff;
        return a.name.localeCompare(b.name);
      });

      return list.slice(0, MAX_DEFAULT_TAGS);
    }, [availableTags, tagQuery]);

    const includeSet = useMemo(() => new Set(includeTags), [includeTags]);
    const excludeSet = useMemo(() => new Set(excludeTags), [excludeTags]);

    const hasQuery = tagQuery.trim().length > 0;

    const cycleInclude = (tag) => {
      if (!tag) return;
      onChange((prev) => {
        const nextInclude = new Set(prev.includeTags ?? []);
        const nextExclude = new Set(prev.excludeTags ?? []);
        if (nextInclude.has(tag)) {
          nextInclude.delete(tag);
        } else {
          nextInclude.add(tag);
          nextExclude.delete(tag);
        }
        return {
          ...prev,
          includeTags: Array.from(nextInclude),
          excludeTags: Array.from(nextExclude),
        };
      });
    };

    const cycleExclude = (tag) => {
      if (!tag) return;
      onChange((prev) => {
        const nextInclude = new Set(prev.includeTags ?? []);
        const nextExclude = new Set(prev.excludeTags ?? []);
        if (nextExclude.has(tag)) {
          nextExclude.delete(tag);
        } else {
          nextExclude.add(tag);
          nextInclude.delete(tag);
        }
        return {
          ...prev,
          includeTags: Array.from(nextInclude),
          excludeTags: Array.from(nextExclude),
        };
      });
    };

    const handleRemoveInclude = (tag) => {
      cycleInclude(tag);
    };

    const handleRemoveExclude = (tag) => {
      cycleExclude(tag);
    };

    const handleMinRatingChange = (value) => {
      onChange((prev) => {
        const nextValue =
          value === null || value === prev.minRating ? null : value;
        return {
          ...prev,
          minRating: nextValue,
          exactRating: nextValue !== null ? null : prev.exactRating ?? null,
        };
      });
    };

    const handleExactRatingChange = (value) => {
      onChange((prev) => {
        const nextValue =
          value === null || value === prev.exactRating ? null : value;
        return {
          ...prev,
          exactRating: nextValue,
          minRating: nextValue !== null ? null : prev.minRating ?? null,
        };
      });
    };

    return (
      <div
        className="filters-popover"
        ref={ref}
        style={style}
        role="dialog"
        aria-label="Video filters"
      >
        <div className="filters-popover__header">
          <div>
            <h3>Filters</h3>
            <p>Refine the grid without leaving the gallery.</p>
          </div>
          <div className="filters-popover__header-actions">
            <button type="button" onClick={onReset} className="filters-link">
              Reset
            </button>
            <button type="button" onClick={onClose} className="filters-link">
              Close
            </button>
          </div>
        </div>

        <section className="filters-section">
          <header className="filters-section__title">Tags</header>
          {/* Two words rather than a query language. Combined with Exclude,
              which always means "none of these", this covers the ordinary
              questions without nesting conditions or parsing an expression. */}
          <div
            className="filters-tag-mode"
            role="group"
            aria-label="Match included tags"
          >
            <span className="filters-chip-group__label">Match</span>
            {[
              { value: "all", label: "All", hint: "Clips carrying every included tag." },
              { value: "any", label: "Any", hint: "Clips carrying at least one included tag." },
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                className={`filters-pill ${
                  includeTagsMode === option.value ? "filters-pill--active" : ""
                }`}
                aria-pressed={includeTagsMode === option.value}
                title={option.hint}
                onClick={() =>
                  onChange((prev) => ({ ...prev, includeTagsMode: option.value }))
                }
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="filters-chip-group">
            <span className="filters-chip-group__label">Include</span>
            <div className="filters-chip-group__chips">
              {includeTags.length === 0 ? (
                <span className="filters-chip--empty">None</span>
              ) : (
                includeTags.map((tag) =>
                  renderTagChip(tag, handleRemoveInclude, "include")
                )
              )}
            </div>
          </div>

          <div className="filters-chip-group">
            <span className="filters-chip-group__label">Exclude</span>
            <div className="filters-chip-group__chips">
              {excludeTags.length === 0 ? (
                <span className="filters-chip--empty">None</span>
              ) : (
                excludeTags.map((tag) =>
                  renderTagChip(tag, handleRemoveExclude, "exclude")
                )
              )}
            </div>
          </div>

          <div className="filters-tag-search">
            <input
              type="search"
              value={tagQuery}
              onChange={(event) => setTagQuery(event.target.value)}
              placeholder="Search available tags"
            />
          </div>

          <div className="filters-tag-list__header">
            {hasQuery ? "Matching tags" : `Popular tags (top ${MAX_DEFAULT_TAGS})`}
          </div>

          <datalist id={parentListId}>
            {tagNames
              .filter((name) => name !== parentEdit?.tag)
              .map((name) => (
                <option key={name} value={name} />
              ))}
          </datalist>

          <div className="filters-tag-list" role="list">
            {normalizedTags.length === 0 ? (
              <span className="filters-empty-hint">No tags found.</span>
            ) : (
              normalizedTags.map((tag) => {
                const tagName = tag.name;
                const status = includeSet.has(tagName)
                  ? "include"
                  : excludeSet.has(tagName)
                  ? "exclude"
                  : "none";
                return (
                  <div
                    key={tagName}
                    className={`filters-tag-option filters-tag-option--${status}`}
                    role="listitem"
                  >
                    <div className="filters-tag-option__info">
                      <span className="filters-tag-option__name">#{tagName}</span>
                      {tag.parent ? (
                        <span className="filters-tag-option__parent">in {tag.parent}</span>
                      ) : null}
                      {typeof tag.usageCount === "number" && tag.usageCount > 0 && (
                        <span
                          className="filters-tag-option__count"
                          title="Clips with this tag or a tag under it"
                        >
                          {tag.usageCount}
                        </span>
                      )}
                    </div>
                    <div className="filters-tag-option__actions">
                      {onSetTagParent ? (
                        <button
                          type="button"
                          className={`filters-pill ${
                            parentEdit?.tag === tagName ? "filters-pill--active" : ""
                          }`}
                          aria-expanded={parentEdit?.tag === tagName}
                          title={`Put #${tagName} under another tag`}
                          onClick={() =>
                            parentEdit?.tag === tagName
                              ? setParentEdit(null)
                              : startParentEdit(tag)
                          }
                        >
                          Parent
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className={`filters-pill ${
                          status === "include" ? "filters-pill--active" : ""
                        }`}
                        onClick={() => cycleInclude(tagName)}
                      >
                        Include
                      </button>
                      <button
                        type="button"
                        className={`filters-pill ${
                          status === "exclude" ? "filters-pill--active" : ""
                        }`}
                        onClick={() => cycleExclude(tagName)}
                      >
                        Exclude
                      </button>
                    </div>
                    {parentEdit?.tag === tagName ? (
                      <form
                        className="filters-tag-parent"
                        onSubmit={(event) => {
                          event.preventDefault();
                          saveParent(parentEdit.draft);
                        }}
                      >
                        <label className="filters-tag-parent__label">
                          <span>Put #{tagName} under</span>
                          <input
                            type="text"
                            list={parentListId}
                            value={parentEdit.draft}
                            placeholder="parent tag"
                            autoFocus
                            disabled={parentEdit.saving}
                            onChange={(event) =>
                              setParentEdit((edit) =>
                                edit && { ...edit, draft: event.target.value, error: null }
                              )
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.stopPropagation();
                                setParentEdit(null);
                              }
                            }}
                          />
                        </label>
                        <div className="filters-tag-parent__actions">
                          <button
                            type="submit"
                            className="filters-pill filters-pill--active"
                            disabled={parentEdit.saving || !parentEdit.draft.trim()}
                          >
                            Save
                          </button>
                          {tag.parent ? (
                            <button
                              type="button"
                              className="filters-pill"
                              disabled={parentEdit.saving}
                              onClick={() => saveParent(null)}
                            >
                              Top level
                            </button>
                          ) : null}
                        </div>
                        {parentEdit.error ? (
                          <span className="filters-tag-parent__error" role="alert">
                            {parentEdit.error}
                          </span>
                        ) : null}
                      </form>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className="filters-section">
          <header className="filters-section__title">Ratings</header>
          <div className="filters-rating-group">
            <span className="filters-chip-group__label">Minimum</span>
            <div className="filters-rating-row">
              {MIN_RATING_OPTIONS.map(({ value, label }) => {
                const isActive =
                  (value === null && (minRating === null || minRating === undefined)) ||
                  value === minRating;
                return (
                  <button
                    key={`min-${value ?? "any"}`}
                    type="button"
                    className={`filters-pill ${
                      isActive ? "filters-pill--active" : ""
                    }`}
                    onClick={() =>
                      handleMinRatingChange(
                        value === null || value === minRating ? null : value
                      )
                    }
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="filters-rating-group">
            <span className="filters-chip-group__label">Exact</span>
            <div className="filters-rating-row">
              {EXACT_RATING_OPTIONS.map(({ value, label }) => {
                const isActive =
                  (value === null &&
                    (exactRating === null || exactRating === undefined)) ||
                  value === exactRating;
                return (
                  <button
                    key={`exact-${value ?? "any"}`}
                    type="button"
                    className={`filters-pill ${
                      isActive ? "filters-pill--active" : ""
                    }`}
                    onClick={() =>
                      handleExactRatingChange(
                        value === null || value === exactRating ? null : value
                      )
                    }
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        <section className="filters-section">
          <header className="filters-section__title">Prompt</header>
          <div className="filters-tag-search">
            <input
              type="search"
              aria-label="Words in the prompt"
              value={filters?.promptQuery || ""}
              onChange={(event) =>
                onChange((prev) => ({ ...prev, promptQuery: event.target.value }))
              }
              placeholder="Words in the prompt"
              maxLength={200}
            />
          </div>
          <span className="filters-empty-hint" role="status">
            {promptSearch?.pending
              ? "Searching prompts…"
              : promptSearch?.unread
                ? `${promptSearch.unread.toLocaleString()} prompts could not be read (WebM, MKV or missing files).`
                : "Matches the start of words; every word must appear, -word rules one out. Negative prompts are ignored."}
          </span>
        </section>

        <section className="filters-section">
          <header className="filters-section__title">Search</header>
          <div className="filters-rating-row" role="group" aria-label="Search scope">
            {[
              {
                value: "folder",
                label: "This folder",
                hint: "Filter the collection that is currently open.",
              },
              {
                value: "library",
                label: "Entire library",
                hint: canSearchLibrary
                  ? "Search every indexed root. The tags and rating narrow the query itself."
                  : "Include a tag or a rating to search every root.",
              },
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                className={`filters-pill ${
                  searchScope === option.value ? "filters-pill--active" : ""
                }`}
                aria-pressed={searchScope === option.value}
                title={option.hint}
                disabled={
                  typeof onSearchScopeChange !== "function" ||
                  (option.value === "folder" && !canReturnToFolder) ||
                  // A library search is defined by its tags and rating. Offering
                  // it with neither offers to read the whole library into the
                  // grid, which is a bound to hit rather than a thing to want.
                  (option.value === "library" &&
                    searchScope !== "library" &&
                    !canSearchLibrary)
                }
                onClick={() => onSearchScopeChange?.(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {searchScope === "library" ? (
            <div className="filters-library-status">
              <span className="filters-empty-hint">
                {!canSearchLibrary
                  ? "Include a tag or a rating to search every root."
                  : libraryResultCount === null
                    ? "Searching the library…"
                    : `${libraryResultCount.toLocaleString()} clip${
                        libraryResultCount === 1 ? "" : "s"
                      } from every root${
                        libraryTruncated ? " (partial)" : ""
                      } · a snapshot, not live`}
              </span>
              <button
                type="button"
                className="filters-pill"
                onClick={() => onRefreshLibrary?.()}
                disabled={
                  !canSearchLibrary || typeof onRefreshLibrary !== "function"
                }
              >
                Refresh
              </button>
            </div>
          ) : !canSearchLibrary ? (
            // A disabled control that does not say why is a dead end, and the
            // reason is one line.
            <span className="filters-empty-hint">
              Include a tag or a rating to search every root.
            </span>
          ) : null}
        </section>

        <section className="filters-section">
          <header className="filters-section__title">Resolution</header>
          <div className="filters-rating-row" role="group" aria-label="Maximum resolution">
            {RESOLUTION_OPTIONS.map(({ value, label }) => (
              <button
                key={`max-${label}`}
                type="button"
                className={`filters-pill ${
                  maxMegapixels === value ? "filters-pill--active" : ""
                }`}
                aria-pressed={maxMegapixels === value}
                onClick={() =>
                  onChange((prev) => ({ ...prev, maxMegapixels: value }))
                }
              >
                {label}
              </button>
            ))}
          </div>
          <div className="filters-rating-row" role="group" aria-label="Minimum resolution">
            {RESOLUTION_MIN_OPTIONS.map(({ value, label }) => (
              <button
                key={`min-${label}`}
                type="button"
                className={`filters-pill ${
                  minMegapixels === value ? "filters-pill--active" : ""
                }`}
                aria-pressed={minMegapixels === value}
                onClick={() =>
                  onChange((prev) => ({ ...prev, minMegapixels: value }))
                }
              >
                {label}
              </button>
            ))}
          </div>
          <span className="filters-empty-hint">
            Clips whose dimensions have not been read yet are hidden while a
            resolution filter is active.
          </span>
        </section>

        <section className="filters-section">
          <header className="filters-section__title">Versions</header>
          <div className="filters-rating-row" role="group" aria-label="Generation versions">
            {VERSION_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className={`filters-pill ${
                  versionFilter === value ? "filters-pill--active" : ""
                }`}
                aria-pressed={versionFilter === value}
                onClick={() =>
                  onChange((prev) => ({ ...prev, versionFilter: value }))
                }
              >
                {label}
              </button>
            ))}
          </div>
          <span className="filters-empty-hint">
            Versions are re-renders, upscales and sweeps of one generation.
            Best version with a maximum resolution lists drafts not yet
            re-rendered.
          </span>
          <div className="filters-library-status">
            <span className="filters-empty-hint" role="status">
              {describeVersionIndexStatus(versionIndexStatus, versionPendingCount)}
            </span>
            {typeof onFindVersionsInLibrary === "function" ? (
              <button
                type="button"
                className="filters-pill"
                onClick={() => onFindVersionsInLibrary()}
                disabled={libraryVersionSearchRunning}
                title="Read generation keys for every indexed clip, including folders that are not open"
              >
                Search library
              </button>
            ) : null}
          </div>
        </section>

        {companion ? (
          <section className="filters-section">
            <header className="filters-section__title">{companion.name || "Companion app"}</header>
            <label className="filters-checkbox">
              <input
                type="checkbox"
                checked={filters?.companionHideSent === true}
                onChange={(event) =>
                  onChange((prev) => ({ ...prev, companionHideSent: event.target.checked }))
                }
              />
              <span>Hide clips already sent</span>
            </label>
            {(companion.actions || []).map((action) => {
              const current = companionFilters[action.id] || "any";
              return (
                <div key={action.id} className="filters-companion-action">
                  <span className="filters-companion-action__label" title={action.hint || undefined}>
                    {action.label}
                  </span>
                  <div className="filters-rating-row" role="group" aria-label={action.label}>
                    {COMPANION_FILTER_OPTIONS.map(({ value, label }) => (
                      <button
                        key={value}
                        type="button"
                        className={`filters-pill ${current === value ? "filters-pill--active" : ""}`}
                        aria-pressed={current === value}
                        onClick={() =>
                          onChange((prev) => {
                            const next = { ...normalizeCompanionFilters(prev.companionFilters) };
                            if (value === "any") delete next[action.id];
                            else next[action.id] = value;
                            return { ...prev, companionFilters: next };
                          })
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            <span className="filters-empty-hint" role="status">
              {companion.status === "offline"
                ? "Not answering; showing its last answers."
                : companion.status === "connecting"
                  ? "Connecting…"
                  : "Clips it has not answered for yet are always shown."}
            </span>
          </section>
        ) : null}

        {reviewModeEnabled ? (
        <section className="filters-section">
          <header className="filters-section__title">Review state</header>
          <div className="filters-rating-row" role="group" aria-label="Review state">
            {REVIEW_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className={`filters-pill ${
                  reviewFilter === value ? "filters-pill--active" : ""
                }`}
                aria-pressed={reviewFilter === value}
                onClick={() =>
                  onChange((prev) => ({ ...prev, reviewFilter: value }))
                }
              >
                {label}
              </button>
            ))}
          </div>
          <span className="filters-empty-hint">
            Accepted and rejected clips also count as reviewed.
          </span>
        </section>
        ) : null}
      </div>
    );
  }
);

FiltersPopover.displayName = "FiltersPopover";

export default FiltersPopover;
