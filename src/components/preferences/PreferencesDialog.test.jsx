import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PreferencesDialog, { ipcErrorMessage } from "./PreferencesDialog";

const playbackProps = () => ({
  playbackMode: "balanced",
  onPlaybackModeChange: vi.fn(),
  proxyPlaybackEnabled: false,
  proxyPlaybackAvailable: true,
  onProxyPlaybackToggle: vi.fn(),
  hoverAudioEnabled: false,
  onHoverAudioToggle: vi.fn(),
  playbackDetailsVisible: false,
  onPlaybackDetailsToggle: vi.fn(),
  playbackCapabilityStatus: "Linux: hardware video decode was not detected; software decoding is likely.",
});

const installApi = () => {
  let profileListener = null;
  const profiles = {
    list: vi.fn().mockResolvedValue({
      success: true,
      profiles: [
        { id: "default", name: "Default" },
        { id: "wan", name: "Wan renders" },
      ],
      activeProfileId: "default",
    }),
    setActive: vi.fn().mockResolvedValue({ success: true }),
    create: vi.fn().mockResolvedValue({ success: true }),
    rename: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue({ success: false, cancelled: true }),
    onChanged: vi.fn((callback) => {
      profileListener = callback;
      return () => {
        profileListener = null;
      };
    }),
  };
  const comfyQueue = {
    getConnection: vi.fn().mockResolvedValue({ enabled: false, url: "http://127.0.0.1:8188", outputDir: null }),
    setConnection: vi.fn(async (value) => ({ ...value, outputDir: value.outputDir || null })),
    chooseOutputDir: vi.fn().mockResolvedValue({ canceled: false, path: "/comfy/output" }),
    testConnection: vi.fn().mockResolvedValue({ ok: true, url: "http://127.0.0.1:8188", running: 1, pending: 2 }),
  };
  const dataLocation = {
    getState: vi.fn().mockResolvedValue({
      effectivePath: "/home/user/.config/video-swarm",
      defaultPath: "/home/user/.config/video-swarm",
      isCommandLineOverride: false,
    }),
  };
  window.electronAPI = { profiles, comfyQueue, dataLocation };
  return { profiles, comfyQueue, dataLocation, fireProfileChanged: () => profileListener?.() };
};

