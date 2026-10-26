import React, { useEffect, useMemo, useState } from "react";

// The Projects section of the Library panel (docs/architecture/projects.md).
// A project gathers clips for a piece of work; it does not describe them
// (that is what tags are for) and it does not order them (sequences do).

const PROJECT_NAME_LIMIT = 80;

const countLabel = (count) => {
  const value = Math.max(0, Number(count) || 0);
  return `${value.toLocaleString()} ${value === 1 ? "clip" : "clips"}`;
};

function ProjectNameForm({
  initialName = "",
  submitLabel,
  ariaLabel,
  disabled,
  onSubmit,
  onCancel,
}) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState(null);
  const submit = async (event) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await onSubmit?.(trimmed);
      setError(null);
    } catch (nextError) {
      setError(nextError?.message || "Could not save this name");
    }
  };
  return (
    <form className="library-saved-view-form library-project-form" onSubmit={submit}>
      <input
        value={name}
        onChange={(event) => setName(event.target.value.slice(0, PROJECT_NAME_LIMIT))}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel?.();
          }
        }}
        placeholder="Project name"
        aria-label={ariaLabel}
        aria-invalid={error ? "true" : undefined}
        title={error || undefined}
        maxLength={PROJECT_NAME_LIMIT}
        autoFocus
        onFocus={(event) => event.target.select()}
        disabled={disabled}
      />
      <button type="submit" disabled={disabled || !name.trim()}>
        {submitLabel}
      </button>
      {error ? (
        <p className="library-project-form__error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function ProjectRow({
  project,
  current,
  renaming,
  disabled,
  onOpen,
  onStartRename,
  onRename,
  onCancelRename,
  onSetArchived,
  onDelete,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  if (renaming) {
    return (
      <li className="library-project-list__item is-editing">
        <ProjectNameForm
          initialName={project.name}
          submitLabel="Rename"
          ariaLabel={`New name for ${project.name}`}
          disabled={disabled}
          onSubmit={(name) => onRename?.(project.id, name)}
          onCancel={onCancelRename}
        />
      </li>
    );
  }

  return (
    <li
      className={`library-project-list__item ${current ? "is-current" : ""} ${
        project.archived ? "is-archived" : ""
      }`}
    >
      <div className="library-project-list__row">
        <button
          type="button"
          className="library-saved-view-list__apply library-project-list__open"
          onClick={() => onOpen?.(project)}
          aria-current={current ? "location" : undefined}
          title={`Open ${project.name} from every library folder`}
          disabled={disabled}
        >
          <span aria-hidden="true">▤</span>
          <span className="library-saved-view-list__name">{project.name}</span>
          <span className="library-project-list__count">
            {countLabel(project.memberCount)}
          </span>
        </button>
        <button
          type="button"
          className="library-saved-view-list__delete library-project-list__more"
          onClick={() => {
            setMenuOpen((open) => !open);
            setConfirmingDelete(false);
          }}
          aria-label={`Actions for project ${project.name}`}
          aria-expanded={menuOpen}
          title="Project actions"
          disabled={disabled}
        >
          ⋯
        </button>
      </div>

      {menuOpen && !confirmingDelete ? (
        <div className="library-project-list__actions" role="group" aria-label={`${project.name} actions`}>
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              onStartRename?.(project.id);
            }}
            disabled={disabled}
          >
            Rename
          </button>
          <button
            type="button"
            onClick={async () => {
              setMenuOpen(false);
              await onSetArchived?.(project.id, !project.archived);
            }}
            disabled={disabled}
            title={
              project.archived
                ? "Return this project to the list"
                : "Hide this project from the list; its clips stay in it"
            }
          >
            {project.archived ? "Restore" : "Archive"}
          </button>
          <button
            type="button"
            className="is-dangerous"
            onClick={() => setConfirmingDelete(true)}
            disabled={disabled}
          >
            Delete
          </button>
        </div>
      ) : null}

      {confirmingDelete ? (
        <div className="library-project-list__confirm" role="alertdialog" aria-label={`Delete ${project.name}`}>
          <span>Delete “{project.name}”? The clips themselves are not touched.</span>
          <div>
            <button
              type="button"
              className="is-dangerous"
              onClick={async () => {
                setConfirmingDelete(false);
                setMenuOpen(false);
                await onDelete?.(project.id, project);
              }}
              disabled={disabled}
            >
              Delete project
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmingDelete(false);
                setMenuOpen(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export default function ProjectsSection({
  projects = [],
  activeProjectId = null,
  renamingProjectId = null,
  onOpenProject,
  onCreateProject,
  onRenameProject,
  onSetProjectArchived,
  onDeleteProject,
  onRenamingProjectChange,
  disabled = false,
}) {
  const [isNaming, setNaming] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const { active, archived } = useMemo(() => {
    const list = Array.isArray(projects) ? projects : [];
    return {
      active: list.filter((project) => !project.archived),
      archived: list.filter((project) => project.archived),
    };
  }, [projects]);

  // Keep the rename field reachable when the project being renamed is
  // archived and the archive is collapsed.
  useEffect(() => {
    if (
      renamingProjectId != null &&
      archived.some((project) => project.id === renamingProjectId)
    ) {
      setShowArchived(true);
    }
  }, [archived, renamingProjectId]);

  const renderRow = (project) => (
    <ProjectRow
      key={project.id}
      project={project}
      current={project.id === activeProjectId}
      renaming={project.id === renamingProjectId}
      disabled={disabled}
      onOpen={onOpenProject}
      onStartRename={(id) => onRenamingProjectChange?.(id)}
      onCancelRename={() => onRenamingProjectChange?.(null)}
      onRename={async (id, name) => {
        await onRenameProject?.(id, name);
        onRenamingProjectChange?.(null);
      }}
      onSetArchived={onSetProjectArchived}
      onDelete={onDeleteProject}
    />
  );

  return (
    <section className="library-sidebar__section library-sidebar__section--projects">
      <header className="library-sidebar__section-header">
        <div>
          <span className="library-sidebar__eyebrow">Hand-picked groups</span>
          <h2>Projects</h2>
        </div>
        <button
          type="button"
          className="library-sidebar__add-view"
          onClick={() => setNaming((open) => !open)}
          aria-label="New project"
          aria-expanded={isNaming}
          disabled={disabled || typeof onCreateProject !== "function"}
          title="New project. Add clips to it from their right-click menu."
        >
          +
        </button>
      </header>

      {isNaming ? (
        <ProjectNameForm
          submitLabel="Create"
          ariaLabel="New project name"
          disabled={disabled}
          onSubmit={async (name) => {
            await onCreateProject?.(name);
            setNaming(false);
          }}
          onCancel={() => setNaming(false)}
        />
      ) : null}

      {active.length ? (
        <ul className="library-saved-view-list library-project-list">
          {active.map(renderRow)}
        </ul>
      ) : (
        <p className="library-sidebar__empty">
          Group clips made for one piece of work. Right-click clips and choose
          Project to start one.
        </p>
      )}

      {archived.length ? (
        <>
          <button
            type="button"
            className="library-project-list__archive-toggle"
            onClick={() => setShowArchived((open) => !open)}
            aria-expanded={showArchived}
          >
            {showArchived ? "Hide archived" : "Show archived"} ({archived.length.toLocaleString()})
          </button>
          {showArchived ? (
            <ul
              className="library-saved-view-list library-project-list library-project-list--archived"
              aria-label="Archived projects"
            >
              {archived.map(renderRow)}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
