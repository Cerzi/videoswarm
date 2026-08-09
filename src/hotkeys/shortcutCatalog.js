const freezeShortcut = (shortcut) =>
  Object.freeze({
    ...shortcut,
    keys: Object.freeze([...shortcut.keys]),
    ...(shortcut.bindings
      ? { bindings: Object.freeze([...shortcut.bindings]) }
      : {}),
  });

export const REVIEW_SHORTCUTS = Object.freeze([
  freezeShortcut({
    id: "review-pick",
    keys: ["A", "P"],
    keyJoiner: "or",
    label: "Mark as Accept",
    detail: "Applies to every selected clip.",
    state: "pick",
  }),
  freezeShortcut({
    id: "review-reviewed",
    keys: ["S", "R"],
    keyJoiner: "or",
    label: "Mark as Reviewed",
    detail: "Applies to every selected clip.",
    state: "reviewed",
  }),
  freezeShortcut({
    id: "review-reject",
    keys: ["D", "X"],
    keyJoiner: "or",
    label: "Mark as Reject",
    detail: "Applies to every selected clip.",
    state: "reject",
  }),
  freezeShortcut({
    id: "review-unreviewed",
    keys: ["F", "U"],
    keyJoiner: "or",
    label: "Reset to Unreviewed",
    detail: "Also clears ratings; tags are kept.",
    state: "unreviewed",
  }),
  freezeShortcut({
    id: "review-rating",
    keys: ["1–5"],
    bindings: ["1", "2", "3", "4", "5"],
    label: "Set star rating",
    detail: "A rating also counts the clip as reviewed.",
    action: "rating",
  }),
  freezeShortcut({
    id: "review-clear-rating",
    keys: ["0"],
    label: "Clear star rating",
    detail: "Keeps the current review state.",
    action: "clear-rating",
  }),
  freezeShortcut({
    id: "review-undo",
    keys: ["Z"],
    label: "Undo last review change",
    detail: "Restores both review state and rating.",
    action: "undo",
  }),
]);

export const REVIEW_STATE_BY_KEY = Object.freeze(
  Object.fromEntries(
    REVIEW_SHORTCUTS.flatMap((shortcut) =>
      shortcut.state
        ? shortcut.keys.map((key) => [key.toLowerCase(), shortcut.state])
        : []
    )
  )
);

export const REVIEW_PRIMARY_KEY_BY_STATE = Object.freeze(
  Object.fromEntries(
    REVIEW_SHORTCUTS.filter((shortcut) => shortcut.state).map((shortcut) => [
      shortcut.state,
      shortcut.keys[0],
    ])
  )
);

export const REVIEW_RATING_BY_KEY = Object.freeze(
  Object.fromEntries(
    REVIEW_SHORTCUTS.filter((shortcut) => shortcut.action === "rating").flatMap(
      (shortcut) => shortcut.bindings.map((key) => [key, Number(key)])
    )
  )
);

export const REVIEW_CLEAR_RATING_KEYS = Object.freeze(
  REVIEW_SHORTCUTS.filter((shortcut) => shortcut.action === "clear-rating")
    .flatMap((shortcut) => shortcut.keys)
    .map((key) => key.toLowerCase())
);

export const REVIEW_UNDO_KEYS = Object.freeze(
  REVIEW_SHORTCUTS.filter((shortcut) => shortcut.action === "undo")
    .flatMap((shortcut) => shortcut.keys)
    .map((key) => key.toLowerCase())
);

export const FOLDER_DIRECTION_BY_KEY = Object.freeze({
  "[": "previous",
  "]": "next",
});

export const FULLSCREEN_COMMANDS = Object.freeze({
  PREVIOUS: "previous",
  NEXT: "next",
  PLAYBACK: "playback",
  MUTE: "mute",
  DETAILS: "details",
  REVIEW_STATE: "review-state",
  RATING: "rating",
  CLEAR_RATING: "clear-rating",
  UNDO: "undo",
  FRAME_BACK: "frame-back",
  FRAME_FORWARD: "frame-forward",
  COPY_FRAME: "copy-frame",
  HELP: "help",
  CLOSE: "close",
});

export const FULLSCREEN_NAVIGATION_SHORTCUTS = Object.freeze([
  freezeShortcut({
    id: "fullscreen-previous",
    keys: ["←", "Q"],
    bindings: ["ArrowLeft", "q"],
    keyJoiner: "or",
    label: "Previous clip",
    command: FULLSCREEN_COMMANDS.PREVIOUS,
  }),
  freezeShortcut({
    id: "fullscreen-next",
    keys: ["→", "E"],
    bindings: ["ArrowRight", "e"],
    keyJoiner: "or",
    label: "Next clip",
    command: FULLSCREEN_COMMANDS.NEXT,
  }),
  freezeShortcut({
    id: "fullscreen-playback",
    keys: ["Space"],
    bindings: [" "],
    label: "Play or pause",
    command: FULLSCREEN_COMMANDS.PLAYBACK,
  }),
  freezeShortcut({
    id: "fullscreen-mute",
    keys: ["M"],
    label: "Mute or enable audio",
    command: FULLSCREEN_COMMANDS.MUTE,
  }),
  freezeShortcut({
    id: "fullscreen-details",
    keys: ["I"],
    label: "Toggle clip details",
    command: FULLSCREEN_COMMANDS.DETAILS,
  }),
]);