describe("PreferencesDialog", () => {
  let api;
  beforeEach(() => {
    api = installApi();
  });
  afterEach(() => {
    delete window.electronAPI;
  });

  it("renders nothing while closed", () => {
    render(<PreferencesDialog open={false} onClose={vi.fn()} {...playbackProps()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on Playback, with each mode explained, and closes on Escape", () => {
    const props = playbackProps();
    const onClose = vi.fn();
    render(<PreferencesDialog open onClose={onClose} {...props} />);
    const dialog = screen.getByRole("dialog", { name: "Preferences" });
    expect(within(dialog).getByRole("tab", { name: "Playback" })).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Playback" }));
    expect(screen.getByRole("radio", { name: /Balanced/ })).toBeChecked();
    expect(screen.getByText(/Keeps still first-frame previews/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Static \+ Hover/ }));
    expect(props.onPlaybackModeChange).toHaveBeenCalledWith("static-hover");
    fireEvent.click(screen.getByRole("checkbox", { name: /Play audio on hover/ }));
    expect(props.onHoverAudioToggle).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Playback details in the status line/ }));
    expect(props.onPlaybackDetailsToggle).toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("explains why proxies are unavailable", () => {
    render(<PreferencesDialog open onClose={vi.fn()} {...playbackProps()} proxyPlaybackAvailable={false} />);
    expect(screen.getByRole("checkbox", { name: /Playback proxies/ })).toBeDisabled();
    expect(screen.getByText(/Needs FFmpeg/)).toBeInTheDocument();
  });

  it("moves between sections with the arrow keys", () => {
    render(<PreferencesDialog open onClose={vi.fn()} {...playbackProps()} />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Playback" }), { key: "ArrowDown" });
    expect(screen.getByRole("tab", { name: "Profiles" })).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Profiles" }));
    fireEvent.keyDown(document.activeElement, { key: "End" });
    expect(screen.getByRole("tab", { name: "ComfyUI" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(document.activeElement, { key: "ArrowDown" });
    expect(screen.getByRole("tab", { name: "Playback" })).toHaveAttribute("aria-selected", "true");
  });

  it("lists, switches, renames and creates profiles", async () => {
    render(<PreferencesDialog open onClose={vi.fn()} initialSection="profiles" {...playbackProps()} />);
    const list = await screen.findByRole("list", { name: "Profiles" });
    await within(list).findByText("Wan renders");
    expect(within(list).getByText("Active")).toBeInTheDocument();

    fireEvent.click(within(list).getByRole("button", { name: "Switch" }));
    await waitFor(() => expect(api.profiles.setActive).toHaveBeenCalledWith("wan"));
    expect(await screen.findByRole("status")).toHaveTextContent("Switched to Wan renders.");

    const rename = screen.getByRole("textbox", { name: "Name of the active profile" });
    expect(rename).toHaveValue("Default");
    fireEvent.change(rename, { target: { value: "Everyday" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(api.profiles.rename).toHaveBeenCalledWith("default", "Everyday"));

    fireEvent.change(screen.getByRole("textbox", { name: "New profile" }), { target: { value: "  LTX  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create and switch" }));
    await waitFor(() => expect(api.profiles.create).toHaveBeenCalledWith("LTX"));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "New profile" })).toHaveValue(""));
  });

  it("leaves deletion to the native confirmation and says nothing when it is cancelled", async () => {
    render(<PreferencesDialog open onClose={vi.fn()} initialSection="profiles" {...playbackProps()} />);
    await screen.findByText("Wan renders");
    fireEvent.click(screen.getByRole("button", { name: "Delete profile Wan renders" }));
    await waitFor(() => expect(api.profiles.delete).toHaveBeenCalledWith("wan"));
    await waitFor(() => expect(api.profiles.list).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reloads the profile list when the active profile changes elsewhere", async () => {
    render(<PreferencesDialog open onClose={vi.fn()} initialSection="profiles" {...playbackProps()} />);
    await screen.findByText("Wan renders");
    api.profiles.list.mockResolvedValueOnce({
      success: true,
      profiles: [{ id: "default", name: "Default" }],
      activeProfileId: "default",
    });
    await act(async () => {
      api.fireProfileChanged();
    });
    await waitFor(() => expect(screen.queryByText("Wan renders")).toBeNull());
    expect(screen.getByRole("button", { name: "Delete profile Default" })).toBeDisabled();
  });

  it("shows the data location and hands changes to its own dialog", async () => {
    const onOpenDataLocation = vi.fn();
    render(
      <PreferencesDialog
        open
        onClose={vi.fn()}
        initialSection="data"
        onOpenDataLocation={onOpenDataLocation}
        {...playbackProps()}
      />
    );
    expect(await screen.findByText("/home/user/.config/video-swarm")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change data location…" }));
    expect(onOpenDataLocation).toHaveBeenCalled();
  });

  it("ignores Escape while the data location dialog is open over it", () => {
    const onClose = vi.fn();
    render(<PreferencesDialog open onClose={onClose} suspended {...playbackProps()} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("tests and saves the ComfyUI connection", async () => {
    render(<PreferencesDialog open onClose={vi.fn()} initialSection="comfy" {...playbackProps()} />);
    const address = await screen.findByRole("textbox", { name: "Address" });
    await waitFor(() => expect(address).toHaveValue("http://127.0.0.1:8188"));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(api.comfyQueue.testConnection).toHaveBeenCalledWith("http://127.0.0.1:8188"));
    expect(await screen.findByRole("status")).toHaveTextContent("1 running, 2 waiting");
    expect(screen.getByRole("status")).toHaveTextContent("Nothing was sent.");

    fireEvent.click(screen.getByRole("checkbox", { name: /Connect to ComfyUI/ }));
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "ComfyUI's output folder" })).toHaveValue("/comfy/output")
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.comfyQueue.setConnection).toHaveBeenCalledWith({
        enabled: true,
        url: "http://127.0.0.1:8188",
        outputDir: "/comfy/output",
      })
    );
    expect(await screen.findByText("Saved. Re-rendering is on.")).toBeInTheDocument();
  });

  it("shows the main process's reason when a connection is refused", async () => {
    api.comfyQueue.setConnection.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'comfy:connection:set': ComfyConnectionError: Choose ComfyUI's output folder, so finals can be saved beside their drafts"
      )
    );
    render(<PreferencesDialog open onClose={vi.fn()} initialSection="comfy" {...playbackProps()} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Address" })).toHaveValue("http://127.0.0.1:8188"));
    fireEvent.click(screen.getByRole("checkbox", { name: /Connect to ComfyUI/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /^Choose ComfyUI's output folder, so finals can be saved beside their drafts$/
    );
  });
});

describe("ipcErrorMessage", () => {
  it("strips the IPC wrapper and error class", () => {
    expect(ipcErrorMessage(new Error("Error invoking remote method 'x:y': Error: No folder at /a"))).toBe(
      "No folder at /a"
    );
    expect(ipcErrorMessage("plain")).toBe("plain");
  });
});
