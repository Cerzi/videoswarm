import React, { useMemo, useState, forwardRef } from "react";
import "./FiltersPopover.css";

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

const FiltersPopover = forwardRef(
  (
    {
      filters,
      availableTags = [],
      onChange,
      onReset,
      onClose,
      style,
    },
    ref
  ) => {
    const includeTags = filters?.includeTags ?? [];
    const excludeTags = filters?.excludeTags ?? [];
    const minRating = filters?.minRating ?? null;
    const exactRating =
      filters?.exactRating === 0 ? 0 : filters?.exactRating ?? null;

    const [tagQuery, setTagQuery] = useState("");

    const normalizedTags = useMemo(() => {
      const source = Array.isArray(availableTags) ? availableTags : [];
      const deduped = Array.from(
        new Set(
          source
            .map((tag) => (tag ?? "").toString().trim())
            .filter(Boolean)
        )
      );
      deduped.sort((a, b) => a.localeCompare(b));
      if (!tagQuery.trim()) return deduped;
      const query = tagQuery.trim().toLowerCase();
      return deduped.filter((tag) => tag.toLowerCase().includes(query));
    }, [availableTags, tagQuery]);

    const includeSet = useMemo(() => new Set(includeTags), [includeTags]);
    const excludeSet = useMemo(() => new Set(excludeTags), [excludeTags]);

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
      onChange((prev) => ({
        ...prev,
        minRating: value,
      }));
    };

    const handleExactRatingChange = (value) => {
      onChange((prev) => ({
        ...prev,
        exactRating: value,
      }));
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

          <div className="filters-tag-list" role="list">
            {normalizedTags.length === 0 ? (
              <span className="filters-empty-hint">No tags found.</span>
            ) : (
              normalizedTags.map((tag) => {
                const status = includeSet.has(tag)
                  ? "include"
                  : excludeSet.has(tag)
                  ? "exclude"
                  : "none";
                return (
                  <div
                    key={tag}
                    className={`filters-tag-option filters-tag-option--${status}`}
                    role="listitem"
                  >
                    <span className="filters-tag-option__name">#{tag}</span>
                    <div className="filters-tag-option__actions">
                      <button
                        type="button"
                        className={`filters-pill ${
                          status === "include" ? "filters-pill--active" : ""
                        }`}
                        onClick={() => cycleInclude(tag)}
                      >
                        Include
                      </button>
                      <button
                        type="button"
                        className={`filters-pill ${
                          status === "exclude" ? "filters-pill--active" : ""
                        }`}
                        onClick={() => cycleExclude(tag)}
                      >
                        Exclude
                      </button>
                    </div>
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
      </div>
    );
  }
);

FiltersPopover.displayName = "FiltersPopover";

export default FiltersPopover;
