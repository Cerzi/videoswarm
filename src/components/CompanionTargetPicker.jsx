import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { checkTargetSend, companionRowsOf } from "../app/companion/companionSend";
import "./ProcessReviewResultsDialog.css";
import "./CompanionTargetPicker.css";

const NEW_ROW = "__new__";
const CHECK_DELAY_MS = 250;

const plural = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

/**
 * What adding would do, from a dry run's answers: "3 will be added", "2 of 5
 * already there, 3 will be added", with refusals and their first reason.
 */
export function describeTargetCheck(dry, total) {
  let sent = 0;
  let skipped = 0;
  let refused = 0;
  let refusedWhy = "";
  for (const entry of dry?.values?.() || []) {
    if (entry?.result === "sent") sent += 1;
    else if (entry?.result === "skipped") skipped += 1;
    else {
      refused += 1;
      refusedWhy ||= entry?.why || "";
    }
  }
  const parts = [];
  if (skipped && !sent && !refused) parts.push(`All ${total.toLocaleString()} already there`);
  else if (skipped) parts.push(`${skipped.toLocaleString()} of ${total.toLocaleString()} already there`);
  if (sent) parts.push(`${sent.toLocaleString()} will be added`);
  if (refused) parts.push(`${refused.toLocaleString()} cannot be${refusedWhy ? `: ${refusedWhy}` : ""}`);
  return { sent, text: parts.join(", ") || "Nothing to add" };
}

/**
 * Adds clips to one of a companion action's targets, such as a project
 * (docs/architecture/companion-app.md): a search box, the targets in the
 * app's order (recent first) with one detail line each, and a row to make a
 * new one. It starts on the app's current target, else the one used last.
 * Every choice is dry-run first, so the footer says what adding would do;
 * Enter adds, Esc cancels. Adding itself is the caller's (`onConfirm`).
 */