// Arrow keys already move between clips, so frame stepping uses the comma and
// period convention shared by video editors rather than overloading them.
export const FULLSCREEN_FRAME_SHORTCUTS = Object.freeze([
  freezeShortcut({
    id: "fullscreen-frame-back",
    keys: [","],
    label: "Previous frame",
    detail: "Pauses playback and steps one frame back.",
    command: FULLSCREEN_COMMANDS.FRAME_BACK,
  }),
  freezeShortcut({
    id: "fullscreen-frame-forward",
    keys: ["."],
    label: "Next frame",
    detail: "Pauses playback and steps one frame forward.",
    command: FULLSCREEN_COMMANDS.FRAME_FORWARD,
  }),
  freezeShortcut({
    id: "fullscreen-copy-frame",
    keys: ["C"],
    label: "Copy current frame",
    detail: "Copies the displayed frame to the clipboard at full resolution.",
    command: FULLSCREEN_COMMANDS.COPY_FRAME,
  }),
]);

export const FULLSCREEN_UTILITY_SHORTCUTS = Object.freeze([
  freezeShortcut({
    id: "fullscreen-help",
    keys: ["?"],
    label: "Show fullscreen shortcuts",
    command: FULLSCREEN_COMMANDS.HELP,
  }),
  freezeShortcut({
    id: "fullscreen-close",
    keys: ["Esc"],
    bindings: ["Escape"],
    label: "Close fullscreen",
    command: FULLSCREEN_COMMANDS.CLOSE,
  }),
]);

export const FULLSCREEN_PLAYER_SHORTCUTS = Object.freeze([
  ...FULLSCREEN_NAVIGATION_SHORTCUTS,
  ...FULLSCREEN_FRAME_SHORTCUTS,
  ...FULLSCREEN_UTILITY_SHORTCUTS,
]);

// Complete loupe help/dispatch catalog. Review entries are shared by identity
// with the grid workflow so aliases and rating semantics cannot drift.
export const FULLSCREEN_SHORTCUTS = Object.freeze([
  ...FULLSCREEN_NAVIGATION_SHORTCUTS,
  ...FULLSCREEN_FRAME_SHORTCUTS,
  ...REVIEW_SHORTCUTS,
  ...FULLSCREEN_UTILITY_SHORTCUTS,
]);

export const FULLSCREEN_SHORTCUT_HELP_SECTIONS = Object.freeze([
  Object.freeze({
    id: "fullscreen-navigation",
    title: "Playback and navigation",
    shortcuts: FULLSCREEN_NAVIGATION_SHORTCUTS,
  }),
  Object.freeze({
    id: "fullscreen-frame",
    title: "Frame picking",
    shortcuts: FULLSCREEN_FRAME_SHORTCUTS,
  }),
  Object.freeze({
    id: "fullscreen-review",
    title: "Review current clip",
    shortcuts: REVIEW_SHORTCUTS,
  }),
  Object.freeze({
    id: "fullscreen-utility",
    title: "Fullscreen",
    shortcuts: FULLSCREEN_UTILITY_SHORTCUTS,
  }),
]);

const normalizeFullscreenKey = (input) => {
  const key = typeof input === "string" ? input : input?.key;
  if (key === "Spacebar") return " ";
  if (typeof key !== "string" || !key) return null;
  return key.length === 1 ? key.toLowerCase() : key;
};

const freezeFullscreenBinding = (shortcut, command, extra = {}) =>
  Object.freeze({
    shortcutId: shortcut.id,
    command,
    ...extra,
  });

const fullscreenBindings = [];

for (const shortcut of [
  ...FULLSCREEN_NAVIGATION_SHORTCUTS,
  ...FULLSCREEN_FRAME_SHORTCUTS,
  ...FULLSCREEN_UTILITY_SHORTCUTS,
]) {
  const bindings = shortcut.bindings || shortcut.keys;
  for (const binding of bindings) {
    const normalized = normalizeFullscreenKey(binding);
    if (!normalized) continue;
    fullscreenBindings.push([
      normalized,
      freezeFullscreenBinding(shortcut, shortcut.command),
    ]);
  }
}

for (const shortcut of REVIEW_SHORTCUTS) {
  if (shortcut.state) {
    for (const binding of shortcut.keys) {
      fullscreenBindings.push([
        normalizeFullscreenKey(binding),
        freezeFullscreenBinding(shortcut, FULLSCREEN_COMMANDS.REVIEW_STATE, {
          value: shortcut.state,
        }),
      ]);
    }
    continue;
  }

  if (shortcut.action === "rating") {
    for (const binding of shortcut.bindings) {
      fullscreenBindings.push([
        normalizeFullscreenKey(binding),
        freezeFullscreenBinding(shortcut, FULLSCREEN_COMMANDS.RATING, {
          value: Number(binding),
        }),
      ]);
    }
  } else if (shortcut.action === "clear-rating") {
    for (const binding of shortcut.keys) {
      fullscreenBindings.push([
        normalizeFullscreenKey(binding),
        freezeFullscreenBinding(shortcut, FULLSCREEN_COMMANDS.CLEAR_RATING, {
          value: null,
        }),
      ]);
    }
  } else if (shortcut.action === "undo") {
    for (const binding of shortcut.keys) {
      fullscreenBindings.push([
        normalizeFullscreenKey(binding),
        freezeFullscreenBinding(shortcut, FULLSCREEN_COMMANDS.UNDO),
      ]);
    }
  }
}

export const FULLSCREEN_SHORTCUT_BY_KEY = Object.freeze(
  Object.fromEntries(fullscreenBindings)
);

export const resolveFullscreenShortcut = (keyOrEvent) => {
  const key = normalizeFullscreenKey(keyOrEvent);
  return key ? FULLSCREEN_SHORTCUT_BY_KEY[key] || null : null;
};

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
    description: "Review keys above also apply to the current fullscreen clip.",
    shortcuts: FULLSCREEN_PLAYER_SHORTCUTS,
  }),
]);
