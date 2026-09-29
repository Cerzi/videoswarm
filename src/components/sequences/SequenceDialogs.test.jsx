import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SequenceRenumberDialog from "./SequenceRenumberDialog";
import SequenceExportCopyDialog from "./SequenceExportCopyDialog";

const renumberPlan = {
  planId: "plan-0001",
  total: 3,
  unchangedCount: 1,
  renames: [
    { position: 1, directory: "/clips/act-one", fromName: "b.mp4", toName: "010_b.mp4" },
    { position: 3, directory: "/clips/act-two", fromName: "a.mp4", toName: "030_a.mp4" },
  ],
};

describe("SequenceRenumberDialog", () => {
  it("states exactly what will be renamed, folder by folder, before anything happens", () => {
    const onConfirm = vi.fn();
    render(
      <SequenceRenumberDialog
        open
        sequenceName="Act one"
        plan={renumberPlan}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />
    );

    const dialog = screen.getByRole("dialog", { name: "Rename originals to this order" });
    expect(dialog).toHaveTextContent("2 original files will be renamed");
    expect(dialog).toHaveTextContent("Tags, ratings and review state stay with the clips.");
    expect(dialog).toHaveTextContent("1 file already carries its number");
    const first = screen.getByRole("list", { name: "Renames in /clips/act-one" });
    expect(within(first).getByText("b.mp4")).toBeTruthy();
    expect(within(first).getByText("010_b.mp4")).toBeTruthy();
    const second = screen.getByRole("list", { name: "Renames in /clips/act-two" });
    expect(within(second).getByText("030_a.mp4")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Rename 2 files" }));
    expect(onConfirm).toHaveBeenCalledWith("plan-0001");
  });

  it("says when there is nothing to rename and offers no rename button", () => {
    render(
      <SequenceRenumberDialog
        open
        plan={{ planId: "plan-0002", renames: [], unchangedCount: 2, total: 2 }}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Nothing needs renaming");
    expect(screen.queryByRole("button", { name: /^Rename \d/ })).toBeNull();
  });

  it("will not confirm a spent plan and closes on Escape unless renaming", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <SequenceRenumberDialog
        open
        plan={{ ...renumberPlan, planId: null }}
        error="Renumbering failed; every file was renamed back"
        onClose={onClose}
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent("renamed back");
    expect(screen.getByRole("button", { name: "Rename 2 files" })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <SequenceRenumberDialog open plan={renumberPlan} applying onClose={onClose} />
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Renaming…" })).toBeDisabled();
  });
});

describe("SequenceExportCopyDialog", () => {
  const preparedResponse = (overrides = {}) => ({
    success: true,
    planId: "copyplan-1",
    destinationLabel: "exports",
    mediaCount: 3,
    totalBytes: 4096,
    copyableCount: 3,
    collisionCount: 0,
    collisionSamples: [],
    canStart: true,
    sequence: {
      id: 5,
      blockedReason: null,
      concatFileName: "concat.txt",
      targetNames: ["010_b.mp4", "020_a.mp4", "030_b.mp4"],
    },
    ...overrides,
  });

  it("prepares into a chosen folder, lists the numbered names and copies", async () => {
    const onPrepare = vi.fn().mockResolvedValue(preparedResponse());
    const onStart = vi.fn().mockResolvedValue({
      success: true,
      planId: "copyplan-1",
      copiedCount: 3,
      concatWritten: true,
    });
    render(
      <SequenceExportCopyDialog
        open
        sequenceName="Act one"
        clipCount={3}
        onPrepare={onPrepare}
        onStart={onStart}
        onCancel={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    });
    expect(onPrepare).toHaveBeenCalledWith({ destinationPath: null, reusePlanId: null });
    const names = await screen.findByRole("list", { name: "Names in the destination" });
    expect(within(names).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "010_b.mp4",
      "020_a.mp4",
      "030_b.mp4",
    ]);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy 3 files" }));
    });
    expect(onStart).toHaveBeenCalledWith("copyplan-1", "copy");
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Numbered copy complete")
    );
    expect(screen.getByRole("status")).toHaveTextContent("3 files copied to exports, with concat.txt.");
  });

  it("does not offer to start when a name is taken, and says why", async () => {
    const onPrepare = vi.fn().mockResolvedValue(
      preparedResponse({
        canStart: false,
        collisionCount: 1,
        collisionSamples: [{ relativePath: "020_a.mp4", reason: "exists" }],
        sequence: {
          id: 5,
          blockedReason:
            "1 of these names already exists in exports. Nothing is overwritten; choose an empty folder.",
          targetNames: ["010_b.mp4", "020_a.mp4", "030_b.mp4"],
        },
      })
    );
    render(
      <SequenceExportCopyDialog
        open
        sequenceName="Act one"
        clipCount={3}
        onPrepare={onPrepare}
        onStart={vi.fn()}
        onClose={vi.fn()}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    });

    expect(await screen.findByText(/choose an empty folder/)).toBeTruthy();
    expect(screen.getByText("020_a.mp4", { selector: ".review-results-copy-samples li" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy 3 files" })).toBeDisabled();
  });

  it("shows the refusal from main, such as missing positions", async () => {
    const onPrepare = vi.fn().mockResolvedValue({
      success: false,
      code: "SEQUENCE_ENTRIES_MISSING",
      error: "Cannot export while clips are missing: position 2.",
    });
    render(
      <SequenceExportCopyDialog
        open
        sequenceName="Act one"
        clipCount={3}
        onPrepare={onPrepare}
        onClose={vi.fn()}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("position 2");
  });
});
