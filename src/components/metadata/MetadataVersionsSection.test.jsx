import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import MetadataVersionsSection, {
  VERSION_SIBLINGS_DEBOUNCE_MS,
  formatVersionLocation,
} from "./MetadataVersionsSection";

const KEY = `gk1-${"a".repeat(32)}`;

const versions = [
  { fingerprint: "ff", instanceId: 2, rootPath: "/out/requeue", relativePath: "done/final.mp4", width: 1280, height: 720, durationMs: 10000, mtimeMs: 2, instanceCount: 1, isSelf: false },
  { fingerprint: "fo", instanceId: 3, rootPath: "/out/other", relativePath: "other.mp4", width: 1280, height: 720, durationMs: 5000, mtimeMs: 1, instanceCount: 1, isSelf: false },
  { fingerprint: "fh", instanceId: 4, rootPath: "/out/requeue", relativePath: "hidden.mp4", width: 960, height: 540, durationMs: 10000, mtimeMs: 1, instanceCount: 1, isSelf: false },
  { fingerprint: "fd", instanceId: 1, rootPath: "/out/requeue", relativePath: "queued/draft.mp4", width: 640, height: 360, durationMs: 10000, mtimeMs: 1, instanceCount: 1, isSelf: true },
];

function setup({ versionCount = 4, siblings } = {}) {
  window.electronAPI = {
    generationVersions: {
      siblings: siblings || vi.fn(async () => ({ success: true, generationKey: KEY, versions, truncated: false })),
    },
  };
  const onSelect = vi.fn();
  const generationVersions = {
    index: new Map([["draft", { generationKey: KEY, versionCount, superseded: true }]]),
    resolveTarget: (instanceId) =>
      instanceId === 2 ? "available" : instanceId === 4 ? "filtered" : "elsewhere",
    onSelect,
  };
  const video = { id: "draft", instanceId: 1, generationKey: KEY };
  return { onSelect, generationVersions, video };
}

async function flush() {
  await act(async () => {
    vi.advanceTimersByTime(VERSION_SIBLINGS_DEBOUNCE_MS + 1);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("MetadataVersionsSection", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    delete window.electronAPI;
  });

  it("lists siblings in version order and reveals only those in view", async () => {
    const { onSelect, generationVersions, video } = setup();
    render(<MetadataVersionsSection video={video} generationVersions={generationVersions} />);
    expect(screen.getByText("Reading versions…")).toBeTruthy();
    await flush();

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0].textContent).toMatch(/1280×720 · 10\.0 s/);
    expect(items[0].textContent).toMatch(/Best/);
    expect(items[3].textContent).toMatch(/This clip/);
    expect(screen.getByText("In a folder that is not open")).toBeTruthy();
    expect(screen.getByText("Hidden by the current filters or folder scope")).toBeTruthy();

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("does not ask for siblings of a clip with a single version or when inactive", async () => {
    const single = setup({ versionCount: 1 });
    const { container, rerender } = render(
      <MetadataVersionsSection video={single.video} generationVersions={single.generationVersions} />
    );
    await flush();
    expect(container.textContent).toBe("");
    expect(window.electronAPI.generationVersions.siblings).not.toHaveBeenCalled();

    const many = setup();
    rerender(
      <MetadataVersionsSection video={many.video} active={false} generationVersions={many.generationVersions} />
    );
    await flush();
    expect(window.electronAPI.generationVersions.siblings).not.toHaveBeenCalled();
  });

  it("drops a stale response after rapid navigation", async () => {
    let resolveFirst;
    const siblings = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementation(async () => ({ success: true, versions: versions.slice(0, 2), truncated: true }));
    const { generationVersions, video } = setup({ siblings });
    generationVersions.index.set("other", { generationKey: KEY, versionCount: 4 });
    const { rerender } = render(
      <MetadataVersionsSection video={video} generationVersions={generationVersions} />
    );
    await flush();
    rerender(
      <MetadataVersionsSection
        video={{ id: "other", instanceId: 9, generationKey: KEY }}
        generationVersions={generationVersions}
      />
    );
    await flush();
    await act(async () => {
      resolveFirst({ success: true, versions, truncated: false });
      await Promise.resolve();
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Showing the first 2 versions.")).toBeTruthy();
  });

  it("reports a failed read", async () => {
    const { generationVersions, video } = setup({ siblings: vi.fn(async () => ({ success: false })) });
    render(<MetadataVersionsSection video={video} generationVersions={generationVersions} />);
    await flush();
    expect(screen.getByText("Versions could not be read.")).toBeTruthy();
  });

  it("formats locations from the owning root", () => {
    expect(formatVersionLocation({ rootPath: "C:\\out\\finals\\", relativePath: "a.mp4" })).toBe("finals/a.mp4");
  });
});
