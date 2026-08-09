import {
  FULLSCREEN_COMMANDS,
  FULLSCREEN_FRAME_SHORTCUTS,
  FULLSCREEN_NAVIGATION_SHORTCUTS,
  FULLSCREEN_PLAYER_SHORTCUTS,
  FULLSCREEN_SHORTCUTS,
  FULLSCREEN_SHORTCUT_BY_KEY,
  FULLSCREEN_SHORTCUT_HELP_SECTIONS,
  HOTKEY_SECTIONS,
  REVIEW_CLEAR_RATING_KEYS,
  REVIEW_PRIMARY_KEY_BY_STATE,
  REVIEW_RATING_BY_KEY,
  REVIEW_SHORTCUTS,
  REVIEW_STATE_BY_KEY,
  REVIEW_UNDO_KEYS,
  resolveFullscreenShortcut,
} from "./shortcutCatalog";

describe("review shortcut catalog", () => {
  it("drives primary one-handed keys and compatibility aliases from one catalog", () => {
    expect(REVIEW_STATE_BY_KEY).toMatchObject({
      a: "pick",
      p: "pick",
      s: "reviewed",
      r: "reviewed",
      d: "reject",
      x: "reject",
      f: "unreviewed",
      u: "unreviewed",
    });
    expect(REVIEW_PRIMARY_KEY_BY_STATE).toEqual({
      pick: "A",
      reviewed: "S",
      reject: "D",
      unreviewed: "F",
    });
  });

  it("keeps numeric ratings, clear, undo, and help synchronized", () => {
    expect(REVIEW_RATING_BY_KEY).toEqual({
      1: 1,
      2: 2,
      3: 3,
      4: 4,
      5: 5,
    });
    expect(REVIEW_CLEAR_RATING_KEYS).toEqual(["0"]);
    expect(REVIEW_UNDO_KEYS).toEqual(["z"]);
    expect(
      HOTKEY_SECTIONS.find((section) => section.id === "review")?.shortcuts
    ).toBe(REVIEW_SHORTCUTS);
  });
});

describe("fullscreen review loupe shortcut catalog", () => {
  it("contains complete navigation, playback, details, review, and utility help", () => {
    expect(FULLSCREEN_NAVIGATION_SHORTCUTS.map(({ id }) => id)).toEqual([
      "fullscreen-previous",
      "fullscreen-next",
      "fullscreen-playback",
      "fullscreen-mute",
      "fullscreen-details",
    ]);
    expect(FULLSCREEN_FRAME_SHORTCUTS.map(({ id }) => id)).toEqual([
      "fullscreen-frame-back",
      "fullscreen-frame-forward",
      "fullscreen-copy-frame",
    ]);
    expect(FULLSCREEN_SHORTCUTS).toEqual([
      ...FULLSCREEN_NAVIGATION_SHORTCUTS,
      ...FULLSCREEN_FRAME_SHORTCUTS,
      ...REVIEW_SHORTCUTS,
      ...FULLSCREEN_PLAYER_SHORTCUTS.slice(-2),
    ]);
    expect(FULLSCREEN_SHORTCUT_HELP_SECTIONS.map(({ id }) => id)).toEqual([
      "fullscreen-navigation",
      "fullscreen-frame",
      "fullscreen-review",
      "fullscreen-utility",
    ]);
    expect(FULLSCREEN_SHORTCUT_HELP_SECTIONS[2].shortcuts).toBe(
      REVIEW_SHORTCUTS
    );

    const globalFullscreen = HOTKEY_SECTIONS.find(
      (section) => section.id === "fullscreen"
    );
    expect(globalFullscreen.shortcuts).toBe(FULLSCREEN_PLAYER_SHORTCUTS);
  });

  it.each([
    ["ArrowLeft", FULLSCREEN_COMMANDS.PREVIOUS, undefined],
    ["Q", FULLSCREEN_COMMANDS.PREVIOUS, undefined],
    ["ArrowRight", FULLSCREEN_COMMANDS.NEXT, undefined],
    ["e", FULLSCREEN_COMMANDS.NEXT, undefined],
    [" ", FULLSCREEN_COMMANDS.PLAYBACK, undefined],
    ["Spacebar", FULLSCREEN_COMMANDS.PLAYBACK, undefined],
    ["M", FULLSCREEN_COMMANDS.MUTE, undefined],
    ["i", FULLSCREEN_COMMANDS.DETAILS, undefined],
    [",", FULLSCREEN_COMMANDS.FRAME_BACK, undefined],
    [".", FULLSCREEN_COMMANDS.FRAME_FORWARD, undefined],
    ["C", FULLSCREEN_COMMANDS.COPY_FRAME, undefined],
    ["a", FULLSCREEN_COMMANDS.REVIEW_STATE, "pick"],
    ["R", FULLSCREEN_COMMANDS.REVIEW_STATE, "reviewed"],
    ["d", FULLSCREEN_COMMANDS.REVIEW_STATE, "reject"],
    ["U", FULLSCREEN_COMMANDS.REVIEW_STATE, "unreviewed"],
    ["4", FULLSCREEN_COMMANDS.RATING, 4],
    ["0", FULLSCREEN_COMMANDS.CLEAR_RATING, null],
    ["z", FULLSCREEN_COMMANDS.UNDO, undefined],
    ["?", FULLSCREEN_COMMANDS.HELP, undefined],
    ["Escape", FULLSCREEN_COMMANDS.CLOSE, undefined],
  ])("resolves %s to %s", (key, command, value) => {
    expect(resolveFullscreenShortcut(key)).toMatchObject({ command });
    if (value !== undefined || command === FULLSCREEN_COMMANDS.CLEAR_RATING) {
      expect(resolveFullscreenShortcut({ key })).toMatchObject({ value });
    }
  });

  it("returns immutable reusable descriptors and rejects unknown keys", () => {
    expect(resolveFullscreenShortcut("Tab")).toBeNull();
    expect(resolveFullscreenShortcut(null)).toBeNull();
    expect(Object.isFrozen(FULLSCREEN_SHORTCUT_BY_KEY)).toBe(true);
    expect(Object.isFrozen(resolveFullscreenShortcut("q"))).toBe(true);
  });
});
