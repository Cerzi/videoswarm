const { EventEmitter } = require("events");
const {
  attachWindowActivity,
  readWindowActivity,
} = require("../window-activity");

function makeWindow() {
  const emitter = new EventEmitter();
  const state = { visible: true, minimized: false, destroyed: false };
  emitter.isVisible = () => state.visible;
  emitter.isMinimized = () => state.minimized;
  emitter.isDestroyed = () => state.destroyed;
  emitter.state = state;
  return emitter;
}

describe("window activity", () => {
  it("maps visible, minimized, hidden, and destroyed state", () => {
    const window = makeWindow();
    expect(readWindowActivity(window)).toMatchObject({
      active: true,
      reason: "active",
    });

    window.state.minimized = true;
    expect(readWindowActivity(window)).toMatchObject({
      active: false,
      reason: "minimized",
    });

    window.state.minimized = false;
    window.state.visible = false;
    expect(readWindowActivity(window)).toMatchObject({
      active: false,
      reason: "hidden",
    });

    window.state.destroyed = true;
    expect(readWindowActivity(window)).toMatchObject({
      active: false,
      reason: "destroyed",
    });
  });

  it("publishes lifecycle changes and disposes every listener", () => {
    const window = makeWindow();
    const updates = [];
    const dispose = attachWindowActivity(window, (value) => updates.push(value));

    expect(updates).toHaveLength(1);
    window.state.minimized = true;
    window.emit("minimize");
    expect(updates.at(-1)).toMatchObject({ active: false, minimized: true });

    dispose();
    expect(window.eventNames()).toEqual([]);
    window.state.minimized = false;
    window.emit("restore");
    expect(updates).toHaveLength(2);
  });
});
