import React, { useCallback, useEffect, useRef, useState } from "react";
import { normalizePlaybackMode } from "../../playback/playbackPolicy";
import {
  MODE_DESCRIPTIONS,
  PLAYBACK_MODE_OPTIONS,
} from "../../playback/playbackModeDescriptions";
import "./PreferencesDialog.css";

// Settings that are set once and rarely revisited (UX redesign D8). Daily
// toggles stay in the top bar's View menu; playback appears in both, with
// the longer explanations here. A future section (the re-render engine's
// own settings) is one more entry in PREFERENCE_SECTIONS.
export const PREFERENCE_SECTIONS = Object.freeze([
  { id: "playback", label: "Playback" },
  { id: "profiles", label: "Profiles" },
  { id: "data", label: "Data location" },
  { id: "comfy", label: "ComfyUI" },
]);

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

// ipcRenderer.invoke wraps a handler's error as "Error invoking remote
// method '<channel>': <Name>: <message>"; show only the message.
export function ipcErrorMessage(error) {
  const text = String(error?.message || error || "Something went wrong");
  return text
    .replace(/^Error invoking remote method '[^']*': /u, "")
    .replace(/^[A-Za-z]*Error: /u, "");
}

function Status({ status }) {
  if (!status) return null;
  return (
    <p
      className={`preferences__status preferences__status--${status.type}`}
      role={status.type === "error" ? "alert" : "status"}
    >
      {status.text}
    </p>
  );
}

