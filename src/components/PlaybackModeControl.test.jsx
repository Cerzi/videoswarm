import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PlaybackModeControl from "./PlaybackModeControl";

describe("PlaybackModeControl", () => {
  it("offers all modes and reports a mode change", () => {
    const onModeChange = vi.fn();
    render(
      <PlaybackModeControl
        mode="balanced"
        onModeChange={onModeChange}
        decision={{ target: 3, safetyCap: 8, health: "healthy" }}
      />
    );

    const select = screen.getByRole("combobox", { name: "Playback mode" });
    expect(select).toHaveTextContent("Balanced");
    expect(select).toHaveTextContent("Adaptive Motion (safety capped)");
    expect(select).toHaveTextContent("All Motion (uncapped)");
    expect(select).toHaveTextContent("Static + Hover");
    fireEvent.change(select, { target: { value: "static-hover" } });
    expect(onModeChange).toHaveBeenCalledWith("static-hover");
    expect(screen.getByLabelText(/Playback target/)).toHaveTextContent(
      "3/8 decoders"
    );
  });

  it("shows explicit Linux uncertainty and exposes proxy opt-in", () => {
    const onProxyToggle = vi.fn();
    render(
      <PlaybackModeControl
        capabilityStatus="Linux: acceleration detected, not guaranteed."
        proxyEnabled
        onProxyToggle={onProxyToggle}
      />
    );

    expect(screen.getByText(/detected, not guaranteed/i)).toBeInTheDocument();
    const proxy = screen.getByRole("button", {
      name: "Use generated playback proxies",
    });
    expect(proxy).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(proxy);
    expect(onProxyToggle).toHaveBeenCalledOnce();
  });

  it("reports suspended work honestly", () => {
    render(<PlaybackModeControl workSuspended decision={{ target: 4, safetyCap: 8 }} />);
    expect(screen.getByLabelText(/Playback target/)).toHaveTextContent(
      "Media paused"
    );
  });
});
