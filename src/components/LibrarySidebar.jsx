import React, { memo, useState } from "react";
import { normalizeRelativePath } from "../library/folderModel";
import "./LibraryNavigation.css";

const normalizeExpandedPaths = (paths) =>
  paths instanceof Set ? paths : new Set(paths || []);

const rootPathOf = (root) => root?.rootPath || root?.path || "";
const rootLabelOf = (root) =>
  root?.label || root?.name || rootPathOf(root).split(/[\\/]/).filter(Boolean).at(-1) || "Root";

const rootReviewStateOf = (states, rootPath) => {
  if (!rootPath || !states) return null;
  if (states instanceof Map) return states.get(rootPath) ?? null;
  return states[rootPath] ?? null;
};

const remainingLabel = (remaining) =>
  remaining === null
    ? "Review count unavailable"
    : `${remaining.toLocaleString()} unreviewed`;

const RootReviewSummary = memo(function RootReviewSummary({
  root,
  state,
  disabled,
  onStartRootReview,
  onContinueRootReview,
}) {
  if (!state) return null;

  const rootPath = rootPathOf(root);
  const rootLabel = rootLabelOf(root);
  const parsedRemaining = Number(state.remainingUnreviewed);
  const remaining = state.remainingUnreviewed === null ||
    state.remainingUnreviewed === undefined ||
    !Number.isFinite(parsedRemaining)
    ? null
    : Math.max(0, Math.floor(parsedRemaining));
  const action = ["start", "continue", "complete"].includes(state.action)
    ? state.action
    : null;
  const actionDisabled = disabled || Boolean(state.disabled);
  const actionLabel = action === "continue" ? "Continue review" : "Start review";
  const accessibleCount = remaining === null
    ? "review count unavailable"
    : `${remaining.toLocaleString()} unreviewed`;
  const countTooltip =
    "Counts are file instances. Reviewing duplicate content may reduce the count by more than one.";

  const invokeAction = () => {
    if (action === "continue") onContinueRootReview?.(rootPath, root);
    if (action === "start") onStartRootReview?.(rootPath, root);
  };

  return (
    <div
      className="library-root-list__review"
      aria-busy={state.isUpdating || undefined}
    >
      <span
        className="library-root-list__unreviewed"
        title={countTooltip}
      >
        {remainingLabel(remaining)}
        {state.isUpdating ? (
          <span className="library-root-list__updating"> · Updating…</span>
        ) : null}
      </span>
      {action === "complete" ? (
        <span
          className="library-root-list__review-complete"
          role="status"
          aria-label={`${rootLabel}: Review complete${
            state.isUpdating ? "; updating" : ""
          }`}
        >
          Review complete
        </span>
      ) : action ? (
        <button
          type="button"
          className="library-root-list__review-action"
          disabled={
            actionDisabled ||
            (action === "start"
              ? typeof onStartRootReview !== "function"
              : typeof onContinueRootReview !== "function")
          }
          onClick={invokeAction}
          aria-label={`${actionLabel} ${rootLabel}, ${accessibleCount}`}
          title={`${actionLabel} in ${rootLabel} (${accessibleCount})`}
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
});

const FolderTreeRow = memo(function FolderTreeRow({
  node,
  depth,
  currentPath,
  expandedPaths,
  onToggleExpanded,
  onSelectFolder,
  disabled,
}) {
  const path = normalizeRelativePath(node?.path ?? node?.relativePath);
  const children = Array.isArray(node?.children) ? node.children : [];
  const hasChildren = children.length > 0;
  const expanded = hasChildren && expandedPaths.has(path);
  const selected = normalizeRelativePath(currentPath) === path;
  const matchingCount = Math.max(0, Number(node?.matchingCount) || 0);
  const reviewedCount = Math.max(0, Number(node?.reviewedCount) || 0);
  const videoCount = Math.max(0, Number(node?.videoCount) || 0);
  const missingCount = Math.max(0, Number(node?.missingCount) || 0);

  return (
    <li
      className="library-folder-tree__item"
      role="treeitem"
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={selected}
    >
      <div
        className={`library-folder-tree__row ${selected ? "is-current" : ""}`}
        style={{ "--folder-depth": depth }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="library-folder-tree__expand"
            onClick={() => onToggleExpanded?.(path, !expanded)}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${node?.name || "folder"}`}
            disabled={disabled}
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="library-folder-tree__expand-spacer" aria-hidden="true" />
        )}

        <button
          type="button"
          className="library-folder-tree__select"
          onClick={() => onSelectFolder?.(path, node)}
          aria-current={selected ? "location" : undefined}
          title={path || node?.name || "Root"}
          disabled={disabled}
        >
          <span className="library-folder-tree__name">
            <span aria-hidden="true">{hasChildren ? "▰" : "▱"}</span>
            <span>{node?.name || (path ? path.split("/").at(-1) : "Root")}</span>
          </span>
          <span className="library-folder-tree__badges">
            <span
              className="library-folder-tree__match-count"
              title={`${matchingCount} videos match the active filters`}
            >
              {matchingCount.toLocaleString()} match
            </span>
            <span
              className="library-folder-tree__review-count"
              title={`${reviewedCount} of ${videoCount} videos reviewed`}
            >
              {reviewedCount.toLocaleString()}/{videoCount.toLocaleString()}
            </span>
            {missingCount > 0 ? (
              <span
                className="library-folder-tree__missing-count"
                title={`${missingCount} indexed video${missingCount === 1 ? " is" : "s are"} missing`}
              >
                {missingCount.toLocaleString()} missing
              </span>
            ) : null}
          </span>
        </button>
      </div>

      {expanded ? (
        <ul role="group" className="library-folder-tree__group">
          {children.map((child) => (
            <FolderTreeRow
              key={child?.path ?? child?.relativePath ?? child?.name}
              node={child}
              depth={depth + 1}
              currentPath={currentPath}
              expandedPaths={expandedPaths}
              onToggleExpanded={onToggleExpanded}
              onSelectFolder={onSelectFolder}
              disabled={disabled}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
});

function LibrarySidebar({
  tree = null,
  currentPath = "",
  expandedPaths = new Set([""]),
  onToggleExpanded,
  onSelectFolder,
  pinnedRoots = [],
  currentRoot = null,
  onOpenRoot,
  onTogglePin,
  rootReviewStateByPath = null,
  onStartRootReview,
  onContinueRootReview,
  savedViews = [],
  onApplySavedView,
  onSaveCurrentView,
  onDeleteSavedView,
  smartViewsEnabled = true,
  disabled = false,
}) {
  const roots = Array.isArray(tree) ? tree : tree ? [tree] : [];
  const expanded = normalizeExpandedPaths(expandedPaths);
  const currentRootPath = rootPathOf(currentRoot);
  const currentRootPinned = Boolean(currentRoot?.pinned);
  const [isNamingView, setNamingView] = useState(false);
  const [viewName, setViewName] = useState("");

  const submitSavedView = async (event) => {
    event.preventDefault();
    const name = viewName.trim();
    if (!name || typeof onSaveCurrentView !== "function") return;
    try {
      await onSaveCurrentView(name);
      setViewName("");
      setNamingView(false);
    } catch {}
  };

  return (
    <aside className="library-sidebar" aria-label="Library and folders">
      <section className="library-sidebar__section library-sidebar__section--roots">
        <header className="library-sidebar__section-header">
          <div>
            <span className="library-sidebar__eyebrow">Library</span>
            <h2>Pinned roots</h2>
          </div>
          {currentRootPath ? (
            <button
              type="button"
              className={`library-sidebar__pin-current ${
                currentRootPinned ? "is-active" : ""
              }`}
              onClick={() => onTogglePin?.(currentRootPath, !currentRootPinned)}
              aria-label={
                currentRootPinned ? "Unpin current library root" : "Pin current library root"
              }
              aria-pressed={currentRootPinned}
              disabled={disabled}
              title={
                currentRootPinned ? "Unpin current root" : "Pin current root"
              }
            >
              {currentRootPinned ? "★" : "☆"}
            </button>
          ) : null}
        </header>

        {pinnedRoots.length ? (
          <ul className="library-root-list">
            {pinnedRoots.map((root) => {
              const rootPath = rootPathOf(root);
              const current = currentRootPath && rootPath === currentRootPath;
              const rootReviewState = rootReviewStateOf(
                rootReviewStateByPath,
                rootPath
              );
              return (
                <li
                  key={root?.id ?? rootPath}
                  className={`library-root-list__item ${current ? "is-current" : ""}`}
                >
                  <div className="library-root-list__content">
                    <button
                      type="button"
                      className="library-root-list__open"
                      onClick={() => onOpenRoot?.(rootPath, root)}
                      aria-current={current ? "location" : undefined}
                      title={rootPath}
                      disabled={disabled}
                    >
                      <span className="library-root-list__name">{rootLabelOf(root)}</span>
                      <span className="library-root-list__path">{rootPath}</span>
                    </button>
                    <RootReviewSummary
                      root={root}
                      state={rootReviewState}
                      disabled={disabled}
                      onStartRootReview={onStartRootReview}
                      onContinueRootReview={onContinueRootReview}
                    />
                  </div>
                  <button
                    type="button"
                    className="library-root-list__pin"
                    onClick={() => onTogglePin?.(rootPath, false)}
                    aria-label={`Unpin ${rootLabelOf(root)}`}
                    title="Unpin library root"
                    disabled={disabled}
                  >
                    ★
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="library-sidebar__empty">Pin frequently reviewed roots here.</p>
        )}
      </section>

      <section className="library-sidebar__section library-sidebar__section--views">
        <header className="library-sidebar__section-header">
          <div>
            <span className="library-sidebar__eyebrow">Reusable filters</span>
            <h2>Smart views</h2>
          </div>
          <button
            type="button"
            className="library-sidebar__add-view"
            onClick={() => setNamingView((open) => !open)}
            aria-label="Save current smart view"
            aria-expanded={isNamingView}
            disabled={
              disabled ||
              !smartViewsEnabled ||
              typeof onSaveCurrentView !== "function"
            }
            title={
              smartViewsEnabled
                ? "Save the current filters, sort, grouping, and scope"
                : "Open a collection to save a smart view"
            }
          >
            +
          </button>
        </header>

        {isNamingView && (
          <form className="library-saved-view-form" onSubmit={submitSavedView}>
            <input
              value={viewName}
              onChange={(event) => setViewName(event.target.value.slice(0, 80))}
              placeholder="View name"
              aria-label="Saved view name"
              maxLength={80}
              autoFocus
              disabled={disabled}
            />
            <button type="submit" disabled={disabled || !viewName.trim()}>
              Save
            </button>
          </form>
        )}

        {savedViews.length ? (
          <ul className="library-saved-view-list">
            {savedViews.map((view) => (
              <li key={view.id}>
                <button
                  type="button"
                  className="library-saved-view-list__apply"
                  onClick={() => onApplySavedView?.(view)}
                  title={
                    smartViewsEnabled
                      ? `Apply ${view.name}`
                      : "Open a collection to apply this smart view"
                  }
                  disabled={disabled || !smartViewsEnabled}
                >
                  <span aria-hidden="true">◆</span>
                  <span>{view.name}</span>
                </button>
                <button
                  type="button"
                  className="library-saved-view-list__delete"
                  onClick={() => onDeleteSavedView?.(view.id, view)}
                  aria-label={`Delete saved view ${view.name}`}
                  title="Delete saved view"
                  disabled={disabled}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="library-sidebar__empty">Save filters for repeat review passes.</p>
        )}
      </section>

      <section className="library-sidebar__section library-sidebar__section--folders">
        <header className="library-sidebar__section-header">
          <div>
            <span className="library-sidebar__eyebrow">Current collection</span>
            <h2>Folders</h2>
          </div>
        </header>

        {roots.length ? (
          <ul className="library-folder-tree" role="tree" aria-label="Collection folders">
            {roots.map((root) => (
              <FolderTreeRow
                key={root?.path ?? root?.relativePath ?? root?.name}
                node={root}
                depth={0}
                currentPath={currentPath}
                expandedPaths={expanded}
                onToggleExpanded={onToggleExpanded}
                onSelectFolder={onSelectFolder}
                disabled={disabled}
              />
            ))}
          </ul>
        ) : (
          <p className="library-sidebar__empty">Open a folder to browse its tree.</p>
        )}
      </section>
    </aside>
  );
}

export default memo(LibrarySidebar);
