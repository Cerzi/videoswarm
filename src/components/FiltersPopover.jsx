import React, { useId, useMemo, useState, forwardRef } from "react";
import {
  REVIEW_FILTERS,
  normalizeReviewFilter,
} from "../review/reviewState";
import {
  sanitizeFrameRate,
  sanitizeMegapixels,
  sanitizeSteps,
} from "../app/filters/filtersUtils";
import {
  VERSION_FILTERS,
  VERSION_FILTER_LABELS,
  normalizeVersionFilter,
} from "../app/filters/generationVersions";
import "./FiltersPopover.css";
import {
  COMPANION_PHASE_LABELS,
  companionFilterKey,
  normalizeCompanionFilters,
  normalizeCompanionHideSent,
} from "../app/companion/companionFilters";

// Short labels keep each rating on one line beside its label.
const MIN_RATING_OPTIONS = [
  { value: null, label: "Any" },
  ...[1, 2, 3, 4].map((value) => ({ value, label: `${value}★+` })),
  { value: 5, label: "5★" },
];

const EXACT_RATING_OPTIONS = [
  { value: null, label: "Any" },
  ...[1, 2, 3, 4, 5].map((value) => ({ value, label: `${value}★` })),
];

// The tag list has a column to itself, so it shows the most used tags at
// length; searching reaches the rest.
const MAX_DEFAULT_TAGS = 40;

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
  VERSION_FILTERS.SUPERSEDES,
].map((value) => ({ value, label: VERSION_FILTER_LABELS[value] }));

// Frame rate: raw generations run at a low rate, interpolated ones higher.
const FRAME_RATE_MAX_OPTIONS = [
  { value: null, label: "Any" },
  ...[16, 24, 30].map((value) => ({ value, label: `\u2264 ${value} fps` })),
];
const FRAME_RATE_MIN_OPTIONS = [
  { value: null, label: "Any" },
  ...[24, 30, 60].map((value) => ({ value, label: `\u2265 ${value} fps` })),
];

// Steps: few-step (distilled or turbo) runs sit low, full runs well above.
const STEPS_MAX_OPTIONS = [
  { value: null, label: "Any" },
  ...[8, 12].map((value) => ({ value, label: `\u2264 ${value}` })),
];
const STEPS_MIN_OPTIONS = [
  { value: null, label: "Any" },
  ...[12, 20, 30].map((value) => ({ value, label: `\u2265 ${value}` })),
];

// What the workflow filters can see right now.
function describeWorkflowSearch(state) {
  if (state?.pending) return "Matching workflows…";
  if (state?.unread > 0) {
    return `${state.unread.toLocaleString()} clip${
      state.unread === 1 ? "'s workflow has" : "s' workflows have"
    } not been read yet and ${state.unread === 1 ? "is" : "are"} hidden for now.`;
  }
  return null;
}

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
  return DEFAULT_VERSION_STATUS;
}
const DEFAULT_VERSION_STATUS = "Versions are matched across every indexed folder.";

// A labelled row in the filters' side column. What a filter means sits in the
// label's tooltip; only what is happening now (searching, learning) is shown.
function FilterRow({ label, hint = null, status = null, children }) {
  return (
    <section className="filters-row" aria-label={label}>
      <span
        className={`filters-row__label${hint ? " filters-row__label--hint" : ""}`}
        title={hint || undefined}
      >
        {label}
      </span>
      <div className="filters-row__body">
        {children}
        {status ? (
          <span className="filters-empty-hint" role="status">
            {status}
          </span>
        ) : null}
      </div>
    </section>
  );
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
  ...["not-sent", "sent", "under-way", "done", "not-done", "stopped"].map((value) => ({
    value,
    label: COMPANION_PHASE_LABELS[value],
  })),
];