export default function CompanionTargetPicker({
  open,
  companion = null,
  action = null,
  videos = [],
  lastHandle = null,
  onConfirm,
  onClose,
}) {
  const dialogRef = useRef(null);
  const searchRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const { instanceIds } = useMemo(() => companionRowsOf(videos), [videos]);
  const [targets, setTargets] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [newName, setNewName] = useState("");
  const [check, setCheck] = useState({ state: "idle" });
  const targetsLabel = action?.targets?.label || "Target";
  const canMakeNew = Boolean(action?.targets?.new);

  // The list, asked for afresh each time the picker opens.
  useEffect(() => {
    if (!open || !companion || !action) return undefined;
    let alive = true;
    setTargets(null);
    setLoadError("");
    setQuery("");
    setNewName("");
    const list = window.electronAPI?.companion?.targets;
    Promise.resolve(typeof list === "function" ? list(companion.id, action.id) : null)
      .then((answer) => {
        if (!alive) return;
        if (!answer?.success) {
          setTargets([]);
          setLoadError(answer?.error || `${companion.name || "The companion app"} did not answer`);
          return;
        }
        const found = Array.isArray(answer.targets) ? answer.targets : [];
        setTargets(found);
        const start =
          found.find((target) => target.current) ||
          found.find((target) => target.handle === lastHandle) ||
          found[0];
        setSelected(start ? start.handle : canMakeNew ? NEW_ROW : null);
      })
      .catch((error) => {
        if (!alive) return;
        setTargets([]);
        setLoadError(error?.message || "The companion app did not answer");
      });
    return () => {
      alive = false;
    };
  }, [action, canMakeNew, companion, lastHandle, open]);

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase();
    const list = targets || [];
    if (!words) return list;
    return list.filter((target) =>
      `${target.label} ${target.detail || ""}`.toLowerCase().includes(words)
    );
  }, [query, targets]);
  const rows = useMemo(
    () => [...shown.map((target) => target.handle), ...(canMakeNew ? [NEW_ROW] : [])],
    [canMakeNew, shown]
  );

  // A search that hides the chosen row moves the choice to the first shown.
  useEffect(() => {
    if (!targets) return;
    if (selected && rows.includes(selected)) return;
    setSelected(rows[0] || null);
  }, [rows, selected, targets]);

  const chosenTarget = useMemo(() => {
    if (selected === NEW_ROW) {
      const name = newName.trim();
      return name ? { target: { new: name }, label: name } : null;
    }
    const target = (targets || []).find((entry) => entry.handle === selected);
    return target ? { target: { handle: target.handle }, label: target.label } : null;
  }, [newName, selected, targets]);

  // Every choice is checked with a dry run, a moment after it settles.
  useEffect(() => {
    if (!open || !companion || !action || !chosenTarget || !instanceIds.length) {
      setCheck({ state: "idle" });
      return undefined;
    }
    let alive = true;
    setCheck({ state: "checking" });
    const timer = setTimeout(async () => {
      const outcome = await checkTargetSend({
        companionId: companion.id,
        actionId: action.id,
        instanceIds,
        target: chosenTarget.target,
      });
      if (!alive) return;
      if (outcome.status !== "checked") {
        setCheck({ state: "error", text: outcome.error });
        return;
      }
      setCheck({ state: "checked", ...describeTargetCheck(outcome.dry, instanceIds.length) });
    }, CHECK_DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [action, chosenTarget, companion, instanceIds, open]);

  const canAdd = Boolean(chosenTarget) && check.state === "checked" && check.sent > 0;

  const confirm = useCallback(() => {
    if (!canAdd) return;
    onConfirm?.({ target: chosenTarget.target, label: chosenTarget.label });
  }, [canAdd, chosenTarget, onConfirm]);

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    searchRef.current?.focus?.();
    return () => previous?.focus?.();
  }, [open]);

  if (!open || !companion || !action) return null;

  const move = (step) => {
    if (!rows.length) return;
    const at = rows.indexOf(selected);
    setSelected(rows[Math.min(rows.length - 1, Math.max(0, (at < 0 ? -1 : at) + step))]);
  };

  const handleKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current?.();
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      confirm();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
    }
  };

  const count = instanceIds.length;
  return (
    <div
      className="review-results-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current?.();
      }}
    >
      <section
        ref={dialogRef}
        className="review-results-dialog companion-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="companion-picker-title"
        data-hotkey-exempt
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="review-results-dialog__header">
          <div className="review-results-dialog__mark" aria-hidden="true">↗</div>
          <div className="review-results-dialog__heading">
            <h2 id="companion-picker-title">{action.pick || action.send}</h2>
            <p>
              {plural(count, "clip")} · {companion.name || "Companion app"}
            </p>
          </div>
          <button
            type="button"
            className="review-results-dialog__close"
            aria-label="Close"
            onClick={() => onCloseRef.current?.()}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="review-results-dialog__body companion-picker__body">
          <input
            ref={searchRef}
            type="search"
            className="companion-picker__search"
            aria-label={`Search ${targetsLabel.toLowerCase()}s`}
            placeholder={`Search ${targetsLabel.toLowerCase()}s`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {targets === null ? (
            <p className="companion-picker__note" role="status">Loading…</p>
          ) : null}
          {loadError ? (
            <p className="review-results-dialog__notice review-results-dialog__notice--error" role="alert">
              {loadError}
            </p>
          ) : null}
          <ul className="companion-picker__list" role="listbox" aria-label={targetsLabel}>
            {shown.map((target) => (
              <li
                key={target.handle}
                role="option"
                aria-selected={selected === target.handle}
                className="companion-picker__row"
                onClick={() => setSelected(target.handle)}
                onDoubleClick={() => {
                  setSelected(target.handle);
                  if (selected === target.handle) confirm();
                }}
              >
                <span className="companion-picker__label">
                  {target.label}
                  {target.current ? <span className="companion-picker__current">current</span> : null}
                </span>
                {target.detail ? <span className="companion-picker__detail">{target.detail}</span> : null}
              </li>
            ))}
            {canMakeNew ? (
              <li
                role="option"
                aria-selected={selected === NEW_ROW}
                className="companion-picker__row companion-picker__row--new"
                onClick={() => setSelected(NEW_ROW)}
              >
                <span className="companion-picker__label">{action.targets.new}</span>
              </li>
            ) : null}
          </ul>
          {selected === NEW_ROW ? (
            <input
              type="text"
              className="companion-picker__search"
              aria-label={`New ${targetsLabel.toLowerCase()} name`}
              placeholder="Name"
              maxLength={80}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
          ) : null}
        </div>
        <footer className="review-results-dialog__footer">
          <span className="companion-picker__summary" role="status" aria-live="polite">
            {check.state === "checking"
              ? "Checking…"
              : check.state === "checked" || check.state === "error"
                ? check.text
                : selected === NEW_ROW
                  ? "Name it to add"
                  : ""}
          </span>
          <button type="button" onClick={() => onCloseRef.current?.()}>
            Cancel
          </button>
          <button type="button" className="companion-send__primary" disabled={!canAdd} onClick={confirm}>
            {canAdd ? `Add ${check.sent.toLocaleString()}` : "Add"}
          </button>
        </footer>
      </section>
    </div>
  );
}
