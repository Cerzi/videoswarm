import React, { useEffect, useRef } from "react";
import { HOTKEY_SECTIONS } from "../hotkeys/shortcutCatalog";
import "./KeyboardShortcutsDialog.css";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function ShortcutKeys({ shortcut }) {
  const spokenJoiner = shortcut.keyJoiner === "or" ? " or " : " plus ";
  return (
    <span className="shortcut-keys" aria-label={shortcut.keys.join(spokenJoiner)}>
      {shortcut.keys.map((key, index) => (
        <React.Fragment key={`${shortcut.id}-${key}`}>
          {index > 0 && (
            <span className="shortcut-keys__joiner" aria-hidden="true">
              {shortcut.keyJoiner === "or" ? "or" : "+"}
            </span>
          )}
          <kbd>{key}</kbd>
        </React.Fragment>
      ))}
    </span>
  );
}

export default function KeyboardShortcutsDialog({
  open,
  onClose,
  reviewModeEnabled = true,
}) {
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const previousActiveElement = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.querySelector(FOCUSABLE_SELECTOR)?.focus?.();

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose?.();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousActiveElement?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="shortcuts-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <section
        className="shortcuts-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-dialog-title"
        aria-describedby="shortcuts-dialog-description"
        data-hotkey-exempt
        tabIndex={-1}
      >
        <header className="shortcuts-dialog__header">
          <div className="shortcuts-dialog__heading-mark" aria-hidden="true">
            ?
          </div>
          <div className="shortcuts-dialog__heading-copy">
            <h2 id="shortcuts-dialog-title">Keyboard shortcuts</h2>
            <p id="shortcuts-dialog-description">
              Browse, review, and organize large clip sets without breaking flow.
            </p>
          </div>
          <button
            type="button"
            className="shortcuts-dialog__icon-close"
            aria-label="Close keyboard shortcuts"
            title="Close"
            onClick={() => onClose?.()}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="shortcuts-dialog__body">
          <div className="shortcuts-dialog__grid">
            {HOTKEY_SECTIONS.map((section) => {
              const shortcuts = reviewModeEnabled || section.id !== "review"
                ? section.shortcuts
                : section.shortcuts.filter(
                    (shortcut) => ["rating", "clear-rating"].includes(shortcut.action)
                  );
              if (shortcuts.length === 0) return null;
              return (
                <section className="shortcut-group" key={section.id}>
                  <div className="shortcut-group__heading">
                    <h3>
                      {!reviewModeEnabled && section.id === "review"
                        ? "Rating"
                        : section.title}
                    </h3>
                    <p>
                      {!reviewModeEnabled && section.id === "review"
                        ? "Rate selected clips without showing the review workflow."
                        : section.description}
                    </p>
                  </div>
                  <dl className="shortcut-list">
                    {shortcuts.map((shortcut) => (
                      <div className="shortcut-row" key={shortcut.id}>
                        <dt>
                          <span className="shortcut-row__label">{shortcut.label}</span>
                          {shortcut.detail && (
                            <span className="shortcut-row__detail">{shortcut.detail}</span>
                          )}
                        </dt>
                        <dd>
                          <ShortcutKeys shortcut={shortcut} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              );
            })}
          </div>
        </div>

        <footer className="shortcuts-dialog__footer">
          <p>
            Shortcuts pause while you type in an input or use this guide.
          </p>
          <button
            type="button"
            className="shortcuts-dialog__done"
            onClick={() => onClose?.()}
          >
            Done
          </button>
        </footer>
      </section>
    </div>
  );
}
