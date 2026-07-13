import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import LoadingOverlay from "./LoadingOverlay";

describe("LoadingOverlay", () => {
  it("forwards the cancel action to the loading progress control", () => {
    const onCancel = vi.fn();

    render(
      <LoadingOverlay
        show
        stage="Scanning for video files..."
        progress={30}
        onCancel={onCancel}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not render while hidden", () => {
    const { container } = render(
      <LoadingOverlay show={false} stage="" progress={0} onCancel={vi.fn()} />
    );

    expect(container).toBeEmptyDOMElement();
  });
});
