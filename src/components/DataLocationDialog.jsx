import React, { useEffect, useMemo, useRef, useState } from "react";

function normalize(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function buildMessage(type, text) {
  if (!text) return null;
  return { type, text };
}

export default function DataLocationDialog({ open, onClose }) {
  const dialogRef = useRef(null);
  const [state, setState] = useState(null);
  const [mode, setMode] = useState("default");
  const [customPath, setCustomPath] = useState("");
  const [statusMessage, setStatusMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  const overrideActive = !!state?.isCommandLineOverride;
  const portablePreset = state?.portablePresetPath || "";
  const effectivePath = state?.effectivePath || "";
  const defaultPath = state?.defaultPath || "";
  const effectivePathUnavailable = !!state?.effectivePathUnavailable;

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
    if (!open) return undefined;
    const previousActiveElement = document.activeElement;
    const firstFocusable = dialogRef.current?.querySelector(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    firstFocusable?.focus?.();
    return () => {
      previousActiveElement?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    let alive = true;
    setBusy(false);
    setStatusMessage(null);
    const loadState = async () => {
      try {
        const api = window.electronAPI?.dataLocation;
        const nextState = await api?.getState?.();
        if (!alive) return;
        setState(nextState || null);
        const useDefault = !!nextState?.isUsingDefault;
        setMode(useDefault ? "default" : "custom");
        if (useDefault) {
          setCustomPath("");
        } else {
          setCustomPath(nextState?.preferredPath || nextState?.effectivePath || "");
        }
      } catch (error) {
        if (!alive) return;
        setStatusMessage(
          buildMessage("error", error?.message || "Unable to load data location state.")
        );
      }
    };
    loadState();
    return () => {
      alive = false;
    };
  }, [open]);

  const trimmedCustomPath = useMemo(() => normalize(customPath), [customPath]);

  const hasChanges = useMemo(() => {
    if (!state) return false;
    if (mode === "default") {
      return !state.isUsingDefault;
    }
    if (!trimmedCustomPath) {
      return false;
    }
    const currentPreferred = normalize(state.preferredPath);
    return currentPreferred !== trimmedCustomPath;
  }, [state, mode, trimmedCustomPath]);

  const handleBrowse = async () => {
    if (overrideActive || busy) return;
    try {
      const api = window.electronAPI?.dataLocation;
      const result = await api?.browse?.();
      if (result) {
        setMode("custom");
        setCustomPath(result);
        setStatusMessage(null);
      }
    } catch (error) {
      setStatusMessage(
        buildMessage("error", error?.message || "Unable to select folder.")
      );
    }
  };

  const handlePortable = () => {
    if (!portablePreset || overrideActive || busy) return;
    setMode("custom");
    setCustomPath(portablePreset);
    setStatusMessage(null);
  };

  const handleApply = async () => {
    if (!state || overrideActive || busy) {
      return;
    }
    if (!hasChanges) {
      onClose?.();
      return;
    }
    if (mode === "custom" && !trimmedCustomPath) {
      setStatusMessage(buildMessage("error", "Select a folder for custom data."));
      return;
    }

    try {
      setBusy(true);
      const api = window.electronAPI?.dataLocation;
      const result = await api?.applySelection?.({
        useDefault: mode === "default",
        customPath: trimmedCustomPath,
      });
      switch (result?.status) {
        case "unchanged":
          onClose?.();
          break;
        case "cancelled":
          setBusy(false);
          break;
        case "invalid":
          setBusy(false);
          if (result?.reason === "missing-custom-path") {
            setStatusMessage(
              buildMessage("error", "Select a folder before applying the change.")
            );
          } else if (result?.reason === "unwritable") {
            setStatusMessage(
              buildMessage(
                "error",
                "VideoSwarm cannot write to the selected folder. Choose another location."
              )
            );
          } else {
            setStatusMessage(
              buildMessage("error", "Unable to use the selected folder.")
            );
          }
          break;
        case "overridden":
          setBusy(false);
          setStatusMessage(
            buildMessage(
              "warning",
              "Data location is controlled by the '--user-data-dir' command-line option."
            )
          );
          break;
        case "relaunching":
          setStatusMessage(buildMessage("info", "VideoSwarm is restarting..."));
          break;
        default:
          onClose?.();
          break;
      }
    } catch (error) {
      setBusy(false);
      setStatusMessage(
        buildMessage("error", error?.message || "Failed to apply the new data folder.")
      );
    }
  };

  if (!open) return null;

  const shouldShowDefaultPathHint =
    !!defaultPath && state && !state.isUsingDefault;

  return (
    <div
      className="data-location-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) {
          onClose?.();
        }
      }}
    >
      <div
        className="data-location-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="data-location-dialog__title"
        ref={dialogRef}
      >
        <header className="data-location-dialog__header">
          <h2 id="data-location-dialog__title">Data Location</h2>
        </header>
        <div className="data-location-dialog__body">
          {overrideActive ? (
            <div className="data-location-banner data-location-banner--warning">
              Data location is controlled by the '--user-data-dir' command-line option.
            </div>
          ) : null}

          <div className="data-location-current">
            <span className="data-location-current__label">Current data folder:</span>
            <code className="data-location-current__value">{effectivePath}</code>
            <p className="data-location-current__hint">
              Includes profiles, thumbnails, metadata database, cache, and logs.
            </p>
            {effectivePathUnavailable ? (
              <div className="data-location-current__warning">
                <span
                  className="data-location-current__warning-icon"
                  aria-hidden="true"
                />
                <span className="data-location-current__warning-text">
                  VideoSwarm cannot currently access this folder. Check that the drive
                  or network location is available.
                </span>
              </div>
            ) : null}
          </div>

          <fieldset
            className="data-location-options"
            disabled={overrideActive || busy || !state}
          >
            <label className="data-location-option">
              <input
                type="radio"
                name="data-location-mode"
                value="default"
                checked={mode === "default"}
                onChange={() => {
                  setMode("default");
                  setStatusMessage(null);
                }}
              />
              <div className="data-location-option__content">
                <div className="data-location-option__title">
                  Use default system location
                </div>
                <div className="data-location-option__description">
                  {shouldShowDefaultPathHint ? (
                    <>
                      Stores data in:
                      <code className="data-location-option__path">{defaultPath}</code>
                    </>
                  ) : (
                    "Stores data in your OS user profile."
                  )}
                </div>
              </div>
            </label>

            <div
              className="data-location-options__divider"
              role="separator"
              aria-hidden="true"
            />

            <label className="data-location-option data-location-option--custom">
              <input
                type="radio"
                name="data-location-mode"
                value="custom"
                checked={mode === "custom"}
                onChange={() => {
                  setMode("custom");
                  setStatusMessage(null);
                }}
              />
              <div className="data-location-option__content">
                <div className="data-location-option__title">Use custom folder</div>
                <div className="data-location-option__description">
                  <input
                    type="text"
                    className="data-location-input"
                    value={trimmedCustomPath}
                    readOnly
                    placeholder="Choose a folder"
                  />
                  <div className="data-location-actions">
                    <button
                      type="button"
                      className="data-location-button"
                      onClick={handleBrowse}
                      disabled={overrideActive || busy}
                    >
                      Browse…
                    </button>
                    <button
                      type="button"
                      className="data-location-button"
                      onClick={handlePortable}
                      disabled={overrideActive || busy || !portablePreset}
                    >
                      Set to app folder (portable mode)
                    </button>
                  </div>
                </div>
              </div>
            </label>
          </fieldset>

          <p className="data-location-hint-global">
            Changes to the data location take effect after restart.
          </p>

          {statusMessage ? (
            <div
              className={`data-location-status data-location-status--${statusMessage.type}`}
              role="status"
            >
              {statusMessage.text}
            </div>
          ) : null}
        </div>
        <footer className="data-location-dialog__footer">
          <button
            type="button"
            className="data-location-button data-location-button--secondary"
            onClick={() => {
              if (!busy) {
                onClose?.();
              }
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="data-location-button data-location-button--primary"
            onClick={handleApply}
            disabled={
              overrideActive ||
              busy ||
              !state ||
              !hasChanges ||
              (mode === "custom" && !trimmedCustomPath)
            }
          >
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}
