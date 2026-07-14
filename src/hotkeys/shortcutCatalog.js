const freezeShortcut = (shortcut) =>
  Object.freeze({
    ...shortcut,
    keys: Object.freeze([...shortcut.keys]),
  });

export const REVIEW_SHORTCUTS = Object.freeze([
  freezeShortcut({
    id: "review-pick",
    keys: ["P"],
    label: "Mark as Pick",
    detail: "Applies to every selected clip.",
    state: "pick",
  }),
  freezeShortcut({
    id: "review-reviewed",
    keys: ["R"],
    label: "Mark as Reviewed",
    detail: "Applies to every selected clip.",
    state: "reviewed",
  }),
  freezeShortcut({
    id: "review-reject",
    keys: ["X"],
    label: "Mark as Reject",
    detail: "Applies to every selected clip.",
    state: "reject",
  }),
  freezeShortcut({
    id: "review-unreviewed",
    keys: ["U"],
    label: "Reset to Unreviewed",
    detail: "Applies to every selected clip.",
    state: "unreviewed",
  }),
]);

export const REVIEW_STATE_BY_KEY = Object.freeze(
  Object.fromEntries(
    REVIEW_SHORTCUTS.map((shortcut) => [
      shortcut.keys[0].toLowerCase(),
      shortcut.state,
    ])
  )
);

export const FOLDER_DIRECTION_BY_KEY = Object.freeze({
  "[": "previous",
  "]": "next",
});

export const FULLSCREEN_SHORTCUTS = Object.freeze([
  freezeShortcut({
    id: "fullscreen-previous",
    keys: ["←"],
    label: "Previous clip",
  }),
  freezeShortcut({
    id: "fullscreen-next",
    keys: ["→"],
    label: "Next clip",
  }),
  freezeShortcut({
    id: "fullscreen-playback",
    keys: ["Space"],
    label: "Play or pause",
  }),
  freezeShortcut({
    id: "fullscreen-close",
    keys: ["Esc"],
    label: "Close fullscreen",
  }),
]);

const APPLICATION_SHORTCUTS = Object.freeze([
  freezeShortcut({
    id: "shortcut-help",
    keys: ["?"],
    label: "Open this shortcut guide",
  }),
  freezeShortcut({
    id: "open-folder",
    keys: ["Ctrl / ⌘", "O"],
    label: "Open folder",
    detail: "Uses the native folder picker.",
  }),
  freezeShortcut({
    id: "cancel-folder-scan",
    keys: ["Esc"],
    label: "Cancel folder loading",
    detail: "Available while an initial folder scan is open.",
  }),
  freezeShortcut({
    id: "quit-application",
    keys: ["Ctrl / ⌘", "Q"],
    label: "Quit Video Swarm",
  }),
]);

const LIBRARY_SHORTCUTS = Object.freeze([
  freezeShortcut({
    id: "previous-folder",
    keys: ["["],
    label: "Previous sibling folder",
    detail: "Moves within the active library directory.",
  }),
  freezeShortcut({
    id: "next-folder",
    keys: ["]"],
    label: "Next sibling folder",
    detail: "Moves within the active library directory.",
  }),
]);

const SELECTION_SHORTCUTS = Object.freeze([
  freezeShortcut({
    id: "open-selection-details",
    keys: ["I"],
    label: "Open selection details",
    detail: "Available when one or more clips are selected.",
  }),
  freezeShortcut({
    id: "open-selected",
    keys: ["Enter"],
    label: "Open selected clip",
    detail: "Available when exactly one clip is selected.",
  }),
  freezeShortcut({
    id: "copy-path",
    keys: ["Ctrl / ⌘", "C"],
    label: "Copy selected paths",
  }),
  freezeShortcut({
    id: "trash-selected",
    keys: ["Delete", "Backspace"],
    keyJoiner: "or",
    label: "Move selected clips to trash",
  }),
]);

const VIEW_SHORTCUTS = Object.freeze([
  freezeShortcut({
    id: "zoom-in",
    keys: ["+", "="],
    keyJoiner: "or",
    label: "Zoom grid in",
  }),
  freezeShortcut({
    id: "zoom-out",
    keys: ["-"],
    label: "Zoom grid out",
  }),
  freezeShortcut({
    id: "wheel-zoom",
    keys: ["Ctrl / ⌘", "Wheel"],
    label: "Zoom grid continuously",
  }),
]);

export const HOTKEY_SECTIONS = Object.freeze([
  Object.freeze({
    id: "application",
    title: "Application",
    description: "Common app and folder-loading controls.",
    shortcuts: APPLICATION_SHORTCUTS,
  }),
  Object.freeze({
    id: "library",
    title: "Library",
    description: "Move through the active folder tree.",
    shortcuts: LIBRARY_SHORTCUTS,
  }),
  Object.freeze({
    id: "selection",
    title: "Selected clips",
    description: "File actions use the current grid selection.",
    shortcuts: SELECTION_SHORTCUTS,
  }),
  Object.freeze({
    id: "review",
    title: "Review",
    description: "Fast triage for one clip or a batch.",
    shortcuts: REVIEW_SHORTCUTS,
  }),
  Object.freeze({
    id: "view",
    title: "Grid view",
    description: "Adjust clip size without leaving the keyboard.",
    shortcuts: VIEW_SHORTCUTS,
  }),
  Object.freeze({
    id: "fullscreen",
    title: "Fullscreen player",
    description: "These keys apply while the player is open.",
    shortcuts: FULLSCREEN_SHORTCUTS,
  }),
]);
