import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CompanionTagFilter, { knownCompanionTags } from "./CompanionTagFilter";

describe("CompanionTagFilter", () => {
  it("collects every tag an app answered with, once whatever its case", () => {
    const entries = new Map([
      [1, { tags: ["Bram", "alba"] }],
      [2, { tags: ["Alba", "Cora"] }],
      [3, {}],
    ]);
    expect(knownCompanionTags(entries)).toEqual(["alba", "Bram", "Cora"]);
    expect(knownCompanionTags(undefined)).toEqual([]);
  });

  it("suggests known tags as you type, adds them, and matches any or all", () => {
    let value = null;
    const onChange = vi.fn((next) => {
      value = next;
    });
    const known = ["Alba", "Albert", "Bram", "Malba"];
    const { rerender } = render(
      <CompanionTagFilter label="Characters" known={known} value={value} onChange={onChange} />
    );
    const input = screen.getByRole("searchbox", { name: "Filter by Characters" });
    fireEvent.change(input, { target: { value: "alb" } });
    const suggestions = screen.getByRole("listbox", { name: "Characters suggestions" });
    // Starts first, then the rest that contain it.
    expect([...suggestions.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Alba",
      "Albert",
      "Malba",
    ]);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(value).toEqual({ tags: ["Alba"], mode: "any" });

    rerender(<CompanionTagFilter label="Characters" known={known} value={value} onChange={onChange} />);
    fireEvent.change(input, { target: { value: "br" } });
    fireEvent.click(screen.getByRole("option", { name: "Bram" }));
    expect(value).toEqual({ tags: ["Alba", "Bram"], mode: "any" });

    rerender(<CompanionTagFilter label="Characters" known={known} value={value} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(value).toEqual({ tags: ["Alba", "Bram"], mode: "all" });
    rerender(<CompanionTagFilter label="Characters" known={known} value={value} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Alba ×" }));
    expect(value).toEqual({ tags: ["Bram"], mode: "all" });
    rerender(<CompanionTagFilter label="Characters" known={known} value={value} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Bram ×" }));
    expect(value).toBeNull();
  });

  it("takes a name it has not seen yet, for a view of clips not looked up", () => {
    const onChange = vi.fn();
    render(<CompanionTagFilter label="Characters" known={[]} value={null} onChange={onChange} />);
    const input = screen.getByRole("searchbox", { name: "Filter by Characters" });
    fireEvent.change(input, { target: { value: " Dara " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith({ tags: ["Dara"], mode: "any" });
  });
});
