import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import TransferSelectionDialog from "./TransferSelectionDialog";

const indexedClip = (id, name) => ({
  id: `clip-${id}`,
  instanceId: id,
  name,
  isElectronFile: true,
  fullPath: `/library/${name}`,
});

const preparedPlan = {
  planId: "transfer-plan-1",
  destinationLabel: "Keepers",
  mediaCount: 2,
  totalBytes: 4 * 1024 * 1024,
  collisionCount: 0,
  collisionSamples: [],
  missingCount: 0,
  failureCount: 0,
  failureSamples: [],
  totalFiles: 2,
  copyableCount: 2,
  canStart: true,
};

const dialogProps = (overrides = {}) => ({
  open: true,
  videos: [indexedClip(11, "one.mp4"), indexedClip(12, "two.mp4")],
  onClose: vi.fn(),
  onPrepareTransfer: vi.fn().mockResolvedValue(preparedPlan),
  onStartTransfer: vi.fn().mockResolvedValue({
    success: true,
    copiedCount: 2,
    planId: "transfer-plan-1",
  }),
  onCancelTransfer: vi.fn().mockResolvedValue({ cancelled: true }),
  ...overrides,
});

describe("TransferSelectionDialog", () => {
  it("names the selected rows by instance id rather than by path", async () => {
    const props = dialogProps();
    render(<TransferSelectionDialog {...props} />);

    expect(screen.getByText("2 selected clips")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Choose destination…" }));

    await waitFor(() =>
      expect(props.onPrepareTransfer).toHaveBeenCalledWith({
        instanceIds: [11, 12],
        destinationPath: null,
        layout: "structured",
        reusePlanId: null,
      })
    );
    const payload = props.onPrepareTransfer.mock.calls[0][0];
    expect(payload).not.toHaveProperty("videos");
    expect(payload).not.toHaveProperty("paths");
  });

  it("excludes clips that have no catalog instance and says so", () => {
    render(
      <TransferSelectionDialog
        {...dialogProps({
          videos: [
            indexedClip(11, "one.mp4"),
            // A dragged-in web file has no indexed instance to name.
            { id: "web-1", name: "web.mp4", isElectronFile: false },
          ],
        })}
      />
    );

    expect(screen.getByText("1 selected clip")).toBeInTheDocument();
    expect(
      screen.getByText(/1 selected clip is not an indexed local file/)
    ).toBeInTheDocument();
  });

  it("disables transferring when nothing in the selection qualifies", () => {
    const props = dialogProps({
      videos: [{ id: "web-1", name: "web.mp4", isElectronFile: false }],
    });
    render(<TransferSelectionDialog {...props} />);

    expect(
      screen.getByText("Nothing in this selection can be transferred.")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Choose destination…" })
    ).toBeDisabled();
  });

  it("runs an explicit copy through the shared transfer panel", async () => {
    const props = dialogProps();
    render(<TransferSelectionDialog {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose destination…" }));
    const copyButton = await screen.findByRole("button", {
      name: /Copy 2 files; keep originals/i,
    });
    await act(async () => {
      fireEvent.click(copyButton);
    });

    expect(props.onStartTransfer).toHaveBeenCalledWith(
      "transfer-plan-1",
      "copy"
    );
    expect(screen.getByText("Copy complete")).toBeInTheDocument();
  });

  it("cancels the prepared plan when dismissed", async () => {
    const props = dialogProps();
    const { rerender } = render(<TransferSelectionDialog {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose destination…" }));
    await screen.findByRole("button", { name: /Copy 2 files/i });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close transfer" }));
    });
    expect(props.onClose).toHaveBeenCalled();

    rerender(<TransferSelectionDialog {...props} open={false} />);
    await waitFor(() =>
      expect(props.onCancelTransfer).toHaveBeenCalledWith("transfer-plan-1")
    );
  });

  it("surfaces a preflight failure without opening a transfer", async () => {
    const props = dialogProps({
      onPrepareTransfer: vi
        .fn()
        .mockRejectedValue(new Error("Choose a destination outside the source library")),
    });
    render(<TransferSelectionDialog {...props} />);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Choose destination…" })
      );
    });

    expect(
      screen.getByText("Choose a destination outside the source library")
    ).toBeInTheDocument();
    expect(props.onStartTransfer).not.toHaveBeenCalled();
  });
});
