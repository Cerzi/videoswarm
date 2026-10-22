import React, { useMemo, useState } from "react";

const MAX_SUGGESTIONS = 8;
const MAX_TAGS = 20;

/**
 * Every tag a companion has answered with this session, each once whatever
 * its case, sorted: what the type-ahead offers. Kept in memory only.
 */
export function knownCompanionTags(entries) {
  const byKey = new Map();
  for (const entry of entries?.values?.() || []) {
    for (const tag of entry?.tags || []) {
      const key = tag.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, tag);
    }
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Filters by a companion's own tags for a clip (its declared label, such as
 * "Characters"): type-ahead over the tags it has answered with, the chosen
 * tags as removable chips, and any or all of them.
 * `value` is `{ tags, mode }` or null; `onChange(next | null)`.
 */
export default function CompanionTagFilter({ label, hint = "", known = [], value = null, onChange }) {
  const [text, setText] = useState("");
  const chosen = value?.tags || [];
  const mode = value?.mode === "all" ? "all" : "any";
  const chosenKeys = useMemo(() => new Set(chosen.map((tag) => tag.toLowerCase())), [chosen]);
  const suggestions = useMemo(() => {
    const words = text.trim().toLowerCase();
    if (!words) return [];
    const starts = [];
    const contains = [];
    for (const tag of known) {
      const key = tag.toLowerCase();
      if (chosenKeys.has(key)) continue;
      if (key.startsWith(words)) starts.push(tag);
      else if (key.includes(words)) contains.push(tag);
    }
    return [...starts, ...contains].slice(0, MAX_SUGGESTIONS);
  }, [chosenKeys, known, text]);

  const set = (tags, nextMode = mode) => onChange?.(tags.length ? { tags, mode: nextMode } : null);
  const add = (tag) => {
    const clean = tag.trim();
    if (!clean || chosenKeys.has(clean.toLowerCase()) || chosen.length >= MAX_TAGS) return;
    set([...chosen, clean]);
    setText("");
  };

  return (
    <div className="filters-subrow companion-tag-filter">
      <span className="filters-subrow__label" title={hint || undefined}>
        {label}
      </span>
      <div className="companion-tag-filter__body">
        {chosen.length ? (
          <div className="companion-tag-filter__chosen">
            {chosen.map((tag) => (
              <button
                key={tag}
                type="button"
                className="filters-pill filters-pill--active"
                onClick={() => set(chosen.filter((entry) => entry !== tag))}
                title={`Stop filtering by ${tag}`}
              >
                {tag} ×
              </button>
            ))}
            {chosen.length > 1 ? (
              <span className="filters-rating-row" role="group" aria-label={`Match ${label}`}>
                {["any", "all"].map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={`filters-pill ${mode === option ? "filters-pill--active" : ""}`}
                    aria-pressed={mode === option}
                    onClick={() => set(chosen, option)}
                  >
                    {option === "any" ? "Any" : "All"}
                  </button>
                ))}
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="filters-tag-search">
          <input
            type="search"
            aria-label={`Filter by ${label}`}
            value={text}
            placeholder={known.length ? `${known.length.toLocaleString()} known` : "type a name"}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              add(suggestions[0] || text);
            }}
            maxLength={64}
          />
        </div>
        {suggestions.length ? (
          <div className="companion-tag-filter__suggestions" role="listbox" aria-label={`${label} suggestions`}>
            {suggestions.map((tag) => (
              <button
                key={tag}
                type="button"
                role="option"
                aria-selected="false"
                className="filters-pill"
                onClick={() => add(tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
