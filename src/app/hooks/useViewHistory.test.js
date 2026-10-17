import { act, renderHook } from "@testing-library/react";
import { VIEW_SETTLE_MS, useViewHistory } from "./useViewHistory";

const folder = (directory, stackKey = null) => ({
  rootPath: "/library",
  directory,
  scope: "current-folder",
  stackKey,
});

async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(VIEW_SETTLE_MS + 10);
  });
}

function mouse(button) {
  const event = new MouseEvent("mouseup", { button, bubbles: true, cancelable: true });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

describe("useViewHistory", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const navigate = vi.fn();
    const hook = renderHook(({ current, onBack }) => useViewHistory({ current, navigate, onBack }), {
      initialProps: { current: folder("a"), onBack: undefined },
    });
    return { ...hook, navigate };
  }

  it("records settled views and walks back and forward with the mouse buttons", async () => {
    const { result, rerender, navigate } = setup();
    await settle();
    rerender({ current: folder("b") });
    await settle();
    rerender({ current: folder("b", "pk-1") });
    await settle();
    expect(result.current).toMatchObject({ canGoBack: true, canGoForward: false });

    const back = mouse(3);
    expect(back.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenLastCalledWith(folder("b"));
    rerender({ current: folder("b") });
    await settle();
    mouse(3);
    expect(navigate).toHaveBeenLastCalledWith(folder("a"));
    rerender({ current: folder("a") });
    await settle();
    expect(result.current).toMatchObject({ canGoBack: false, canGoForward: true });

    mouse(4);
    expect(navigate).toHaveBeenLastCalledWith(folder("b"));
  });

  it("collapses the steps of one navigation into one entry", async () => {
    const { result, rerender, navigate } = setup();
    await settle();
    rerender({ current: { ...folder(""), rootPath: "/other" } });
    rerender({ current: { ...folder("deep"), rootPath: "/other" } });
    await settle();
    act(() => result.current.back());
    expect(navigate).toHaveBeenLastCalledWith(folder("a"));
  });

  it("drops forward views when a new view is opened after going back", async () => {
    const { result, rerender, navigate } = setup();
    await settle();
    rerender({ current: folder("b") });
    await settle();
    act(() => result.current.back());
    rerender({ current: folder("a") });
    await settle();
    rerender({ current: folder("c") });
    await settle();
    expect(result.current.canGoForward).toBe(false);
    act(() => result.current.back());
    expect(navigate).toHaveBeenLastCalledWith(folder("a"));
  });

  it("lets something else take the back button first, and goes nowhere past the ends", async () => {
    const { result, rerender, navigate } = setup();
    await settle();
    expect(result.current.back()).toBe(false);
    const onBack = vi.fn(() => true);
    rerender({ current: folder("a"), onBack });
    mouse(3);
    expect(onBack).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("goes back with Alt+Left, but not while typing", async () => {
    const { rerender, navigate } = setup();
    await settle();
    rerender({ current: folder("b") });
    await settle();
    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true }));
    });
    expect(navigate).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true }));
    });
    expect(navigate).toHaveBeenCalledWith(folder("a"));
    input.remove();
  });
});