// Clips that might be a tag: its suggestions, not yet tagged or turned down
// (prompt-search-and-tag-suggestions.md, Section 2).
function MightBeControl({ value, status, state, onChange }) {
  const tags = Array.isArray(status?.tags) ? status.tags : null;
  const usable = (tags || []).filter((tag) => tag.usable);
  const untellable = (tags || []).filter((tag) => !tag.usable);
  // A saved view can name a tag that cannot be suggested any more.
  const listed = value && !usable.some((tag) => tag.name.toLowerCase() === value.toLowerCase());
  let hint;
  if (value && state?.pending) hint = "Finding clips…";
  else if (value && state && !state.usable) hint = `"${value}" cannot be suggested yet.`;
  else if (value) hint = `Clips not tagged "${value}" whose prompts suggest it. Right-click to tag them, or to rule them out.`;
  else if (!tags || status?.pending) hint = "Learning from your tags…";
  else if (usable.length === 0) {
    hint =
      "A tag can be suggested once it is on ten clips with different prompts, and other clips carry other tags.";
  } else {
    hint = null;
  }
  return (
    <>
      <div className="filters-tag-search">
        <select
          aria-label="Might be tagged"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={!value && usable.length === 0}
        >
          <option value="">Any clip</option>
          {listed ? <option value={value}>{value}</option> : null}
          {usable.map((tag) => (
            <option key={tag.name} value={tag.name}>
              {tag.name} · right {Math.round((tag.precision || 0) * 100)}%
            </option>
          ))}
        </select>
      </div>
      {hint ? (
        <span className="filters-empty-hint" role="status">
          {hint}
        </span>
      ) : null}
      {!value && untellable.length ? (
        <span className="filters-empty-hint">
          {`Not told by the prompt: ${untellable
            .slice(0, 6)
            .map((tag) => tag.name)
            .join(", ")}${untellable.length > 6 ? ` and ${untellable.length - 6} more` : ""}.`}
        </span>
      ) : null}
    </>
  );
}

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
      // Connected companion apps: `[{ id, name, actions, status }]`.
      companions = [],
      // Prompt search status: `{ pending, unread }` (usePromptSearch).
      promptSearch = null,
      // Which tags can be suggested, `{ tags, pending }`, and the "Might be"
      // filter's state, `{ pending, usable }` (src/app/tags/likelyTags.js).
      likelyTagStatus = null,
      mightBe = null,
      // Workflow filter status: `{ pending, unread }` (useWorkflowSearch).
      workflowSearch = null,
    },
    ref
  ) => {
    const companionFilters = normalizeCompanionFilters(filters?.companionFilters);
    const hideSentIds = normalizeCompanionHideSent(filters?.companionHideSent);
    const includeTags = filters?.includeTags ?? [];
    const excludeTags = filters?.excludeTags ?? [];
    const minRating = filters?.minRating ?? null;
    const exactRating =
      filters?.exactRating === 0 ? 0 : filters?.exactRating ?? null;
    const reviewFilter = normalizeReviewFilter(filters?.reviewFilter);
    const searchScope = librarySearchScope === "library" ? "library" : "folder";
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

    const ratingPills = (options, current, onPick, keyPrefix) =>
      options.map(({ value, label }) => {
        const isActive =
          (value === null && (current === null || current === undefined)) || value === current;
        return (
          <button
            key={`${keyPrefix}-${value ?? "any"}`}
            type="button"
            className={`filters-pill ${isActive ? "filters-pill--active" : ""}`}
            aria-pressed={isActive}
            onClick={() => onPick(value === null || value === current ? null : value)}
          >
            {label}
          </button>
        );
      });

    const pillGroup = (label, options, current, onPick) => (
      <div className="filters-rating-row" role="group" aria-label={label}>
        {options.map(({ value, label: text }) => (
          <button
            key={`${label}-${value ?? "any"}`}
            type="button"
            className={`filters-pill ${current === value ? "filters-pill--active" : ""}`}
            aria-pressed={current === value}
            onClick={() => onPick(value)}
          >
            {text}
          </button>
        ))}
      </div>
    );

    const versionStatus = describeVersionIndexStatus(versionIndexStatus, versionPendingCount);

    return (
      <div
        className="filters-popover"
        ref={ref}
        style={style}
        role="dialog"
        aria-label="Video filters"
      >
        {/* Where the filters apply comes first: it changes what all of them
            mean. */}
        <div className="filters-popover__header">
          <h3>Filters</h3>
          <div className="filters-scope" role="group" aria-label="Search scope">
            {[
              {
                value: "folder",
                label: "This folder",
                hint: "Filter the collection that is currently open.",
              },
              {
                value: "library",
                label: "Entire library",
                hint: "Search every indexed root. Tags, rating, prompt words and Might be narrow the query itself; with none, the whole library.",
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
                  (option.value === "folder" && !canReturnToFolder)
                }
                onClick={() => onSearchScopeChange?.(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {searchScope === "library" ? (
            <div className="filters-library-status">
              <span className="filters-empty-hint" role="status">
                {libraryResultCount === null
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
                disabled={typeof onRefreshLibrary !== "function"}
              >
                Refresh
              </button>
            </div>
          ) : null}
          <div className="filters-popover__header-actions">
            <button type="button" onClick={onReset} className="filters-link">
              Reset
            </button>
            <button type="button" onClick={onClose} className="filters-link">
              Close
            </button>
          </div>
        </div>

        <div className="filters-popover__body">
        <section className="filters-section filters-section--tags" aria-label="Tags">
          <div className="filters-section__heading">
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
          </div>

          <div className="filters-tag-search">
            <input
              type="search"
              value={tagQuery}
              onChange={(event) => setTagQuery(event.target.value)}
              placeholder="Search available tags"
              aria-label="Search available tags"
            />
          </div>

          {includeTags.length || excludeTags.length ? (
            <div className="filters-chip-group__chips filters-chosen-tags">
              {includeTags.map((tag) => renderTagChip(tag, handleRemoveInclude, "include"))}
              {excludeTags.map((tag) => renderTagChip(tag, handleRemoveExclude, "exclude"))}
            </div>
          ) : null}

          <div className="filters-tag-list__header">
            {hasQuery ? "Matching tags" : "Most used"}
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

        <div className="filters-popover__side">
          <FilterRow label="Rating">
            <div className="filters-subrow">
              <span className="filters-subrow__label">At least</span>
              <div className="filters-rating-row" role="group" aria-label="Minimum rating">
                {ratingPills(MIN_RATING_OPTIONS, minRating, handleMinRatingChange, "min")}
              </div>
            </div>
            <div className="filters-subrow">
              <span className="filters-subrow__label">Exactly</span>
              <div className="filters-rating-row" role="group" aria-label="Exact rating">
                {ratingPills(EXACT_RATING_OPTIONS, exactRating, handleExactRatingChange, "exact")}
              </div>
            </div>
          </FilterRow>

          {reviewModeEnabled ? (
            <FilterRow label="Review" hint="Accepted and rejected clips also count as reviewed.">
              {pillGroup("Review state", REVIEW_OPTIONS, reviewFilter, (value) =>
                onChange((prev) => ({ ...prev, reviewFilter: value }))
              )}
            </FilterRow>
          ) : null}

          <FilterRow
            label="Prompt"
            hint={'Words match their starts. In quotes, a word matches only itself and several words match as a phrase, in order. All must appear; -word or -"phrase" rules one out. Negative prompts are ignored.'}
            status={
              promptSearch?.pending
                ? "Searching prompts…"
                : promptSearch?.unread
                  ? `${promptSearch.unread.toLocaleString()} prompts could not be read (WebM, MKV or missing files).`
                  : null
            }
          >
            <div className="filters-tag-search">
              <input
                type="search"
                aria-label="Words in the prompt"
                value={filters?.promptQuery || ""}
                onChange={(event) =>
                  onChange((prev) => ({ ...prev, promptQuery: event.target.value }))
                }
                placeholder={'words, "exact phrase", -not'}
                maxLength={200}
              />
            </div>
          </FilterRow>

          <FilterRow label="Might be" hint="Tags learned from the prompts of clips you have tagged.">
            <MightBeControl
              value={filters?.mightBe || ""}
              status={likelyTagStatus}
              state={mightBe}
              onChange={(tag) => onChange((prev) => ({ ...prev, mightBe: tag }))}
            />
          </FilterRow>

          <FilterRow
            label="Resolution"
            hint="Clips whose dimensions have not been read yet are hidden while a resolution filter is active."
          >
            {pillGroup("Maximum resolution", RESOLUTION_OPTIONS, maxMegapixels, (value) =>
              onChange((prev) => ({ ...prev, maxMegapixels: value }))
            )}
            {pillGroup("Minimum resolution", RESOLUTION_MIN_OPTIONS, minMegapixels, (value) =>
              onChange((prev) => ({ ...prev, minMegapixels: value }))
            )}
          </FilterRow>

          <FilterRow
            label="Frame rate"
            hint="Clips whose timing has not been read yet are hidden while a frame rate filter is active. Rates count to the nearest frame, so 23.976 is 24."
          >
            {pillGroup("Maximum frame rate", FRAME_RATE_MAX_OPTIONS, sanitizeFrameRate(filters?.maxFrameRate), (value) =>
              onChange((prev) => ({ ...prev, maxFrameRate: value }))
            )}
            {pillGroup("Minimum frame rate", FRAME_RATE_MIN_OPTIONS, sanitizeFrameRate(filters?.minFrameRate), (value) =>
              onChange((prev) => ({ ...prev, minFrameRate: value }))
            )}
          </FilterRow>

          <FilterRow
            label="Versions"
            hint="Versions are re-renders, upscales and sweeps of one generation, matched across every indexed folder. Best version with a maximum resolution lists drafts not yet re-rendered."
            status={versionStatus === DEFAULT_VERSION_STATUS ? null : versionStatus}
          >
            <div className="filters-inline">
              {pillGroup("Generation versions", VERSION_OPTIONS, versionFilter, (value) =>
                onChange((prev) => ({ ...prev, versionFilter: value }))
              )}
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
          </FilterRow>

          <FilterRow
            label="Workflow"
            hint="Read from the ComfyUI workflow a clip embeds. Steps is its largest steps setting. Words match inside the names of the nodes it runs and the model, LoRA and other weight files it loads; all words must appear, and none of the words to leave out. Clips without a readable workflow are hidden while these are set."
            status={describeWorkflowSearch(workflowSearch)}
          >
            <div className="filters-subrow">
              <span className="filters-subrow__label">Steps</span>
              {pillGroup("Maximum steps", STEPS_MAX_OPTIONS, sanitizeSteps(filters?.maxSteps), (value) =>
                onChange((prev) => ({ ...prev, maxSteps: value }))
              )}
              {pillGroup("Minimum steps", STEPS_MIN_OPTIONS, sanitizeSteps(filters?.minSteps), (value) =>
                onChange((prev) => ({ ...prev, minSteps: value }))
              )}
            </div>
            <div className="filters-subrow">
              <span className="filters-subrow__label">Uses</span>
              <div className="filters-tag-search">
                <input
                  type="search"
                  aria-label="Words the workflow uses"
                  value={filters?.workflowInclude || ""}
                  onChange={(event) =>
                    onChange((prev) => ({ ...prev, workflowInclude: event.target.value }))
                  }
                  placeholder="node or model name words"
                  maxLength={200}
                />
              </div>
            </div>
            <div className="filters-subrow">
              <span className="filters-subrow__label">Leaves out</span>
              <div className="filters-tag-search">
                <input
                  type="search"
                  aria-label="Words the workflow leaves out"
                  value={filters?.workflowExclude || ""}
                  onChange={(event) =>
                    onChange((prev) => ({ ...prev, workflowExclude: event.target.value }))
                  }
                  placeholder="e.g. a LoRA you want to skip"
                  maxLength={200}
                />
              </div>
            </div>
          </FilterRow>

          {(companions || []).map((companion) => (
            <FilterRow
              key={companion.id}
              label={companion.name || "Companion app"}
              hint="A phase shows only clips this app has answered for; the status line counts those still waiting. Hiding clips already sent keeps clips it has not answered for."
              status={
                companion.status === "offline"
                  ? "Not answering; showing its last answers."
                  : companion.status === "connecting"
                    ? "Connecting…"
                    : null
              }
            >
              {/* One switch per app: what one app was sent says nothing
                  about another's worklist. */}
              <label className="filters-checkbox">
                <input
                  type="checkbox"
                  checked={hideSentIds.includes(companion.id)}
                  onChange={(event) =>
                    onChange((prev) => {
                      const others = normalizeCompanionHideSent(prev.companionHideSent).filter(
                        (id) => id !== companion.id
                      );
                      return {
                        ...prev,
                        companionHideSent: event.target.checked
                          ? normalizeCompanionHideSent([...others, companion.id])
                          : others,
                      };
                    })
                  }
                />
                <span>
                  {companions.length > 1
                    ? `Hide clips already sent to ${companion.name || "this app"}`
                    : "Hide clips already sent"}
                </span>
              </label>
              {(companion.actions || []).map((action) => {
                const key = companionFilterKey(companion.id, action.id);
                const current = companionFilters[key] || "any";
                return (
                  <div key={action.id} className="filters-subrow">
                    <span className="filters-subrow__label" title={action.hint || undefined}>
                      {action.label}
                    </span>
                    {pillGroup(action.label, COMPANION_FILTER_OPTIONS, current, (value) =>
                      onChange((prev) => {
                        const next = { ...normalizeCompanionFilters(prev.companionFilters) };
                        if (value === "any") delete next[key];
                        else next[key] = value;
                        return { ...prev, companionFilters: next };
                      })
                    )}
                  </div>
                );
              })}
            </FilterRow>
          ))}
        </div>
        </div>
      </div>
    );
  }
);

FiltersPopover.displayName = "FiltersPopover";

export default FiltersPopover;
