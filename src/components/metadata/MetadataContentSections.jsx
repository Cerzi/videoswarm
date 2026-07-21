import React, {
  forwardRef,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { PlusIcon, RefreshIcon } from "../UiIcons";
import {
  MAX_METADATA_SUGGESTION_TAGS,
  buildGenerationMetadataDiagnostics,
  buildGenerationMetadataFacts,
  buildMetadataInfoLineItems,
  deriveMetadataTagSummary,
  formatGenerationLora,
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

export function MetadataGenerationSection({
  state,
  expanded,
  defaultExpanded = true,
  onExpandedChange,
}) {
  const contentId = useId();
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(
    Boolean(defaultExpanded)
  );
  const isControlled = typeof expanded === "boolean";
  const isExpanded = isControlled ? expanded : uncontrolledExpanded;

  if (!state) return null;

  const toggleExpanded = () => {
    const nextExpanded = !isExpanded;
    if (!isControlled) setUncontrolledExpanded(nextExpanded);
    onExpandedChange?.(nextExpanded);
  };
  const refresh = () => {
    if (!isExpanded) {
      if (!isControlled) setUncontrolledExpanded(true);
      onExpandedChange?.(true);
    }
    state.onRefresh?.();
  };

  const metadata = state.metadata || {};
  const facts = buildGenerationMetadataFacts(metadata);
  const prompt = metadata.positivePrompt || metadata.prompt;
  const negativePrompt = metadata.negativePrompt;
  const promptFragments = (Array.isArray(metadata.promptFragments)
    ? metadata.promptFragments
    : [])
    .map((entry) => {
      const source = typeof entry === "string" ? { text: entry } : entry;
      const text = String(source?.text || "").trim();
      if (!text) return null;
      const details = [];
      const role = String(source?.role || "").trim().toLowerCase();
      if (role) details.push(`${role.charAt(0).toUpperCase()}${role.slice(1)}`);
      if (source?.classType) details.push(String(source.classType));
      if (source?.nodeId !== null && source?.nodeId !== undefined) {
        details.push(`node ${source.nodeId}`);
      }
      if (source?.composition && source.composition !== "direct") {
        details.push(String(source.composition).replaceAll("-", " "));
      }
      if (source?.confidence && source.confidence !== "exact") {
        details.push(String(source.confidence));
      }
      return { text, details: details.slice(0, 5) };
    })
    .filter(Boolean)
    .slice(0, 32);
  const loraEntries = Array.isArray(metadata.loras)
    ? metadata.loras
    : Array.isArray(metadata.assets?.loras)
      ? metadata.assets.loras
      : [];
  const loras = loraEntries
    .map(formatGenerationLora)
    .filter(Boolean)
    .slice(0, 64);
  const diagnostics = buildGenerationMetadataDiagnostics(metadata, state);
  const sourceKind = state.sourceKind || metadata.sourceKind || null;
  const sourceLabel = state.sourceLabel || metadata.sourceLabel || null;
  const quality = state.quality || metadata.quality || null;
  const status = state.status || metadata.extractionStatus || (
    state.found ? "found" : "none"
  );
  const qualityLabel = quality === "direct" || quality === "exact"
    ? "Direct"
    : quality === "derived"
      ? "Graph-derived"
      : quality === "partial" || metadata.partial
        ? "Partial"
        : null;
  const sourceBadge = sourceKind === "embedded"
    ? sourceLabel || "Embedded"
    : sourceKind === "sidecar"
      ? sourceLabel || "Sidecar fallback"
      : sourceLabel;
  const hasDisplayableMetadata = Boolean(
    prompt ||
    negativePrompt ||
    promptFragments.length ||
    loras.length ||
    facts.length
  );

  return (
    <section className="metadata-panel__section metadata-panel__generation">
      <div className="metadata-panel__section-header">
        <button
          type="button"
          className="metadata-panel__generation-toggle"
          onClick={toggleExpanded}
          aria-expanded={isExpanded}
          aria-controls={contentId}
          aria-label={`${isExpanded ? "Collapse" : "Expand"} Generation details`}
        >
          <span
            className="metadata-panel__generation-chevron"
            aria-hidden="true"
          >
            {isExpanded ? "▾" : "▸"}
          </span>
          <span>Generation</span>
        </button>
        <div className="metadata-panel__generation-actions">
          {sourceBadge ? (
            <span className="metadata-panel__badge">{sourceBadge}</span>
          ) : null}
          {qualityLabel ? (
            <span className="metadata-panel__badge">{qualityLabel}</span>
          ) : null}
          {state.cached ? <span className="metadata-panel__badge">Cached</span> : null}
          <button
            type="button"
            className="metadata-panel__button metadata-panel__button--compact"
            onClick={refresh}
            disabled={state.loading}
            title="Re-read generation metadata"
          >
            <RefreshIcon />
            <span>Re-read</span>
          </button>
        </div>
      </div>
      {isExpanded ? (
        <div id={contentId} className="metadata-panel__generation-body">
          {state.loading ? (
            <p className="metadata-panel__generation-status">
              Reading embedded generation metadata…
            </p>
          ) : state.error ? (
            <p className="metadata-panel__generation-status metadata-panel__generation-status--error">
              {state.error}
            </p>
          ) : status === "unrecognized" || (state.found && !hasDisplayableMetadata) ? (
            <p className="metadata-panel__generation-status">
              Generation metadata was found, but no supported fields could be resolved.
            </p>
          ) : !state.found && state.readerAvailable === false ? (
            <p className="metadata-panel__generation-status">
              Embedded metadata could not be checked on this system, and no adjacent JSON sidecar was found.
            </p>
          ) : !state.found && status === "unsupported" ? (
            <p className="metadata-panel__generation-status">
              This container's embedded metadata is not supported, and no adjacent JSON sidecar was found.
            </p>
          ) : !state.found && ["error", "timeout", "output-limit"].includes(
            state.readerStatus
          ) ? (
            <p className="metadata-panel__generation-status metadata-panel__generation-status--error">
              Embedded metadata could not be read, and no usable adjacent sidecar was found. Re-read to retry.
            </p>
          ) : !state.found ? (
            <p className="metadata-panel__generation-status">
              No embedded generation metadata or adjacent JSON sidecar was found.
            </p>
          ) : (
            <>
              {sourceKind === "sidecar" ? (
                <p className="metadata-panel__generation-status">
                  Embedded metadata was not usable; showing the adjacent sidecar.
                </p>
              ) : null}
              {diagnostics.length ? (
                <ul className="metadata-panel__generation-diagnostics">
                  {diagnostics.map((message) => <li key={message}>{message}</li>)}
                </ul>
              ) : null}
              <dl className="metadata-panel__generation-grid">
                {prompt ? (
                  <div className="metadata-panel__generation-prompt">
                    <dt>Positive prompt</dt>
                    <dd>{prompt}</dd>
                  </div>
                ) : null}
                {negativePrompt ? (
                  <div className="metadata-panel__generation-prompt metadata-panel__generation-prompt--negative">
                    <dt>Negative prompt</dt>
                    <dd>{negativePrompt}</dd>
                  </div>
                ) : null}
                {promptFragments.length ? (
                  <div className="metadata-panel__generation-wide">
                    <dt>Prompt fragments</dt>
                    <dd>
                      <ul>
                        {promptFragments.map((fragment, index) => (
                          <li key={`${index}:${fragment.text}`}>
                            <span>{fragment.text}</span>
                            {fragment.details.length ? (
                              <small>{fragment.details.join(" · ")}</small>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                ) : null}
                {loras.length ? (
                  <div className="metadata-panel__generation-wide">
                    <dt>LoRAs</dt>
                    <dd>
                      <ul>
                        {loras.map((lora, index) => (
                          <li key={`${index}:${lora}`}>{lora}</li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                ) : null}
                {facts.map(({ label, value }) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd title={value}>{value}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </div>
      ) : null}
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
            className="metadata-panel__button metadata-panel__button--compact"
            onClick={submit}
            disabled={!hasSelection || !inputValue.trim()}
          >
            <PlusIcon />
            <span>Add</span>
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