function PlaybackSection({
  playbackMode,
  onPlaybackModeChange,
  proxyPlaybackEnabled,
  proxyPlaybackAvailable,
  onProxyPlaybackToggle,
  hoverAudioEnabled,
  onHoverAudioToggle,
  playbackDetailsVisible,
  onPlaybackDetailsToggle,
  playbackCapabilityStatus,
}) {
  const activeMode = normalizePlaybackMode(playbackMode);
  return (
    <>
      <fieldset className="preferences__group">
        <legend>Grid playback</legend>
        {PLAYBACK_MODE_OPTIONS.map((option) => (
          <label key={option.value} className="preferences__choice">
            <input
              type="radio"
              name="preferences-playback-mode"
              value={option.value}
              checked={activeMode === option.value}
              onChange={() => onPlaybackModeChange?.(option.value)}
            />
            <span>
              <span className="preferences__choice-label">{option.label}</span>
              <span className="preferences__hint">{MODE_DESCRIPTIONS[option.value]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="preferences__group">
        <legend>Options</legend>
        <label className="preferences__choice">
          <input
            type="checkbox"
            checked={Boolean(proxyPlaybackEnabled)}
            disabled={!proxyPlaybackAvailable}
            onChange={() => onProxyPlaybackToggle?.()}
          />
          <span>
            <span className="preferences__choice-label">Playback proxies (720p)</span>
            <span className="preferences__hint">
              {proxyPlaybackAvailable
                ? "Plays large clips from a smaller cached copy, so more of them can play at once."
                : "Needs FFmpeg, which was not found on this computer."}
            </span>
          </span>
        </label>
        <label className="preferences__choice">
          <input
            type="checkbox"
            checked={Boolean(hoverAudioEnabled)}
            onChange={() => onHoverAudioToggle?.()}
          />
          <span>
            <span className="preferences__choice-label">Play audio on hover</span>
            <span className="preferences__hint">Unmutes the clip under the pointer.</span>
          </span>
        </label>
        <label className="preferences__choice">
          <input
            type="checkbox"
            checked={Boolean(playbackDetailsVisible)}
            onChange={() => onPlaybackDetailsToggle?.()}
          />
          <span>
            <span className="preferences__choice-label">Playback details in the status line</span>
            <span className="preferences__hint">Decoder budget, loading and memory, for tuning playback.</span>
          </span>
        </label>
      </fieldset>
      {playbackCapabilityStatus ? (
        <p className="preferences__note">{playbackCapabilityStatus}</p>
      ) : null}
    </>
  );
}

function ProfilesSection({ active }) {
  const api = window.electronAPI?.profiles;
  const [profiles, setProfiles] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [newName, setNewName] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);

  const applyList = useCallback((result) => {
    if (!result) return;
    const list = Array.isArray(result.profiles) ? result.profiles : [];
    const nextActive = result.activeProfileId ?? result.profileId ?? null;
    setProfiles(list);
    setActiveId(nextActive);
    setRenameValue(list.find((profile) => profile.id === nextActive)?.name || "");
  }, []);

  const reload = useCallback(async () => {
    try {
      applyList(await api?.list?.());
    } catch (error) {
      setStatus({ type: "error", text: ipcErrorMessage(error) });
    }
  }, [api, applyList]);

  useEffect(() => {
    if (!active) return undefined;
    void reload();
    const unsubscribe = api?.onChanged?.(() => void reload());
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [active, api, reload]);

  const run = async (action, success) => {
    setBusy(true);
    setStatus(null);
    try {
      const result = await action();
      if (result?.success === false) {
        if (!result.cancelled) {
          setStatus({ type: "error", text: result.error || "That did not work." });
        }
      } else if (success) {
        setStatus({ type: "success", text: success });
      }
      await reload();
      return result;
    } catch (error) {
      setStatus({ type: "error", text: ipcErrorMessage(error) });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const activeProfile = profiles.find((profile) => profile.id === activeId);

  return (
    <>
      <p className="preferences__intro">
        Each profile keeps its own tags, ratings, review sessions, pinned folders and
        settings. Switching reloads the app&apos;s data for that profile.
      </p>
      <ul className="preferences__profiles" aria-label="Profiles">
        {profiles.map((profile) => {
          const isActive = profile.id === activeId;
          return (
            <li key={profile.id} className="preferences__profile">
              <span className="preferences__profile-name">{profile.name}</span>
              {isActive ? (
                <span className="preferences__badge">Active</span>
              ) : (
                <button
                  type="button"
                  className="preferences__button"
                  disabled={busy}
                  onClick={() => run(() => api.setActive(profile.id), `Switched to ${profile.name}.`)}
                >
                  Switch
                </button>
              )}
              <button
                type="button"
                className="preferences__button preferences__button--quiet"
                aria-label={`Delete profile ${profile.name}`}
                disabled={busy || profiles.length < 2}
                title={profiles.length < 2 ? "The only profile cannot be deleted" : "Asks before deleting"}
                onClick={() => run(() => api.delete(profile.id))}
              >
                Delete…
              </button>
            </li>
          );
        })}
      </ul>
      {activeProfile ? (
        <form
          className="preferences__row"
          onSubmit={(event) => {
            event.preventDefault();
            const name = renameValue.trim();
            if (!name || name === activeProfile.name) return;
            void run(() => api.rename(activeProfile.id, name), "Renamed.");
          }}
        >
          <label className="preferences__field">
            <span>Name of the active profile</span>
            <input
              type="text"
              value={renameValue}
              maxLength={128}
              onChange={(event) => setRenameValue(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="preferences__button"
            disabled={busy || !renameValue.trim() || renameValue.trim() === activeProfile.name}
          >
            Rename
          </button>
        </form>
      ) : null}
      <form
        className="preferences__row"
        onSubmit={(event) => {
          event.preventDefault();
          const name = newName.trim();
          if (!name) return;
          void run(() => api.create(name), `Created and switched to ${name}.`).then((result) => {
            if (result?.success !== false) setNewName("");
          });
        }}
      >
        <label className="preferences__field">
          <span>New profile</span>
          <input
            type="text"
            value={newName}
            maxLength={128}
            placeholder="Name"
            onChange={(event) => setNewName(event.target.value)}
          />
        </label>
        <button type="submit" className="preferences__button" disabled={busy || !newName.trim()}>
          Create and switch
        </button>
      </form>
      <Status status={status} />
    </>
  );
}

function DataLocationSection({ active, dataLocationOpen, onOpenDataLocation }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!active || dataLocationOpen) return undefined;
    let alive = true;
    window.electronAPI?.dataLocation
      ?.getState?.()
      .then((next) => {
        if (alive) setState(next || null);
      })
      .catch((failure) => {
        if (alive) setError(ipcErrorMessage(failure));
      });
    return () => {
      alive = false;
    };
  }, [active, dataLocationOpen]);

  return (
    <>
      <p className="preferences__intro">
        Where Video Swarm keeps its databases, settings and caches for every profile.
      </p>
      <dl className="preferences__facts">
        <dt>In use</dt>
        <dd className="preferences__path">{state?.effectivePath || "—"}</dd>
        {state?.defaultPath && state.defaultPath !== state.effectivePath ? (
          <>
            <dt>Default</dt>
            <dd className="preferences__path">{state.defaultPath}</dd>
          </>
        ) : null}
      </dl>
      {state?.isCommandLineOverride ? (
        <p className="preferences__note">Set on the command line for this session.</p>
      ) : null}
      <div className="preferences__actions">
        <button type="button" className="preferences__button" onClick={() => onOpenDataLocation?.()}>
          Change data location…
        </button>
      </div>
      <Status status={error ? { type: "error", text: error } : null} />
    </>
  );
}

function describeTest(result) {
  if (!result.ok) return { type: "error", text: result.message || "ComfyUI did not answer." };
  const running = Number(result.running) || 0;
  const pending = Number(result.pending) || 0;
  const load = running || pending ? `${running} running, ${pending} waiting` : "idle";
  return { type: "success", text: `ComfyUI answered at ${result.url} (${load}). Nothing was sent.` };
}

function ComfySection({ active }) {
  const api = window.electronAPI?.comfyQueue;
  const [saved, setSaved] = useState(null);
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);

  const apply = useCallback((connection) => {
    setSaved(connection);
    setEnabled(connection?.enabled === true);
    setUrl(connection?.url || "");
    setOutputDir(connection?.outputDir || "");
  }, []);

  useEffect(() => {
    if (!active || !api) return undefined;
    let alive = true;
    api
      .getConnection()
      .then((connection) => {
        if (alive) apply(connection);
      })
      .catch((error) => {
        if (alive) setStatus({ type: "error", text: ipcErrorMessage(error) });
      });
    return () => {
      alive = false;
    };
  }, [active, api, apply]);

  if (!api) {
    return <p className="preferences__intro">ComfyUI re-rendering is not available in this build.</p>;
  }

  const dirty =
    saved &&
    (enabled !== (saved.enabled === true) ||
      url !== (saved.url || "") ||
      outputDir !== (saved.outputDir || ""));

  const perform = async (action) => {
    setBusy(true);
    setStatus(null);
    try {
      await action();
    } catch (error) {
      setStatus({ type: "error", text: ipcErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="preferences__form"
      onSubmit={(event) => {
        event.preventDefault();
        void perform(async () => {
          const next = await api.setConnection({ enabled, url, outputDir: outputDir || null });
          apply(next);
          setStatus({
            type: "success",
            text: next.enabled ? "Saved. Re-rendering is on." : "Saved. Re-rendering is off.",
          });
        });
      }}
    >
      <p className="preferences__intro">
        Re-render drafts at quality settings through a ComfyUI running on this computer. Off by
        default; only local addresses (localhost, 127.0.0.1, [::1]) are accepted, never the internet.
      </p>
      <label className="preferences__choice">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        <span>
          <span className="preferences__choice-label">Connect to ComfyUI</span>
          <span className="preferences__hint">
            While a queue is rendering, closing the window keeps Video Swarm in the system tray.
          </span>
        </span>
      </label>
      <label className="preferences__field">
        <span>Address</span>
        <input
          type="text"
          value={url}
          spellCheck={false}
          placeholder="http://127.0.0.1:8188"
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <div className="preferences__row">
        <label className="preferences__field">
          <span>ComfyUI&apos;s output folder</span>
          <input
            type="text"
            value={outputDir}
            spellCheck={false}
            placeholder="Needed to save finals beside their drafts"
            onChange={(event) => setOutputDir(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="preferences__button"
          disabled={busy}
          onClick={() =>
            perform(async () => {
              const result = await api.chooseOutputDir?.();
              if (result && !result.canceled && result.path) setOutputDir(result.path);
            })
          }
        >
          Browse…
        </button>
      </div>
      <div className="preferences__actions">
        <button
          type="button"
          className="preferences__button"
          disabled={busy || !url.trim()}
          onClick={() => perform(async () => setStatus(describeTest(await api.testConnection(url))))}
        >
          Test connection
        </button>
        <button type="submit" className="preferences__button preferences__button--primary" disabled={busy || !dirty}>
          Save
        </button>
      </div>
      <Status status={status} />
    </form>
  );
}

export default function PreferencesDialog({
  open,
  onClose,
  initialSection = "playback",
  suspended = false,
  dataLocationOpen = false,
  onOpenDataLocation,
  ...playbackProps
}) {
  const dialogRef = useRef(null);
  const [section, setSection] = useState(initialSection);

  useEffect(() => {
    if (open) setSection(initialSection);
  }, [open, initialSection]);

  useEffect(() => {
    if (!open) return undefined;
    const previousActiveElement = document.activeElement;
    dialogRef.current?.querySelector('[role="tab"][aria-selected="true"]')?.focus?.();
    return () => {
      previousActiveElement?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open || suspended) return undefined;
    const dialog = dialogRef.current;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose?.();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;
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
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, suspended, onClose]);

  if (!open) return null;

  const onTabKeyDown = (event) => {
    const index = PREFERENCE_SECTIONS.findIndex((entry) => entry.id === section);
    let next = null;
    if (event.key === "ArrowDown") next = PREFERENCE_SECTIONS[(index + 1) % PREFERENCE_SECTIONS.length];
    if (event.key === "ArrowUp") {
      next = PREFERENCE_SECTIONS[(index - 1 + PREFERENCE_SECTIONS.length) % PREFERENCE_SECTIONS.length];
    }
    if (event.key === "Home") next = PREFERENCE_SECTIONS[0];
    if (event.key === "End") next = PREFERENCE_SECTIONS[PREFERENCE_SECTIONS.length - 1];
    if (!next) return;
    event.preventDefault();
    setSection(next.id);
    dialogRef.current?.querySelector(`#preferences-tab-${next.id}`)?.focus?.();
  };

  return (
    <div
      className="preferences-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !suspended) onClose?.();
      }}
    >
      <section
        className="preferences"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="preferences-title"
        data-hotkey-exempt
        tabIndex={-1}
      >
        <header className="preferences__header">
          <h2 id="preferences-title">Preferences</h2>
          <button
            type="button"
            className="preferences__close"
            aria-label="Close preferences"
            title="Close"
            onClick={() => onClose?.()}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="preferences__layout">
          <div className="preferences__tabs" role="tablist" aria-orientation="vertical" aria-label="Preferences sections">
            {PREFERENCE_SECTIONS.map((entry) => (
              <button
                key={entry.id}
                id={`preferences-tab-${entry.id}`}
                type="button"
                role="tab"
                aria-selected={section === entry.id}
                aria-controls={`preferences-panel-${entry.id}`}
                tabIndex={section === entry.id ? 0 : -1}
                className="preferences__tab"
                onClick={() => setSection(entry.id)}
                onKeyDown={onTabKeyDown}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <div
            className="preferences__panel"
            role="tabpanel"
            id={`preferences-panel-${section}`}
            aria-labelledby={`preferences-tab-${section}`}
          >
            {section === "playback" ? <PlaybackSection {...playbackProps} /> : null}
            {section === "profiles" ? <ProfilesSection active /> : null}
            {section === "data" ? (
              <DataLocationSection
                active
                dataLocationOpen={dataLocationOpen}
                onOpenDataLocation={onOpenDataLocation}
              />
            ) : null}
            {section === "comfy" ? <ComfySection active /> : null}
          </div>
        </div>
      </section>
    </div>
  );
}
