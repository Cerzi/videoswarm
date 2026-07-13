import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import FolderGroupHeaders from "./FolderGroupHeaders";

describe("FolderGroupHeaders", () => {
  it("shows only folders with direct filtered matches", () => {
    const onSelectFolder = vi.fn();
    const tree = {
      path: "",
      children: [
        { path: "run-a", directMatchingCount: 3, children: [] },
        { path: "run-b", directMatchingCount: 0, children: [] },
      ],
    };
    render(<FolderGroupHeaders tree={tree} onSelectFolder={onSelectFolder} />);

    fireEvent.click(screen.getByRole("button", { name: /run-a 3/i }));
    expect(onSelectFolder).toHaveBeenCalledWith("run-a", tree.children[0]);
    expect(screen.queryByText("run-b")).not.toBeInTheDocument();
  });
});
