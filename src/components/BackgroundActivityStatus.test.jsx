import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import BackgroundActivityStatus, { BackgroundActivityView } from "./BackgroundActivityStatus";
import { ACTIVITY_SHOW_AFTER_MS } from "../app/hooks/useBackgroundActivity";

const proxies = { kind: "playback-proxies", pausable: true, done: 462, total: 500, startedAt: 0 };
const prompts = { kind: "prompts", pausable: true, done: 1240, total: 2481, startedAt: 0 };
const learning = { kind: "tag-suggestions", pausable: false, done: 2, total: 5, startedAt: 0 };

describe("BackgroundActivityView", () => {
  it("shows nothing while idle", () => {
    const { container } = render(<BackgroundActivityView paused={false} activities={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the first piece of work and how much is left, with a count of the rest", () => {
    render(<BackgroundActivityView paused={false} activities={[prompts, proxies]} />);
    const chip = screen.getByRole("button", { name: /Reading prompts in clips · 1,241 left/ });
    expect(chip).toHaveTextContent("+1");
    expect(chip).toHaveAttribute("aria-expanded", "false");
  });

  it("opens a panel listing every piece of work, and pauses from it", () => {
    const onSetPaused = vi.fn();
    render(
      <BackgroundActivityView paused={false} activities={[proxies, learning]} onSetPaused={onSetPaused} />
    );
    const chip = screen.getByRole("button", { name: /Building playback proxies · 38 left/ });
    fireEvent.click(chip);
    const panel = screen.getByRole("dialog", { name: "Background work" });
    expect(panel).toHaveTextContent("Building playback proxies");
    expect(panel).toHaveTextContent("462 / 500");
    expect(panel).toHaveTextContent("Learning tag suggestions");
    const pause = screen.getByRole("button", { name: "Pause" });
    expect(pause).toHaveFocus();
    fireEvent.click(pause);
    expect(onSetPaused).toHaveBeenCalledWith(true);

    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(chip).toHaveFocus();
  });

  it("stays in the status line while paused, even with nothing waiting, to resume", () => {
    const onSetPaused = vi.fn();
    const { rerender } = render(
      <BackgroundActivityView paused activities={[proxies, learning]} onSetPaused={onSetPaused} />
    );
    fireEvent.click(screen.getByRole("button", { name: /Background work paused/ }));
    const panel = screen.getByRole("dialog");
    expect(panel).toHaveTextContent("Paused · 462 / 500");
    // Work someone asked for is not held.
    expect(panel).not.toHaveTextContent("Paused · 2 / 5");
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onSetPaused).toHaveBeenCalledWith(false);

    rerender(<BackgroundActivityView paused activities={[]} onSetPaused={onSetPaused} />);
    expect(screen.getByRole("dialog")).toHaveTextContent("Nothing waiting.");
  });

  it("ignores kinds it has no words for", () => {
    const { container } = render(
      <BackgroundActivityView paused={false} activities={[{ kind: "unknown", done: 0, total: 1, startedAt: 0 }]} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("BackgroundActivityStatus", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete window.electronAPI;
  });

  function bridge(initial) {
    let listener = null;
    const api = {
      get: vi.fn(async () => initial),
      setPaused: vi.fn(async (paused) => ({ paused, activities: [] })),
      onChange: vi.fn((callback) => {
        listener = callback;
        return () => {
          listener = null;
        };
      }),
    };
    window.electronAPI = { activity: api };
    return { api, emit: (value) => listener?.(value) };
  }

  it("shows work only once it has run a moment, and follows main's updates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { api, emit } = bridge({ paused: false, activities: [] });
    render(<BackgroundActivityStatus />);
    await act(async () => {});
    expect(api.get).toHaveBeenCalled();

    act(() => emit({ paused: false, activities: [{ ...proxies, startedAt: 10_000 }] }));
    expect(screen.queryByRole("button")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(ACTIVITY_SHOW_AFTER_MS + 20);
    });
    expect(screen.getByRole("button", { name: /Building playback proxies/ })).toBeInTheDocument();

    act(() => emit({ paused: false, activities: [] }));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("pauses through the bridge and shows the pause at once", async () => {
    const { api } = bridge({ paused: false, activities: [{ ...prompts, startedAt: 0 }] });
    render(<BackgroundActivityStatus />);
    fireEvent.click(await screen.findByRole("button", { name: /Reading prompts in clips/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    });
    expect(api.setPaused).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: /Background work paused/ })).toBeInTheDocument();
  });
});
