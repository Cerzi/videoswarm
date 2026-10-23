import React, { useEffect, useRef, useState } from "react";
import "./StackBar.css";
import "./ArenaBar.css";
import { ARENA_KINDS, ARENA_KIND_LABELS, ARENA_QUESTIONS, ARENA_TAG_KEYS } from "../app/arena/arenaView";

const BORDER_PAIRS = [
  { value: "", label: "Any pair" },
  { value: "1", label: "1★ / 2★" },
  { value: "2", label: "2★ / 3★" },
  { value: "3", label: "3★ / 4★" },
  { value: "4", label: "4★ / 5★" },
];

const EMPTY_REASONS = {
  place: "No unrated clips left to place here.",
  tier: "No rating has enough clips for a tier check.",
  border: "No two neighbouring ratings have enough clips for a border.",
  mixed: "Nothing to rate here: the pool needs unrated clips, or rated clips to check.",
};

const count = (value) => Number(value || 0).toLocaleString();

// The bar above the arena (docs/architecture/rating-arena.md, Section 3):
// the round's kind, the pool and matching, how far along the session is, the
// question, and suggested tags for New.
export default function ArenaBar({
  arena,
  stats,
  streak = 0,
  tagged = 0,
  clipsInView = 0,
  canNext = false,
  nextLabel = "Next",
  suggestions = [],
  availableTags = [],
  tagBoxOpen = false,
  tagTargetName = "",
  onKindChange,
  onBorderChange,
  onScopeChange,
  onMatchChange,
  onNext,
  onRestart,
  onClose,
  onApplySuggestion,
  onDismissSuggestion,
  onOpenTagBox,
  onCloseTagBox,
  onSubmitTag,
}) {
  const [tagText, setTagText] = useState("");
  const inputRef = useRef(null);
  useEffect(() => {
    if (!tagBoxOpen) return;
    setTagText("");
    inputRef.current?.focus();
  }, [tagBoxOpen]);

  if (!arena) return null;
  const busy = arena.status === "starting" || arena.status === "dealing";
  const round = arena.round;
  const roundKind = round?.kind || null;
  let status;
  if (arena.status === "starting") status = "Gathering clips…";
  else if (arena.status === "failed") status = "The arena could not deal a round";
  else if (arena.status === "empty") status = EMPTY_REASONS[arena.reason] || EMPTY_REASONS.mixed;
  else {
    const unrated = arena.counts?.unrated;
    status = `Round ${count(arena.roundNumber)}`;
    if (unrated != null) status += ` · ${count(unrated)} unrated left`;
  }
  const tally = [];
  if (stats?.placed) tally.push(`${count(stats.placed)} placed`);
  if (stats?.moved) tally.push(`${count(stats.moved)} moved`);
  if (stats?.held) tally.push(`${count(stats.held)} held`);
  if (tagged) tally.push(`${count(tagged)} tagged`);

  const datalistId = "arena-tag-options";
  const submitTag = (event) => {
    event.preventDefault();
    const name = tagText.trim();
    if (name) onSubmitTag?.(name);
  };

  return (
    <div className="arena-bar" role="toolbar" aria-label="Rating arena">
      <div className="stack-bar arena-bar__row">
        <button type="button" className="stack-bar__close" onClick={() => onClose?.()} title="Back to the grid (Esc)">
          <span aria-hidden="true">‹</span> Back
        </button>
        <span className="arena-bar__title">Arena</span>
        <select
          className="arena-bar__select"
          aria-label="Round kind"
          value={arena.kind}
          onChange={(event) => onKindChange?.(event.target.value)}
          disabled={arena.status === "starting"}
        >
          {ARENA_KINDS.map((kind) => (
            <option key={kind.value} value={kind.value}>
              {kind.label}
            </option>
          ))}
        </select>
        {arena.kind === "border" ? (
          <select
            className="arena-bar__select"
            aria-label="Border pair"
            value={arena.border == null ? "" : String(arena.border)}
            onChange={(event) => onBorderChange?.(event.target.value ? Number(event.target.value) : null)}
            disabled={arena.status === "starting"}
          >
            {BORDER_PAIRS.map((pair) => (
              <option key={pair.value} value={pair.value}>
                {pair.label}
              </option>
            ))}
          </select>
        ) : null}
        <select
          className="arena-bar__select"
          aria-label="Clips to draw from"
          value={arena.scope}
          onChange={(event) => onScopeChange?.(event.target.value)}
          disabled={arena.status === "starting"}
          title="Library brings back clips from every folder; These clips keeps to what the grid showed"
        >
          <option value="library">Library</option>
          <option value="clips" disabled={clipsInView === 0 && arena.scope !== "clips"}>
            {arena.scope === "clips" ? "These clips" : `These ${count(clipsInView)} clips`}
          </option>
        </select>
        <select
          className="arena-bar__select"
          aria-label="Matching"
          value={arena.match}
          onChange={(event) => onMatchChange?.(event.target.value)}
          disabled={arena.status === "starting"}
          title="Similar prompts compares clips of the same subject, so they are judged on how well they were made"
        >
          <option value="similar">Similar prompts</option>
          <option value="any">Any</option>
        </select>
        <span className="stack-bar__summary arena-bar__status">{status}</span>
        {tally.length ? <span className="arena-bar__tally">{tally.join(" · ")}</span> : null}
        {streak >= 2 ? (
          <span className="arena-bar__streak" title="Rounds finished in a row without skipping">
            {count(streak)} in a row
          </span>
        ) : null}
        <span className="stack-bar__spacer" />
        <button type="button" onClick={() => onRestart?.()} disabled={busy || !round} title="Play every clip from its first frame at once">
          Play together from the start
        </button>
        <button
          type="button"
          className="arena-bar__next"
          onClick={() => onNext?.()}
          disabled={!canNext}
          title={nextLabel === "Skip" ? "Leave New unrated and deal the next round (Enter)" : "Next round (Enter)"}
        >
          {nextLabel} <kbd>⏎</kbd>
        </button>
      </div>
      {round ? (
        <div className="stack-bar arena-bar__row arena-bar__row--question">
          <span className="arena-bar__kind">{ARENA_KIND_LABELS[roundKind] || ""}</span>
          <span className="arena-bar__question">{ARENA_QUESTIONS[roundKind] || ""}</span>
          <span className="stack-bar__spacer" />
          {suggestions.length ? (
            <span className="arena-bar__suggestions" aria-label="Suggested tags for New">
              {suggestions.map((suggestion, index) => (
                <span key={suggestion.tag} className="arena-bar__suggestion">
                  <button
                    type="button"
                    onClick={() => onApplySuggestion?.(index)}
                    title={`Tag New “${suggestion.tag}” (${ARENA_TAG_KEYS[index].toUpperCase()})`}
                  >
                    <kbd>{ARENA_TAG_KEYS[index].toUpperCase()}</kbd> {suggestion.tag}
                  </button>
                  <button
                    type="button"
                    className="arena-bar__dismiss"
                    onClick={() => onDismissSuggestion?.(index)}
                    aria-label={`Not ${suggestion.tag}`}
                    title={`Not “${suggestion.tag}”: don't suggest it for this clip again`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </span>
          ) : null}
          {tagBoxOpen ? (
            <form className="arena-bar__tag-form" onSubmit={submitTag} data-hotkey-exempt>
              <input
                ref={inputRef}
                type="text"
                value={tagText}
                list={datalistId}
                placeholder={tagTargetName ? `Tag ${tagTargetName}` : "Tag"}
                aria-label="Tag for the selected clip"
                onChange={(event) => setTagText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    onCloseTagBox?.();
                  }
                }}
                onBlur={() => onCloseTagBox?.()}
              />
              <datalist id={datalistId}>
                {availableTags.slice(0, 500).map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </form>
          ) : (
            <button type="button" onClick={() => onOpenTagBox?.()} title="Type a tag for the selected clip (T)">
              <kbd>T</kbd> Tag…
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
