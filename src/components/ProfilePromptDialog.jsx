import React, { useEffect, useRef } from "react";

function ProfilePromptDialog({ request, value, onChange, onSubmit, onCancel }) {
  const inputRef = useRef(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    if (typeof input.select === "function") {
      input.select();
    }
  }, [request?.requestId]);

  const handleSubmit = (event) => {
    event.preventDefault();
    if (typeof onSubmit === "function") {
      onSubmit(value ?? "");
    }
  };

  const handleKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (typeof onCancel === "function") {
        onCancel();
      }
    }
  };

  return (
    <div
      className="profile-prompt-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="profile-prompt-title"
    >
      <div className="profile-prompt-dialog">
        <form onSubmit={handleSubmit} className="profile-prompt-form">
          <header className="profile-prompt-header">
            <h2 id="profile-prompt-title">{request?.title || "Profile"}</h2>
            {request?.message ? (
              <p className="profile-prompt-message">{request.message}</p>
            ) : null}
          </header>

          <div className="profile-prompt-body">
            <label className="profile-prompt-label" htmlFor="profile-prompt-input">
              Profile name
            </label>
            <input
              id="profile-prompt-input"
              ref={inputRef}
              value={value}
              onChange={(event) => onChange?.(event.target.value)}
              className="profile-prompt-input"
              type="text"
              placeholder="Enter profile name"
              onKeyDown={handleKeyDown}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <footer className="profile-prompt-footer">
            <button
              type="button"
              className="profile-prompt-button profile-prompt-button--secondary"
              onClick={() => onCancel?.()}
            >
              Cancel
            </button>
            <button type="submit" className="profile-prompt-button profile-prompt-button--primary">
              Save
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

export default ProfilePromptDialog;
