import React, { useCallback, useEffect, useRef, useState } from "react";
import "./SequencePanel.css";

const basename = (value) => {
  if (typeof value !== "string" || !value) return "";
  const parts = value.split(/[\\/]/u);
  return parts[parts.length - 1] || value;
};

/**
 * One clip in the strip.
 *
 * These are deliberately plain DOM. Grid cards hand their drag to Electron's
 * native startDrag so clips can be dropped into other applications, and that
 * ends the HTML5 drag -- no in-app drop target can receive it. Reordering
 * therefore lives entirely inside this strip, where nothing binds a native
 * drag and ordinary drag-and-drop works.
 */
function SequenceEntry({
  entry,
  index,
  isDragging,
  isDropTarget,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onRemove,
  onOpen,
}) {
  const missing = !entry.video;
  const name = missing
    ? "Missing clip"
    : entry.video.name || basename(entry.video.id);

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
      onDragStart={(event) => onDragStart(event, entry, index)}
      onDragOver={(event) => onDragOver(event, index)}
      onDrop={(event) => onDrop(event, index)}
      onDragEnd={onDragEnd}
      onDoubleClick={() => !missing && onOpen?.(entry)}
      data-entry-id={entry.id}
      data-position={index}
      data-missing={missing ? "true" : "false"}
    >
      <span className="sequence-panel__ordinal">{index + 1}</span>
      <span className="sequence-panel__name" title={entry.video?.id || ""}>
        {name}
      </span>
      <button
        type="button"
        className="sequence-panel__remove"
        aria-label={`Remove ${name} from the sequence`}
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

export default function SequencePanel({
  sequences = [],
  activeSequence = null,
  activeSequenceId = null,
  error = null,
  selectedCount = 0,
  onSelectSequence,
  onCreateSequence,
  onRenameSequence,
  onDeleteSequence,
  onAddSelection,
  onRemoveEntries,
  onMoveEntry,
  onPlaySequence,
  onClose,
}) {
  const [draggingIndex, setDraggingIndex] = useState(null);
  const [dropIndex, setDropIndex] = useState(null);
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

  const handleCreate = useCallback(() => {
    const name = window.prompt("Name this sequence");
    if (name && name.trim()) onCreateSequence?.(name.trim());
  }, [onCreateSequence]);

  const handleRename = useCallback(() => {
    if (!activeSequence) return;
    const name = window.prompt("Rename this sequence", activeSequence.name);
    if (name && name.trim()) onRenameSequence?.(activeSequence.id, name.trim());
  }, [activeSequence, onRenameSequence]);

  const handleDelete = useCallback(() => {
    if (!activeSequence) return;
    const confirmed = window.confirm(
      `Delete the sequence "${activeSequence.name}"? The clips themselves are not touched.`
    );
    if (confirmed) onDeleteSequence?.(activeSequence.id);
  }, [activeSequence, onDeleteSequence]);

  return (
    <section className="sequence-panel" aria-label="Clip sequence">
      <header className="sequence-panel__header">
        <label className="sequence-panel__picker">
          <span className="sequence-panel__picker-label">Sequence</span>
          <select
            value={activeSequenceId ?? ""}
            onChange={(event) =>
              onSelectSequence?.(Number(event.target.value) || null)
            }
            disabled={!sequences.length}
            aria-label="Active sequence"
          >
            {!sequences.length && <option value="">No sequences yet</option>}
            {sequences.map((sequence) => (
              <option key={sequence.id} value={sequence.id}>
                {sequence.name} ({sequence.entryCount})
              </option>
            ))}
          </select>
        </label>

        <div className="sequence-panel__actions">
          <button type="button" onClick={handleCreate}>
            New
          </button>
          <button type="button" onClick={handleRename} disabled={!activeSequence}>
            Rename
          </button>
          <button type="button" onClick={handleDelete} disabled={!activeSequence}>
            Delete
          </button>
          <button
            type="button"
            className="sequence-panel__primary"
            onClick={() => onAddSelection?.()}
            disabled={!activeSequence || selectedCount === 0}
            title={
              activeSequence
                ? "Append the current selection in the order the grid is sorted"
                : "Create a sequence first"
            }
          >
            Add selection{selectedCount ? ` (${selectedCount})` : ""}
          </button>
          {onPlaySequence && (
            <button
              type="button"
              onClick={() => onPlaySequence()}
              disabled={!entries.length}
            >
              Play
            </button>
          )}
        </div>

        <div className="sequence-panel__status">
          {missingCount > 0 && (
            <span className="sequence-panel__warning">
              {missingCount} missing
            </span>
          )}
          {error && <span className="sequence-panel__error">{error}</span>}
          {onClose && (
            <button
              type="button"
              className="sequence-panel__close"
              onClick={onClose}
              aria-label="Hide the sequence panel"
            >
              ×
            </button>
          )}
        </div>
      </header>

      {activeSequence && !entries.length ? (
        <p className="sequence-panel__empty">
          Select clips in the grid, then use <strong>Add selection</strong>.
          They append in the order the grid is sorted; drag them here to change
          it.
        </p>
      ) : (
        <ol
          className="sequence-panel__strip"
          onDragOver={(event) => {
            if (draggingIndexRef.current !== null) event.preventDefault();
          }}
        >
          {entries.map((entry, index) => (
            <SequenceEntry
              key={entry.id}
              entry={entry}
              index={index}
              isDragging={draggingIndex === index}
              isDropTarget={dropIndex === index && draggingIndex !== index}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onDragEnd={handleDragEnd}
              onRemove={(entryId) => onRemoveEntries?.([entryId])}
              onOpen={onPlaySequence ? (target) => onPlaySequence(target) : undefined}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
