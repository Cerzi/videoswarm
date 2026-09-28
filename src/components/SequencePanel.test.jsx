import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SequencePanel from "./SequencePanel";

const entry = (id, name, overrides = {}) => ({
  id,
  position: id - 1,
  fingerprint: `fp-${id}`,
  addedAt: 0,
  video: {
    id: `/library/${name}`,
    instanceId: id * 10,
    name,
    rootPath: "/library",
    sourceUrl: `videoswarm-media://instance/${id * 10}?v=1-2&g=1`,
    isElectronFile: true,
  },
  ...overrides,
});

const sequence = (entries) => ({
  id: 7,
  name: "Act one",
  entryCount: entries.length,
  createdAt: 0,
  updatedAt: 0,
  entries,
  missingCount: entries.filter((item) => !item.video).length,
});

function dragEntry(from, to) {
  const dataTransfer = {
    effectAllowed: "",
    dropEffect: "",
    setData: vi.fn(),
    getData: vi.fn(() => ""),
  };
  fireEvent.dragStart(from, { dataTransfer });
  fireEvent.dragOver(to, { dataTransfer });
  fireEvent.drop(to, { dataTransfer });
  return dataTransfer;
}

describe("SequencePanel", () => {
  beforeEach(() => {
    window.electronAPI = { startFileDragSync: vi.fn() };
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it("numbers entries from one in stored order", () => {
    render(
      <SequencePanel
        sequences={[{ id: 7, name: "Act one", entryCount: 3 }]}
        activeSequenceId={7}
        activeSequence={sequence([
          entry(1, "a.mp4"),
          entry(2, "b.mp4"),
          entry(3, "c.mp4"),
        ])}
      />
    );

    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => within(item).getByText(/^\d+$/).textContent)).toEqual(
      ["1", "2", "3"]
    );
    expect(items.map((item) => item.dataset.entryId)).toEqual(["1", "2", "3"]);
  });

  it("moves the dragged entry to the drop position", () => {
    const onMoveEntry = vi.fn();
    render(
      <SequencePanel
        sequences={[{ id: 7, name: "Act one", entryCount: 3 }]}
        activeSequenceId={7}
        activeSequence={sequence([
          entry(1, "a.mp4"),
          entry(2, "b.mp4"),
          entry(3, "c.mp4"),
        ])}
        onMoveEntry={onMoveEntry}
      />
    );

    const items = screen.getAllByRole("listitem");
    dragEntry(items[2], items[0]);

    expect(onMoveEntry).toHaveBeenCalledWith(3, 0);
  });

  it("never starts a native OS drag from a strip entry", () => {
    render(
      <SequencePanel
        sequences={[{ id: 7, name: "Act one", entryCount: 2 }]}
        activeSequenceId={7}
        activeSequence={sequence([entry(1, "a.mp4"), entry(2, "b.mp4")])}
        onMoveEntry={vi.fn()}
      />
    );

    const items = screen.getAllByRole("listitem");
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: vi.fn(),
      getData: vi.fn(() => ""),
    };
    // Grid cards preventDefault here and hand off to Electron. Strip entries
    // must not, or the HTML5 drag that powers reordering would be cancelled.
    const started = fireEvent.dragStart(items[0], { dataTransfer });
    expect(started).toBe(true);
    expect(window.electronAPI.startFileDragSync).not.toHaveBeenCalled();
    expect(dataTransfer.effectAllowed).toBe("move");
  });

  it("ignores a drop onto the entry being dragged", () => {
    const onMoveEntry = vi.fn();
    render(
      <SequencePanel
        sequences={[{ id: 7, name: "Act one", entryCount: 2 }]}
        activeSequenceId={7}
        activeSequence={sequence([entry(1, "a.mp4"), entry(2, "b.mp4")])}
        onMoveEntry={onMoveEntry}
      />
    );

    const items = screen.getAllByRole("listitem");
    dragEntry(items[1], items[1]);

    expect(onMoveEntry).not.toHaveBeenCalled();
  });

  it("keeps a missing clip in place rather than shortening the sequence", () => {
    render(
      <SequencePanel
        sequences={[{ id: 7, name: "Act one", entryCount: 3 }]}
        activeSequenceId={7}
        activeSequence={sequence([
          entry(1, "a.mp4"),
          entry(2, "b.mp4", { video: null }),
          entry(3, "c.mp4"),
        ])}
      />
    );

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[1].dataset.missing).toBe("true");
    expect(within(items[1]).getByText("2")).toBeTruthy();
    expect(within(items[1]).getByText("Missing clip")).toBeTruthy();
    expect(screen.getByText("1 missing")).toBeTruthy();
  });

  it("removes one entry without touching the rest", () => {
    const onRemoveEntries = vi.fn();
    render(
      <SequencePanel
        sequences={[{ id: 7, name: "Act one", entryCount: 2 }]}
        activeSequenceId={7}
        activeSequence={sequence([entry(1, "a.mp4"), entry(2, "b.mp4")])}
        onRemoveEntries={onRemoveEntries}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Remove b\.mp4 from the sequence/i })
    );
    expect(onRemoveEntries).toHaveBeenCalledWith([2]);
  });

  it("only offers Add selection with both a sequence and a selection", () => {
    const onAddSelection = vi.fn();
    const { rerender } = render(
      <SequencePanel sequences={[]} selectedCount={3} onAddSelection={onAddSelection} />
    );
    expect(screen.getByRole("button", { name: /Add selection/i })).toBeDisabled();

    rerender(
      <SequencePanel
        sequences={[{ id: 7, name: "Act one", entryCount: 0 }]}
        activeSequenceId={7}
        activeSequence={sequence([])}
        selectedCount={0}
        onAddSelection={onAddSelection}
      />
    );
    expect(screen.getByRole("button", { name: /Add selection/i })).toBeDisabled();

    rerender(
      <SequencePanel
        sequences={[{ id: 7, name: "Act one", entryCount: 0 }]}
        activeSequenceId={7}
        activeSequence={sequence([])}
        selectedCount={3}
        onAddSelection={onAddSelection}
      />
    );
    const button = screen.getByRole("button", { name: /Add selection \(3\)/i });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(onAddSelection).toHaveBeenCalled();
  });

  it("confirms before deleting and says clips are untouched", () => {
    const onDeleteSequence = vi.fn();
    const confirmSpy = vi
      .spyOn(window, "confirm")
      .mockImplementation(() => false);
    render(
      <SequencePanel
        sequences={[{ id: 7, name: "Act one", entryCount: 1 }]}
        activeSequenceId={7}
        activeSequence={sequence([entry(1, "a.mp4")])}
        onDeleteSequence={onDeleteSequence}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringMatching(/clips themselves are not touched/i)
    );
    expect(onDeleteSequence).not.toHaveBeenCalled();

    confirmSpy.mockImplementation(() => true);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDeleteSequence).toHaveBeenCalledWith(7);
  });

  it("surfaces a store error without hiding the strip", () => {
    render(
      <SequencePanel
        sequences={[{ id: 7, name: "Act one", entryCount: 1 }]}
        activeSequenceId={7}
        activeSequence={sequence([entry(1, "a.mp4")])}
        error='A sequence named "Act one" already exists'
      />
    );

    expect(screen.getByText(/already exists/i)).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
});
