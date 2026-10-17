import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CompanionSendDialog from "./CompanionSendDialog";

describe("CompanionSendDialog", () => {
  afterEach(() => {
    delete window.electronAPI;
  });

  it("opens on the dry run and groups skips and refusals by reason", async () => {
    const send = vi.fn(async ({ instanceIds }) => ({
      success: true,
      results: {
        [instanceIds[0]]: { result: "sent", why: "", estimate: 30 },
        [instanceIds[1]]: { result: "skipped", why: "Sent before" },
        [instanceIds[2]]: { result: "refused", why: "Carries no prompt" },
      },
    }));
    window.electronAPI = { companion: { send } };
    const onClose = vi.fn();
    render(
      <CompanionSendDialog
        open
        action={{ id: "polish", label: "Polish", send: "Send to polish" }}
        companionName="Helper"
        videos={[{ instanceId: 1 }, { instanceId: 2 }, { instanceId: 3 }, { name: "web.mp4" }]}
        onClose={onClose}
      />
    );
    expect(screen.getByRole("dialog", { name: "Send to polish" })).toBeInTheDocument();
    expect(await screen.findByText("1 will be sent")).toBeInTheDocument();
    expect(screen.getByText(/1 skipped · 1 cannot be sent/)).toBeInTheDocument();
    expect(screen.getByText("Sent before")).toBeInTheDocument();
    expect(screen.getByText("Carries no prompt")).toBeInTheDocument();
    expect(screen.getByText(/1 clip is not an indexed local file/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Send again clips sent before" }));
    await waitFor(() => expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ again: true })));

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
