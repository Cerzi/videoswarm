// src/hooks/actions/actionPolicies.js
import { moveToTrashLabel, showInFileManagerLabel } from '../../platform/fileManagerTerms';

export const TargetPolicy = {
  ALL_SELECTED: 'all-selected',
  CONTEXT_ONLY: 'context-only',
};

export const UIGroup = {
  TOOLBAR: 'toolbar',
  CONTEXT: 'context',
};

export const actionPolicies = {
  // Single-item actions: open/show-properties/show-in-folder behave on one item.
  // When multiple are selected and you right-click, they operate on the context item.
  'open-external': {
    id: 'open-external',
    label: 'Open',
    // When context menu is invoked with multiple selected:
    whenContextWithMulti: TargetPolicy.CONTEXT_ONLY,
    // Toolbar/hotkeys availability:
    enabledForToolbar: (count) => count === 1, // only when exactly one selected
  },

  'show-in-folder': {
    id: 'show-in-folder',
    // Named for the platform's file manager: Explorer, Finder, File Manager.
    get label() {
      return showInFileManagerLabel();
    },
    whenContextWithMulti: TargetPolicy.CONTEXT_ONLY,
    enabledForToolbar: (count) => count === 1,
  },

  // Multi-item actions: operate on all selected by default; in context menu they still apply to all selected.
  'move-to-trash': {
    id: 'move-to-trash',
    get label() {
      return moveToTrashLabel();
    },
    whenContextWithMulti: TargetPolicy.ALL_SELECTED,
    enabledForToolbar: (count) => count >= 1,
  },

  'copy-path': {
    id: 'copy-path',
    label: 'Copy Path(s)',
    whenContextWithMulti: TargetPolicy.ALL_SELECTED,
    enabledForToolbar: (count) => count >= 1,
  },

  'copy-filename': {
    id: 'copy-filename',
    label: 'Copy Filename(s)',
    whenContextWithMulti: TargetPolicy.ALL_SELECTED,
    enabledForToolbar: (count) => count >= 1,
  },

  'copy-relative-path': {
    id: 'copy-relative-path',
    label: 'Copy Relative Path(s)',
    whenContextWithMulti: TargetPolicy.ALL_SELECTED,
    enabledForToolbar: (count) => count >= 1,
  },

  'copy-last-frame': {
    id: 'copy-last-frame',
    label: 'Copy Last Frame',
    whenContextWithMulti: TargetPolicy.CONTEXT_ONLY,
    enabledForToolbar: (count) => count === 1,
  },

  // Opens the bounded transfer dialog rather than moving anything directly:
  // a destination, preflight and an explicit Move, Copy or Link still come first.
  'transfer-files': {
    id: 'transfer-files',
    label: 'Move, Copy or Link to…',
    whenContextWithMulti: TargetPolicy.ALL_SELECTED,
    enabledForToolbar: (count) => count >= 1,
  },
};

// Simple helpers you can import in UI
export const isEnabledForToolbar = (actionId, selectedCount) =>
  actionPolicies[actionId]?.enabledForToolbar?.(selectedCount) ?? false;

export const getContextPolicy = (actionId) =>
  actionPolicies[actionId]?.whenContextWithMulti ?? TargetPolicy.ALL_SELECTED;
