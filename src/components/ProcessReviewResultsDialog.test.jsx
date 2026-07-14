import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ProcessReviewResultsDialog from "./ProcessReviewResultsDialog";

const videos = [
  { instanceId: 1, fingerprint: "a", reviewState: "pick" },
  { instanceId: 2, fingerprint: "b", reviewState: "reviewed" },
  {
    instanceId: 3,
    fingerprint: "c",
    reviewState: "reject",
    isElectronFile: true,
    fullPath: "/library/reject.mp4",
  },
  { instanceId: 4, fingerprint: "d", reviewState: "unreviewed" },
];

describe("ProcessReviewResultsDialog", () => {
  it("shows exact pre-scoped counts and sends only local rejects", async () => {
    const onTrashRejects = vi.fn().mockResolvedValue(undefined);
    render(
      <ProcessReviewResultsDialog
        open
        videos={videos}
        scopeLabel="batch/a"
        onClose={vi.fn()}
        onTrashRejects={onTrashRejects}
        onExportManifest={vi.fn()}
      />
    );

    expect(screen.getByText(/batch\/a · 4 files · 4 unique/i)).toBeInTheDocument();
    expect(screen.getByText("3 reviewed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move 1 to Bin" }));

    await waitFor(() => expect(onTrashRejects).toHaveBeenCalledTimes(1));
    expect(onTrashRejects).toHaveBeenCalledWith([videos[2]]);
  });

  it("disables actions until the supplied scope is ready", () => {
    render(
      <ProcessReviewResultsDialog
        open
        videos={videos}
        processingReady={false}
        readinessMessage="Indexing is still in progress."
        onTrashRejects={vi.fn()}
        onExportManifest={vi.fn()}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent("Indexing is still in progress.");
    expect(screen.getByRole("button", { name: "Move 1 to Bin" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export JSON" })).toBeDisabled();
  });

  it("never submits part of an over-limit reject set", () => {
    const onTrashRejects = vi.fn();
    const rejects = Array.from({ length: 2_001 }, (_, index) => ({
      instanceId: index + 1,
      reviewState: "reject",
      isElectronFile: true,
      fullPath: `/library/reject-${index}.mp4`,
    }));
    render(
      <ProcessReviewResultsDialog
        open
        videos={rejects}
        onTrashRejects={onTrashRejects}
        onExportManifest={vi.fn()}
      />
    );

    expect(screen.getByText(/safety limit is 2,000/i)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Move 2,001 to Bin" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onTrashRejects).not.toHaveBeenCalled();
  });

  it("exports through its owner and closes with Escape", async () => {
    const onExportManifest = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <ProcessReviewResultsDialog
        open
        videos={videos}
        onClose={onClose}
        onTrashRejects={vi.fn()}
        onExportManifest={onExportManifest}
      />
    );

    const exportButton = screen.getByRole("button", { name: "Export JSON" });
    fireEvent.click(exportButton);
    fireEvent.click(exportButton);
    await waitFor(() => expect(onExportManifest).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog open while a native result action is pending", async () => {
    let finishExport;
    const onExportManifest = vi.fn(
      () => new Promise((resolve) => {
        finishExport = resolve;
      })
    );
    const onClose = vi.fn();
    render(
      <ProcessReviewResultsDialog
        open
        videos={videos}
        onClose={onClose}
        onTrashRejects={vi.fn()}
        onExportManifest={onExportManifest}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
    await waitFor(() => expect(onExportManifest).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => finishExport());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("hides and inerts background siblings only while open", () => {
    const renderDialog = (open) => (
      <>
        <main data-testid="background">Gallery</main>
        <ProcessReviewResultsDialog
          open={open}
          videos={videos}
          onClose={vi.fn()}
          onTrashRejects={vi.fn()}
          onExportManifest={vi.fn()}
        />
      </>
    );
    const { rerender } = render(renderDialog(true));
    const background = screen.getByTestId("background");

    expect(background).toHaveAttribute("aria-hidden", "true");
    expect(background).toHaveAttribute("inert");

    rerender(renderDialog(false));
    expect(background).not.toHaveAttribute("aria-hidden");
    expect(background).not.toHaveAttribute("inert");
  });
});
