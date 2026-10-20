import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CompanionTargetPicker, { describeTargetCheck } from "./CompanionTargetPicker";

const companion = { id: "c2", name: "Fake editor" };
const action = {
  id: "add",
  label: "Add to project",
  send: "Add to",
  pick: "Add to project…",
  withdraw: true,
  targets: { label: "Project", new: "New project…" },
};
const clips = [1, 2, 3, 4, 5].map((instanceId) => ({ id: `v${instanceId}`, instanceId }));

function installApi({ targets, already = [] } = {}) {
  const send = vi.fn(async ({ instanceIds }) => ({
    success: true,
    results: Object.fromEntries(
      instanceIds.map((id) => [id, already.includes(id) ? { result: "skipped", why: "Already there" } : { result: "sent", why: "" }])
    ),
  }));
  const list = vi.fn(async () => ({ success: true, targets }));
  window.electronAPI = { companion: { targets: list, send } };
  return { send, list };
}

const TARGETS = [
  { handle: "t1", label: "Beach edit", detail: "12 clips · yesterday", current: false },
  { handle: "t2", label: "City night", detail: "4 clips · today", current: true },
  { handle: "t3", label: "Forest", detail: "", current: false },
];

describe("CompanionTargetPicker", () => {
  afterEach(() => {
    delete window.electronAPI;
  });

  it("starts on the current target and says what adding would do", async () => {
    const { send } = installApi({ targets: TARGETS, already: [1, 2] });
    const onConfirm = vi.fn();
    render(
      <CompanionTargetPicker open companion={companion} action={action} videos={clips} onConfirm={onConfirm} onClose={vi.fn()} />
    );
    expect(screen.getByRole("dialog", { name: "Add to project…" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /City night/ })).toHaveAttribute("aria-selected", "true")
    );
    expect(screen.getByText("12 clips · yesterday")).toBeInTheDocument();
    expect(await screen.findByText("2 of 5 already there, 3 will be added")).toBeInTheDocument();
    expect(send.mock.calls.every(([request]) => request.dryRun === true)).toBe(true);
    expect(send.mock.calls[0][0].target).toEqual({ handle: "t2" });

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith({ target: { handle: "t2" }, label: "City night" });
  });

  it("searches, moves with the arrows, and starts on the one used last without a current one", async () => {
    installApi({ targets: TARGETS.map((target) => ({ ...target, current: false })) });
    const onClose = vi.fn();
    render(
      <CompanionTargetPicker
        open
        companion={companion}
        action={action}
        videos={clips}
        lastHandle="t3"
        onConfirm={vi.fn()}
        onClose={onClose}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Forest/ })).toHaveAttribute("aria-selected", "true")
    );
    fireEvent.change(screen.getByRole("searchbox", { name: "Search projects" }), { target: { value: "beach" } });
    expect(screen.queryByRole("option", { name: /City night/ })).toBeNull();
    expect(screen.getByRole("option", { name: /Beach edit/ })).toHaveAttribute("aria-selected", "true");
    // The new-project row is always last.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "New project…" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("makes a new target only once it is named, checking the name first", async () => {
    const { send } = installApi({ targets: [] });
    const onConfirm = vi.fn();
    render(
      <CompanionTargetPicker open companion={companion} action={action} videos={clips.slice(0, 2)} onConfirm={onConfirm} onClose={vi.fn()} />
    );
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "New project…" })).toHaveAttribute("aria-selected", "true")
    );
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "New project name" }), { target: { value: "  Dunes  " } });
    expect(await screen.findByText("2 will be added")).toBeInTheDocument();
    expect(send.mock.calls.at(-1)[0]).toMatchObject({ dryRun: true, target: { new: "Dunes" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add 2" }));
    });
    expect(onConfirm).toHaveBeenCalledWith({ target: { new: "Dunes" }, label: "Dunes" });
  });

  it("says when the app does not answer", async () => {
    window.electronAPI = { companion: { targets: vi.fn(async () => ({ success: false, error: "Not answering" })) } };
    render(
      <CompanionTargetPicker open companion={companion} action={action} videos={clips} onConfirm={vi.fn()} onClose={vi.fn()} />
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Not answering");
  });
});

describe("describeTargetCheck", () => {
  const dry = (...results) => new Map(results.map((entry, index) => [index + 1, entry]));
  it("counts what is there, what will be added and what cannot be", () => {
    expect(describeTargetCheck(dry({ result: "sent" }, { result: "sent" }), 2)).toEqual({ sent: 2, text: "2 will be added" });
    expect(describeTargetCheck(dry({ result: "skipped" }, { result: "skipped" }), 2).text).toBe("All 2 already there");
    expect(
      describeTargetCheck(dry({ result: "skipped" }, { result: "sent" }, { result: "refused", why: "Not a video" }), 3).text
    ).toBe("1 of 3 already there, 1 will be added, 1 cannot be: Not a video");
  });
});
