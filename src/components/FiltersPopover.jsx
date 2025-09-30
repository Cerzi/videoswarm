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

const MAX_DEFAULT_TAGS = 10;

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
      const deduped = new Map();

      source.forEach((entry) => {
        if (entry == null) return;
        let name = "";
        let usageCount = 0;

        if (typeof entry === "string") {
          name = entry.trim();
        } else if (typeof entry === "object") {
          name = (entry.name ?? "").toString().trim();
          if (Number.isFinite(entry.usageCount)) {
            usageCount = Number(entry.usageCount);
          }
        } else {
          name = entry.toString().trim();
        }

        if (!name) return;
        const existing = deduped.get(name);
        if (!existing || existing.usageCount < usageCount) {
          deduped.set(name, { name, usageCount });
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
                      {typeof tag.usageCount === "number" && tag.usageCount > 0 && (
                        <span className="filters-tag-option__count">
                          {tag.usageCount}
                        </span>
                      )}
                    </div>
                    <div className="filters-tag-option__actions">
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
