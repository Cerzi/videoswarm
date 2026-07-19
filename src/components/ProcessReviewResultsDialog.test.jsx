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

const preparedPlan = {
  planId: "copy-plan-1",
  destinationLabel: "Accepted clips",
  mediaCount: 1,
  sidecarCount: 0,
  totalBytes: 2 * 1024 * 1024,
  collisionCount: 0,
  collisionSamples: [],
  missingCount: 0,
  failureCount: 0,
  failureSamples: [],
  totalFiles: 1,
  copyableCount: 1,
  canStart: true,
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const dialogProps = (overrides = {}) => ({
  open: true,
  videos,
  scopeLabel: "batch/a",
  onClose: vi.fn(),
  onTrashRejects: vi.fn().mockResolvedValue(undefined),
  onPrepareAcceptedCopy: vi.fn().mockResolvedValue(preparedPlan),
  onStartAcceptedCopy: vi.fn().mockResolvedValue({
    success: true,
    copiedCount: 1,
  }),
  onCancelAcceptedCopy: vi.fn().mockResolvedValue({ cancelled: true }),
  ...overrides,
});

describe("ProcessReviewResultsDialog", () => {
  it("shows exact pre-scoped counts and sends only local rejects", async () => {
    const props = dialogProps();
    render(<ProcessReviewResultsDialog {...props} />);

    expect(screen.getByText(/batch\/a · 4 files · 4 unique/i)).toBeInTheDocument();
    expect(screen.getByText("3 reviewed")).toBeInTheDocument();
    expect(screen.getByText(/Copy 1 accepted file/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move 1 to Bin" }));

    await waitFor(() => expect(props.onTrashRejects).toHaveBeenCalledTimes(1));
    expect(props.onTrashRejects).toHaveBeenCalledWith([videos[2]]);
  });

  it("disables result actions until the supplied scope is ready", () => {
    const props = dialogProps({
      processingReady: false,
      readinessMessage: "Indexing is still in progress.",
    });
    render(<ProcessReviewResultsDialog {...props} />);

    expect(screen.getByRole("status")).toHaveTextContent("Indexing is still in progress.");
    expect(screen.getByRole("button", { name: "Move 1 to Bin" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Choose destination…" })).toBeDisabled();
  });

  it("disables accepted copy when the scope contains no accepted clips", () => {
    const props = dialogProps({
      videos: videos.map((video) => ({ ...video, reviewState: "reviewed" })),
    });
    render(<ProcessReviewResultsDialog {...props} />);

    expect(screen.getByText(/Copy 0 accepted files/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose destination…" })).toBeDisabled();
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
        {...dialogProps({ videos: rejects, onTrashRejects })}
      />
    );

    expect(screen.getByText(/safety limit is 2,000/i)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Move 2,001 to Bin" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onTrashRejects).not.toHaveBeenCalled();
  });

  it("prepares with the sidecar option, reports progress, and shows success", async () => {
    const start = deferred();
    const props = dialogProps({
      onPrepareAcceptedCopy: vi.fn().mockResolvedValue({
        ...preparedPlan,
        sidecarCount: 1,
        totalFiles: 2,
        copyableCount: 2,
      }),
      onStartAcceptedCopy: vi.fn(() => start.promise),
    });
    const { rerender } = render(<ProcessReviewResultsDialog {...props} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /include adjacent workflow json/i }));
    fireEvent.click(screen.getByRole("button", { name: "Choose destination…" }));

    await waitFor(() => {
      expect(props.onPrepareAcceptedCopy).toHaveBeenCalledWith({ includeSidecars: true });
      expect(screen.getByRole("button", { name: "Copy 2 files" })).toBeEnabled();
    });
    expect(screen.getByText("Accepted clips")).toBeInTheDocument();
    expect(screen.getByText("2.0 MB")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy 2 files" }));
    expect(props.onStartAcceptedCopy).toHaveBeenCalledWith("copy-plan-1");

    rerender(
      <ProcessReviewResultsDialog
        {...props}
        acceptedCopyProgress={{
          planId: "copy-plan-1",
          phase: "preflight",
          processed: 2,
          total: 2,
        }}
      />
    );
    expect(screen.getByRole("progressbar", {
      name: "Accepted clip copy progress",
    })).toHaveAttribute("aria-valuenow", "0");

    rerender(
      <ProcessReviewResultsDialog
        {...props}
        acceptedCopyProgress={{
          planId: "copy-plan-1",
          phase: "copying",
          processed: 1,
          total: 2,
        }}
      />
    );
    const progress = screen.getByRole("progressbar", {
      name: "Accepted clip copy progress",
    });
    expect(progress).toHaveAttribute("aria-valuenow", "1");
    expect(progress).toHaveAttribute("aria-valuemax", "2");
    expect(screen.getByText("Copying 1 of 2 files…")).toBeInTheDocument();

    await act(async () => {
      start.resolve({
        success: true,
        copiedCount: 1,
        sidecarCopiedCount: 1,
      });
      await start.promise;
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Copy complete");
    expect(screen.getByText(/1 media file copied · 1 workflow JSON/i)).toBeInTheDocument();
  });

  it("preflights collisions without displaying absolute paths and can abandon the plan", async () => {
    const props = dialogProps({
      onPrepareAcceptedCopy: vi.fn().mockResolvedValue({
        ...preparedPlan,
        destinationLabel: "/private/exports/Accepted",
        mediaCount: 4,
        totalFiles: 4,
        collisionCount: 2,
        collisionSamples: [
          "nested/existing.mp4",
          "/private/exports/Accepted/secret.mp4",
        ],
        copyableCount: 2,
      }),
    });
    render(<ProcessReviewResultsDialog {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose destination…" }));
    expect(await screen.findByText("nested/existing.mp4")).toBeInTheDocument();
    expect(screen.queryByText(/private\/exports/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Skip existing and copy 2" })
    ).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Choose another folder" }));
    expect(props.onCancelAcceptedCopy).toHaveBeenCalledWith("copy-plan-1");
    expect(screen.getByRole("button", { name: "Choose destination…" })).toBeEnabled();
  });

  it("returns quietly to idle when destination selection is cancelled", async () => {
    const props = dialogProps({
      onPrepareAcceptedCopy: vi.fn().mockResolvedValue({ cancelled: true }),
    });
    render(<ProcessReviewResultsDialog {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose destination…" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Choose destination…" })).toBeEnabled();
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(props.onCancelAcceptedCopy).not.toHaveBeenCalled();
  });

  it("blocks Escape while preparing, then allows close after the picker is cancelled", async () => {
    const prepare = deferred();
    const onClose = vi.fn();
    const props = dialogProps({
      onClose,
      onPrepareAcceptedCopy: vi.fn(() => prepare.promise),
    });
    render(<ProcessReviewResultsDialog {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose destination…" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      prepare.resolve({ cancelled: true });
      await prepare.promise;
    });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("cancels a prepared plan when Escape closes the dialog", async () => {
    const props = dialogProps();
    render(<ProcessReviewResultsDialog {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose destination…" }));
    await screen.findByRole("button", { name: "Copy 1 file" });
    fireEvent.keyDown(document, { key: "Escape" });

    expect(props.onCancelAcceptedCopy).toHaveBeenCalledTimes(1);
    expect(props.onCancelAcceptedCopy).toHaveBeenCalledWith("copy-plan-1");
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("requests cooperative cancellation and reports the terminal partial result", async () => {
    const start = deferred();
    const props = dialogProps({
      onStartAcceptedCopy: vi.fn(() => start.promise),
    });
    render(<ProcessReviewResultsDialog {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose destination…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy 1 file" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel copy" }));
    expect(props.onCancelAcceptedCopy).toHaveBeenCalledWith("copy-plan-1");
    expect(screen.getByRole("button", { name: "Cancel requested" })).toBeDisabled();

    await act(async () => {
      start.resolve({
        success: true,
        cancelled: true,
        copiedCount: 1,
        skippedExistingCount: 2,
      });
      await start.promise;
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Copy cancelled");
    expect(screen.getByText(/2 existing skipped/i)).toBeInTheDocument();
  });

  it("surfaces a failed cancellation request and allows retry", async () => {
    const start = deferred();
    const props = dialogProps({
      onStartAcceptedCopy: vi.fn(() => start.promise),
      onCancelAcceptedCopy: vi
        .fn()
        .mockResolvedValueOnce({
          success: false,
          error: "Cancellation was not accepted.",
        })
        .mockResolvedValueOnce({ success: true, cancelled: true }),
    });
    render(<ProcessReviewResultsDialog {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose destination…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy 1 file" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel copy" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cancellation was not accepted"
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel copy" }));
    await waitFor(() => expect(props.onCancelAcceptedCopy).toHaveBeenCalledTimes(2));

    await act(async () => {
      start.resolve({ success: false, cancelled: true, copiedCount: 0 });
      await start.promise;
    });
  });

  it("announces failures and bounds relative failure samples", async () => {
    const props = dialogProps({
      onStartAcceptedCopy: vi.fn().mockResolvedValue({
        success: false,
        copiedCount: 1,
        failedCount: 8,
        failureSamples: [
          "a.mp4",
          "b.mp4",
          "c.mp4",
          "d.mp4",
          "e.mp4",
          "f.mp4",
          "g.mp4",
          "/private/hidden.mp4",
        ],
      }),
    });
    render(<ProcessReviewResultsDialog {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose destination…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy 1 file" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Copy finished with issues");
    expect(alert).toHaveTextContent("8 failed");
    expect(screen.getByText("f.mp4")).toBeInTheDocument();
    expect(screen.queryByText("g.mp4")).not.toBeInTheDocument();
    expect(screen.queryByText(/private\/hidden/)).not.toBeInTheDocument();
  });

  it("discloses bounded preflight failures with safe public detail", async () => {
    const props = dialogProps({
      onPrepareAcceptedCopy: vi.fn().mockResolvedValue({
        ...preparedPlan,
        failureCount: 2,
        failureSamples: [
          {
            relativePath: "batch/clip.workflow.json",
            message: "The sidecar is a symbolic link.",
          },
          { relativePath: "/private/hidden.json", message: "secret" },
        ],
      }),
    });
    render(<ProcessReviewResultsDialog {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose destination…" }));

    expect(await screen.findByText(/2 additional files could not be prepared/i))
      .toBeInTheDocument();
    expect(screen.getByText(/batch\/clip\.workflow\.json — The sidecar is a symbolic link/i))
      .toBeInTheDocument();
    expect(screen.queryByText(/private\/hidden/)).not.toBeInTheDocument();
  });

  it("retires a consumed plan and shows a fatal native start error", async () => {
    const props = dialogProps({
      onStartAcceptedCopy: vi.fn().mockResolvedValue({
        success: false,
        planId: "copy-plan-1",
        code: "ACCEPTED_COPY_DESTINATION_UNSAFE",
        error: "The selected destination changed after preflight.",
      }),
    });
    render(<ProcessReviewResultsDialog {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose destination…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy 1 file" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Copy could not be completed");
    expect(alert).toHaveTextContent("destination changed after preflight");
    expect(screen.getByRole("button", { name: "Copy again" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Copy 1 file" })).not.toBeInTheDocument();
  });

  it("retires an expired plan even when native no longer returns its id", async () => {
    const props = dialogProps({
      onStartAcceptedCopy: vi.fn().mockResolvedValue({
        success: false,
        planId: null,
        code: "ACCEPTED_COPY_PLAN_EXPIRED",
        error: "The Copy Accepted plan expired. Choose a destination again.",
      }),
    });
    render(<ProcessReviewResultsDialog {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose destination…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy 1 file" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "plan expired"
    );
    expect(screen.getByRole("button", { name: "Copy again" })).toBeEnabled();
  });

  it("cancels a pending plan when unmounted", async () => {
    const props = dialogProps();
    const { unmount } = render(<ProcessReviewResultsDialog {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose destination…" }));
    await screen.findByRole("button", { name: "Copy 1 file" });
    unmount();

    expect(props.onCancelAcceptedCopy).toHaveBeenCalledTimes(1);
    expect(props.onCancelAcceptedCopy).toHaveBeenCalledWith("copy-plan-1");
  });

  it("cancels a plan that arrives after the dialog unmounts", async () => {
    const prepare = deferred();
    const props = dialogProps({
      onPrepareAcceptedCopy: vi.fn(() => prepare.promise),
    });
    const { unmount } = render(<ProcessReviewResultsDialog {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose destination…" }));
    unmount();
    await act(async () => {
      prepare.resolve(preparedPlan);
      await prepare.promise;
    });

    expect(props.onCancelAcceptedCopy).toHaveBeenCalledWith("copy-plan-1");
  });

  it("hides and inerts background siblings only while open", () => {
    const props = dialogProps();
    const renderDialog = (open) => (
      <>
        <main data-testid="background">Gallery</main>
        <ProcessReviewResultsDialog {...props} open={open} />
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
