import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import LoadingProgress, {
  formatActivity,
  formatElapsed,
  formatMemoryMB,
} from "./LoadingProgress";

const STARTED_AT = new Date("2026-07-13T12:00:00.000Z").getTime();

function makeStatus(overrides = {}) {
  return {
    scanId: "scan-1",
    phase: "enumerating",
    rootPath: "/collections/wan-outputs",
    currentPath: "/collections/wan-outputs/batch-042",
    recursive: true,
    directoriesScanned: 18,
    entriesInspected: 930,
    videosDiscovered: 412,
    completed: 0,
    total: null,
    fingerprintsReused: 0,
    warnings: 0,
    startedAt: STARTED_AT,
    updatedAt: STARTED_AT + 64_000,
    message: "Discovering video files",
    error: null,
    ...overrides,
  };
}

describe("LoadingProgress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(STARTED_AT + 65_000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows an accessible indeterminate discovery state with live counters", () => {
    const onCancel = vi.fn();

    render(
      <LoadingProgress
        status={makeStatus()}
        memoryStatus={{
          source: "app",
          currentMemoryMB: 384.4,
          totalMemoryMB: 32_768,
          memoryPressure: 1,
        }}
        onCancel={onCancel}
      />
    );

    expect(
      screen.getByRole("dialog", { name: "Opening collection" })
    ).toBeInTheDocument();
    expect(screen.getByText("/collections/wan-outputs")).toBeInTheDocument();
    expect(screen.getByText("batch-042")).toBeInTheDocument();
    expect(screen.getByText("412 videos found so far")).toBeInTheDocument();
    expect(screen.getByText("384 MB", { exact: false })).toBeInTheDocument();

    const progressbar = screen.getByRole("progressbar", {
      name: "Scanning folders",
    });
    expect(progressbar).not.toHaveAttribute("aria-valuenow");
    expect(progressbar).toHaveAttribute(
      "aria-valuetext",
      "412 videos found so far"
    );

    expect(screen.getByText("Videos found").nextSibling).toHaveTextContent("412");
    expect(screen.getByText("Folders scanned").nextSibling).toHaveTextContent("18");
    expect(screen.queryByText("Entries inspected")).not.toBeInTheDocument();
    expect(screen.getByText("Discover").closest("li")).toHaveAttribute(
      "aria-current",
      "step"
    );

    const cancel = screen.getByRole("button", { name: /cancel scan/i });
    expect(cancel).toHaveFocus();
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("uses the known phase total for determinate indexing progress", () => {
    render(
      <LoadingProgress
        status={makeStatus({
          phase: "indexing",
          completed: 842,
          total: 1_284,
          fingerprintsReused: 800,
          message: "Indexing metadata",
        })}
        onCancel={vi.fn()}
      />
    );

    const progressbar = screen.getByRole("progressbar", {
      name: "Indexing metadata",
    });
    expect(progressbar).toHaveAttribute("aria-valuemin", "0");
    expect(progressbar).toHaveAttribute("aria-valuemax", "1284");
    expect(progressbar).toHaveAttribute("aria-valuenow", "842");
    expect(progressbar).toHaveAttribute(
      "aria-valuetext",
      "842 of 1,284 · 66%"
    );
    expect(screen.getByText("842 of 1,284 · 66%")).toBeInTheDocument();
    expect(screen.getByText("Indexed").nextSibling).toHaveTextContent(
      "842 / 1,284"
    );
    expect(screen.getByText("Metadata reused").nextSibling).toHaveTextContent(
      "800"
    );
    expect(document.querySelectorAll(".loading-progress__stat")).toHaveLength(4);
    expect(screen.getByText("Index").closest("li")).toHaveAttribute(
      "aria-current",
      "step"
    );
  });

  it("updates elapsed and last-update feedback while scan counts are stationary", () => {
    render(<LoadingProgress status={makeStatus()} onCancel={vi.fn()} />);

    expect(screen.getByLabelText("Elapsed 1m 05s")).toBeInTheDocument();
    expect(screen.getByText("Updated just now")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(11_000);
    });

    expect(screen.getByLabelText("Elapsed 1m 16s")).toBeInTheDocument();
    expect(
      screen.getByText("Still working · last update 12s ago")
    ).toBeInTheDocument();
  });

  it("renders a calm error state and uses the action to close it", () => {
    const onCancel = vi.fn();
    render(
      <LoadingProgress
        status={makeStatus({
          phase: "error",
          message: "",
          error: new Error("Permission denied while reading this folder"),
        })}
        onCancel={onCancel}
      />
    );

    expect(
      screen.getByRole("dialog", { name: "Couldn’t open collection" })
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Permission denied while reading this folder"
    );
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows a measuring state instead of a fake zero memory percentage", () => {
    render(
      <LoadingProgress
        status={makeStatus()}
        memoryStatus={{
          source: "unknown",
          currentMemoryMB: 0,
          totalMemoryMB: 0,
        }}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByText("App memory Measuring…")).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it("disables repeat cancellation and restores prior focus when removed", () => {
    const previous = document.createElement("button");
    previous.textContent = "Previous control";
    document.body.appendChild(previous);
    previous.focus();

    const { unmount } = render(
      <LoadingProgress
        status={makeStatus({ phase: "cancelling", message: "Cancelling scan" })}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
    unmount();
    expect(previous).toHaveFocus();
    previous.remove();
  });
});

describe("LoadingProgress formatters", () => {
  it("formats elapsed time, activity age, and whole-app memory without percentages", () => {
    expect(formatElapsed(3_723_000)).toBe("1h 02m");
    expect(formatActivity(1_000, 1_500)).toBe("Updated just now");
    expect(formatActivity(1_000, 13_000)).toBe(
      "Still working · last update 12s ago"
    );
    expect(formatMemoryMB(1536.3)).toBe("1,536 MB");
    expect(formatMemoryMB(0)).toBeNull();
  });
});
