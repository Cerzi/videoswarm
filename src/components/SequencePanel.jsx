import React, { useCallback, useEffect, useRef, useState } from "react";
import MenuButton from "./menu/MenuButton";
import "./SequencePanel.css";

const basename = (value) => {
  if (typeof value !== "string" || !value) return "";
  const parts = value.split(/[\\/]/u);
  return parts[parts.length - 1] || value;
};

/**
 * One clip in the list. A thumbnail column appears only when the caller has
 * images to give: grid thumbnails exist only for clips that were hovered or
 * dragged, and decoding a frame per entry would cost the decoder budget the
 * grid depends on, so none is supplied yet.
 *
 * These are deliberately plain DOM. Grid cards hand their drag to Electron's
 * native startDrag so clips can be dropped into other applications, and that
 * ends the HTML5 drag -- no in-app drop target can receive it. Reordering
 * therefore lives entirely inside this list, where nothing binds a native
 * drag and ordinary drag-and-drop works. Alt+↑ and Alt+↓ move the focused
 * entry for anyone not using a pointer.
 */
function SequenceEntry({
  entry,
  index,
  count,
  thumbnail,
  showThumbnail = false,
  isDragging,
  isDropTarget,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onRemove,
  onOpen,
  onMove,
}) {
  const missing = !entry.video;
  const name = missing
    ? "Missing clip"
    : entry.video.name || basename(entry.video.id);

  const handleKeyDown = (event) => {
    if (event.target !== event.currentTarget) return;
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      const target = event.key === "ArrowUp" ? index - 1 : index + 1;
      if (target < 0 || target >= count) return;
      event.preventDefault();
      onMove?.(entry.id, target);
      return;
    }
    if (event.key === "Enter" && !missing) {
      event.preventDefault();
      onOpen?.(entry);
    }
  };

  return (
    <li
      className={[
        "sequence-panel__entry",
        missing ? "sequence-panel__entry--missing" : "",
        isDragging ? "sequence-panel__entry--dragging" : "",
        isDropTarget ? "sequence-panel__entry--drop-target" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      draggable
      tabIndex={0}
      onDragStart={(event) => onDragStart(event, entry, index)}
      onDragOver={(event) => onDragOver(event, index)}
      onDrop={(event) => onDrop(event, index)}
      onDragEnd={onDragEnd}
      onDoubleClick={() => !missing && onOpen?.(entry)}
      onKeyDown={handleKeyDown}
      data-entry-id={entry.id}
      data-position={index}
      data-missing={missing ? "true" : "false"}
      aria-label={`${index + 1}. ${name}`}
    >
      <span className="sequence-panel__ordinal">{index + 1}</span>
      {showThumbnail && (
        <span className="sequence-panel__thumb" aria-hidden="true">
          {thumbnail ? <img src={thumbnail} alt="" draggable={false} /> : null}
        </span>
      )}
      <span className="sequence-panel__name" title={entry.video?.id || ""}>
        {name}
      </span>
      <button
        type="button"
        className="sequence-panel__remove"
        aria-label={`Remove ${name} from the sequence`}
        title="Remove from the sequence"
        draggable={false}
        onClick={(event) => {
          event.stopPropagation();
          onRemove(entry.id);
        }}
      >
        ×
      </button>
    </li>
  );
}

/**
 * Inline name entry. Electron does not implement window.prompt, so naming a
 * sequence happens in the panel itself.
 */
function NameForm({ initialValue = "", submitLabel, onSubmit, onCancel }) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <form
      className="sequence-panel__name-form"
      data-hotkey-exempt
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = value.trim();
        if (trimmed) onSubmit(trimmed);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={value}
        maxLength={80}
        aria-label="Sequence name"
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit" disabled={!value.trim()}>
        {submitLabel}
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

export default function SequencePanel({
  sequences = [],
  activeSequence = null,
  activeSequenceId = null,
  error = null,
  selectedCount = 0,
  thumbnails = null,
  onSelectSequence,
  onCreateSequence,
  onRenameSequence,
  onDeleteSequence,
  onAddSelection,
  onRemoveEntries,
  onMoveEntry,
  onPlaySequence,
  onExportCopy,
  onExportFile,
  onRenumber,
  exportFileUnavailableReason = null,
}) {
  const [draggingIndex, setDraggingIndex] = useState(null);
  const [dropIndex, setDropIndex] = useState(null);
  const [naming, setNaming] = useState(null);
  const draggingIndexRef = useRef(null);

  useEffect(() => {
    draggingIndexRef.current = draggingIndex;
  }, [draggingIndex]);

  const entries = Array.isArray(activeSequence?.entries)
    ? activeSequence.entries
    : [];
  const missingCount = Number(activeSequence?.missingCount) || 0;

  const handleDragStart = useCallback((event, entry, index) => {
    setDraggingIndex(index);
    try {
      event.dataTransfer.effectAllowed = "move";
      // Firefox and Chromium both refuse to start a drag with no payload.
      event.dataTransfer.setData("text/plain", String(entry.id));
    } catch {
      // A browser that refuses the payload still reorders through state.
    }
  }, []);

  const handleDragOver = useCallback((event, index) => {
    if (draggingIndexRef.current === null) return;
    event.preventDefault();
    try {
      event.dataTransfer.dropEffect = "move";
    } catch {
      // Non-fatal: the drop handler does the work.
    }
    setDropIndex(index);
  }, []);

  const handleDrop = useCallback(
    (event, index) => {
      event.preventDefault();
      const from = draggingIndexRef.current;
      setDraggingIndex(null);
      setDropIndex(null);
      if (from === null || from === index) return;
      const entry = entries[from];
      if (entry) onMoveEntry?.(entry.id, index);
    },
    [entries, onMoveEntry]
  );

  const handleDragEnd = useCallback(() => {
    setDraggingIndex(null);
    setDropIndex(null);
  }, []);

  const handleDelete = useCallback(() => {
    if (!activeSequence) return;
    const confirmed = window.confirm(
      `Delete the sequence "${activeSequence.name}"? The clips themselves are not touched.`
    );
    if (confirmed) onDeleteSequence?.(activeSequence.id);
  }, [activeSequence, onDeleteSequence]);

  const submitName = useCallback(
    async (name) => {
      const mode = naming;
      setNaming(null);
      try {
        if (mode === "create") await onCreateSequence?.(name);
        else if (mode === "rename" && activeSequence) {
          await onRenameSequence?.(activeSequence.id, name);
        }
      } catch {
        // The hook records the reason in `error`, which the panel shows.
      }
    },
    [activeSequence, naming, onCreateSequence, onRenameSequence]
  );

  const hasEntries = entries.length > 0;
  const fileItems = [
    onExportCopy && {
      type: "item",
      id: "export-copy",
      label: "Copy as numbered files…",
      hint: "010_, 020_ … plus an ffmpeg concat.txt; originals untouched",
      disabled: !hasEntries,
      onSelect: () => onExportCopy(),
    },
    onExportFile && {
      type: "item",
      id: "export-file",
      label: "Export as one video…",
      hint: exportFileUnavailableReason || "Joins the clips with ffmpeg",
      disabled: !hasEntries || Boolean(exportFileUnavailableReason),
      onSelect: () => onExportFile(),
    },
    onExportFile && exportFileUnavailableReason && {
      type: "note",
      id: "export-file-unavailable",
      text: exportFileUnavailableReason,
    },
    onRenumber && { type: "separator", id: "renumber-separator" },
    onRenumber && {
      type: "item",
      id: "renumber",
      label: "Rename originals to this order…",
      hint: "Prefixes each file with its position; asks first",
      disabled: !hasEntries,
      onSelect: () => onRenumber(),
    },
  ].filter(Boolean);

  return (
    <section className="sequence-panel" aria-label="Sequences">
      <header className="sequence-panel__header">
        <div className="sequence-panel__row">
          <select
            className="sequence-panel__picker"
            value={activeSequenceId ?? ""}
            onChange={(event) =>
              onSelectSequence?.(Number(event.target.value) || null)
            }
            disabled={!sequences.length}
            aria-label="Active sequence"
          >
            {!sequences.length && <option value="">No sequences yet</option>}
            {sequences.length > 0 && activeSequenceId == null && (
              <option value="">Choose a sequence</option>
            )}
            {sequences.map((sequence) => (
              <option key={sequence.id} value={sequence.id}>
                {sequence.name} ({sequence.entryCount})
              </option>
            ))}
          </select>
        </div>

        {naming ? (
          <NameForm
            key={naming}
            initialValue={naming === "rename" ? activeSequence?.name || "" : ""}
            submitLabel={naming === "rename" ? "Rename" : "Create"}
            onSubmit={submitName}
            onCancel={() => setNaming(null)}
          />
        ) : (
          <div className="sequence-panel__row sequence-panel__actions">
            <button type="button" onClick={() => setNaming("create")}>
              New
            </button>
            <button
              type="button"
              onClick={() => setNaming("rename")}
              disabled={!activeSequence}
            >
              Rename
            </button>
            <button type="button" onClick={handleDelete} disabled={!activeSequence}>
              Delete
            </button>
          </div>
        )}

        <div className="sequence-panel__row sequence-panel__actions">
          <button
            type="button"
            className="sequence-panel__primary"
            onClick={() => onAddSelection?.()}
            disabled={!activeSequence || selectedCount === 0}
            title={
              activeSequence
                ? "Append the current selection in the order the grid is sorted (B)"
                : "Create a sequence first"
            }
          >
            Add selection{selectedCount ? ` (${selectedCount})` : ""}
          </button>
          {onPlaySequence && (
            <button
              type="button"
              onClick={() => onPlaySequence()}
              disabled={!hasEntries}
              title="Play the sequence through in fullscreen"
            >
              Play
            </button>
          )}
          {fileItems.length > 0 && (
            <MenuButton
              label="Files"
              items={fileItems}
              ariaLabel="Sequence file actions"
              title="Export or write this order onto disk"
              align="end"
              disabled={!activeSequence}
              buttonClassName="sequence-panel__menu-button"
            />
          )}
        </div>

        {(missingCount > 0 || error) && (
          <div className="sequence-panel__status" role="status">
            {missingCount > 0 && (
              <span className="sequence-panel__warning">
                {missingCount} missing
              </span>
            )}
            {error && <span className="sequence-panel__error">{error}</span>}
          </div>
        )}
      </header>

      {!activeSequence ? (
        <p className="sequence-panel__empty">
          {sequences.length
            ? "Choose a sequence above, or start a new one."
            : "A sequence is an ordered list of clips for a story. Select clips in the grid and press B, or use Add to sequence in the right-click menu."}
        </p>
      ) : !entries.length ? (
        <p className="sequence-panel__empty">
          Select clips in the grid, then use <strong>Add selection</strong> or
          press B. They append in the order the grid is sorted; drag them here
          to change it.
        </p>
      ) : (
        <ol
          className="sequence-panel__list"
          onDragOver={(event) => {
            if (draggingIndexRef.current !== null) event.preventDefault();
          }}
        >
          {entries.map((entry, index) => (
            <SequenceEntry
              key={entry.id}
              entry={entry}
              index={index}
              count={entries.length}
              thumbnail={thumbnails?.[entry.id] || null}
              showThumbnail={Boolean(thumbnails)}
              isDragging={draggingIndex === index}
              isDropTarget={dropIndex === index && draggingIndex !== index}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onDragEnd={handleDragEnd}
              onRemove={(entryId) => onRemoveEntries?.([entryId])}
              onOpen={onPlaySequence ? (target) => onPlaySequence(target) : undefined}
              onMove={onMoveEntry}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
