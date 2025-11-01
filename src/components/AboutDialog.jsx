import React, { useEffect, useRef } from "react";
import SupportLink from "./SupportLink";
import { supportContent } from "../config/supportContent";

export default function AboutDialog({ open, onClose }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        onClose?.();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const previousActiveElement = document.activeElement;
    const firstFocusable = dialogRef.current?.querySelector(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    firstFocusable?.focus?.();
    return () => {
      previousActiveElement?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="about-dialog-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose?.();
        }
      }}
    >
      <div
        className="about-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-dialog__title"
        ref={dialogRef}
      >
        <header className="about-dialog__header">
          <h2 id="about-dialog__title">About VideoSwarm</h2>
        </header>
        <div className="about-dialog__body">
          <p className="about-dialog__intro">{supportContent.donationBlurb}</p>
          <SupportLink
            className="donate-button donate-button--dialog"
            title={supportContent.donationTooltip}
          >
            <span aria-hidden="true" className="donate-button__icon">
              ❤️
            </span>
            <span className="donate-button__label">
              {supportContent.donationButtonLabel}
            </span>
          </SupportLink>
          <div className="about-dialog__credits">
            <h3>Credits</h3>
            <ul>
              {supportContent.credits.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
        <footer className="about-dialog__footer">
          <button
            type="button"
            className="about-dialog__close"
            onClick={() => onClose?.()}
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
