import React, {
  forwardRef,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  MAX_METADATA_SUGGESTION_TAGS,
  buildGenerationMetadataFacts,
  buildMetadataInfoLineItems,
  deriveMetadataTagSummary,
  parseMetadataTagInput,
  selectMetadataTagCompletion,
  selectMetadataTagSuggestions,
} from "./metadataContent";

export function MetadataFileFactsSection({
  info,
  includeRelativePath = false,
}) {
  const items = useMemo(
    () => buildMetadataInfoLineItems(info, { includeRelativePath }),
    [includeRelativePath, info]
  );
  if (!items.length) return null;

  return (
    <section className="metadata-panel__section metadata-panel__info">
      <div className="metadata-panel__info-line" role="text">
        {items.map((item, index) => (
          <span
            key={item.key || index}
            className={`metadata-panel__info-item${
              item.className ? ` ${item.className}` : ""
            }`}
            title={item.title}
          >
            {index > 0 ? (
              <span aria-hidden="true" className="metadata-panel__info-separator">
                •
              </span>
            ) : null}
            <span>{item.label}</span>
          </span>
        ))}
      </div>
    </section>
  );
}

export function MetadataGenerationSection({ state }) {
  if (!state) return null;
  const metadata = state.metadata || {};
  const facts = buildGenerationMetadataFacts(metadata);

  return (
    <section className="metadata-panel__section metadata-panel__generation">
      <div className="metadata-panel__section-header">
        <span>Generation</span>
        <div className="metadata-panel__generation-actions">
          {state.cached ? <span className="metadata-panel__badge">Cached</span> : null}
          <button
            type="button"
            onClick={() => state.onRefresh?.()}
            disabled={state.loading}
          >
            Refresh
          </button>
        </div>
      </div>
      {state.loading ? (
        <p className="metadata-panel__generation-status">
          Looking for a matching sidecar…
        </p>
      ) : state.error ? (
        <p className="metadata-panel__generation-status metadata-panel__generation-status--error">
          {state.error}
        </p>
      ) : !state.found ? (
        <p className="metadata-panel__generation-status">
          No matching sidecar found for this clip.
        </p>
      ) : (
        <dl className="metadata-panel__generation-grid">
          {metadata.prompt ? (
            <div className="metadata-panel__generation-prompt">
              <dt>Prompt</dt>
              <dd title={metadata.prompt}>{metadata.prompt}</dd>
            </div>
          ) : null}
          {facts.map(({ label, value }) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd title={value}>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

export const MetadataTagsSection = forwardRef(function MetadataTagsSection(
  {
    selectedVideos = [],
    selectionCount = selectedVideos.length,
    availableTags = [],
    suggestionLimit = MAX_METADATA_SUGGESTION_TAGS,
    active = true,
    resetKey = null,
    onAddTag,
    onRemoveTag,
    onApplyTagToSelection,
  },
  inputRef
) {
  const [inputValue, setInputValue] = useState("");
  const hasSelection = selectionCount > 0;
  const { sharedTags, partialTags } = useMemo(
    () => deriveMetadataTagSummary(selectedVideos, selectionCount),
    [selectedVideos, selectionCount]
  );
  const suggestionTags = useMemo(
    () =>
      active
        ? selectMetadataTagSuggestions({
            availableTags,
            sharedTags,
            query: inputValue,
            limit: suggestionLimit,
          })
        : [],
    [active, availableTags, inputValue, sharedTags, suggestionLimit]
  );

  useEffect(() => {
    setInputValue("");
  }, [active, resetKey]);

  const submit = () => {
    const tags = parseMetadataTagInput(inputValue);
    if (!tags.length) return;
    onAddTag?.(tags);
    setInputValue("");
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key !== "Tab") return;

    const query = inputValue.split(",").at(-1) || "";
    const completion = selectMetadataTagCompletion(availableTags, query);
    if (!completion) return;
    event.preventDefault();
    onAddTag?.([completion]);
    setInputValue("");
  };

  return (
    <>
      <section className="metadata-panel__section metadata-panel__section--tags">
        <div className="metadata-panel__section-header">
          <span>Tags</span>
          <span className="metadata-panel__badge">
            {sharedTags.length ? `${sharedTags.length} applied` : "None"}
          </span>
        </div>
        <div className="metadata-panel__chips">
          {sharedTags.length === 0 ? (
            <span className="metadata-panel__hint">No shared tags yet.</span>
          ) : (
            sharedTags.map((tag) => (
              <button
                key={tag}
                type="button"
                className="metadata-panel__chip"
                onClick={() => onRemoveTag?.(tag)}
              >
                <span>#{tag}</span>
                <span aria-hidden="true">×</span>
              </button>
            ))
          )}
        </div>

        {partialTags.length ? (
          <div className="metadata-panel__partial-group">
            <div className="metadata-panel__section-subtitle">
              Appears on some selected clips
            </div>
            <div className="metadata-panel__chips">
              {partialTags.map(({ tag, count }) => (
                <button
                  key={tag}
                  type="button"
                  className="metadata-panel__chip metadata-panel__chip--ghost"
                  onClick={() => onApplyTagToSelection?.(tag)}
                  title={`Apply to all (${count}/${selectionCount})`}
                >
                  <span>#{tag}</span>
                  <span className="metadata-panel__chip-count">
                    {count}/{selectionCount}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="metadata-panel__input-row">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Add tag and press Enter"
            disabled={!hasSelection}
          />
          <button
            type="button"
            onClick={submit}
            disabled={!hasSelection || !inputValue.trim()}
          >
            Add
          </button>
        </div>
      </section>

      {suggestionTags.length ? (
        <section
          className="metadata-panel__section metadata-panel__section--suggestions"
          aria-live="polite"
        >
          <div className="metadata-panel__section-subtitle metadata-panel__suggestions-title">
            {inputValue.trim()
              ? "Matching tags"
              : `Popular tags (up to ${suggestionLimit})`}
          </div>
          <div className="metadata-panel__suggestion-list">
            {suggestionTags.map((suggestion) => (
              <button
                key={suggestion.name}
                type="button"
                className="metadata-panel__suggestion"
                onClick={() => onApplyTagToSelection?.(suggestion.name)}
                title={`Apply #${suggestion.name} to selection`}
              >
                <span>#{suggestion.name}</span>
                {typeof suggestion.usageCount === "number" ? (
                  <span className="metadata-panel__suggestion-count">
                    {suggestion.usageCount}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
});
