import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import AppErrorBoundary from "./AppErrorBoundary";

function Broken() {
  throw new Error("Duplicate masonry item id: /clips/a.mp4");
}

describe("AppErrorBoundary", () => {
  it("shows what went wrong and offers a reload instead of a blank window", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...original, reload } });
    try {
      render(
        <AppErrorBoundary>
          <Broken />
        </AppErrorBoundary>
      );
      expect(screen.getByRole("alert")).toHaveTextContent("Video Swarm hit a problem");
      expect(screen.getByText(/Duplicate masonry item id/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Reload the window" }));
      expect(reload).toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
      quiet.mockRestore();
    }
  });

  it("renders the app untouched when nothing goes wrong", () => {
    render(
      <AppErrorBoundary>
        <p>grid</p>
      </AppErrorBoundary>
    );
    expect(screen.getByText("grid")).toBeInTheDocument();
  });
});
