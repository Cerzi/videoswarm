// src/hooks/actions/actionPolicies.js

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
    label: 'Show in Explorer',
    whenContextWithMulti: TargetPolicy.CONTEXT_ONLY,
    enabledForToolbar: (count) => count === 1,
  },

  'file-properties': {
    id: 'file-properties',
    label: 'Properties',
    whenContextWithMulti: TargetPolicy.CONTEXT_ONLY,
    enabledForToolbar: (count) => count === 1,
  },

  // Multi-item actions: operate on all selected by default; in context menu they still apply to all selected.
  'move-to-trash': {
    id: 'move-to-trash',
    label: 'Move to Recycle Bin',
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
};

// Simple helpers you can import in UI
export const isEnabledForToolbar = (actionId, selectedCount) =>
  actionPolicies[actionId]?.enabledForToolbar?.(selectedCount) ?? false;

export const getContextPolicy = (actionId) =>
  actionPolicies[actionId]?.whenContextWithMulti ?? TargetPolicy.ALL_SELECTED;
