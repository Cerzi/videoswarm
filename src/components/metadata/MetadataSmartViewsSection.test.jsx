import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MetadataSmartViewsSection, { SMART_VIEWS_DEBOUNCE_MS } from "./MetadataSmartViewsSection";
import SmartViewsContext from "./SmartViewsContext";

const savedViews = [
  { id: 1, name: "Best", updatedAt: 1 },
  { id: 2, name: "Dance", updatedAt: 1 },
  { id: 3, name: "Lanterns", updatedAt: 1 },
];

const renderSection = (video, onApply = vi.fn()) =>
  render(
    <SmartViewsContext.Provider value={{ savedViews, onApply }}>
      <MetadataSmartViewsSection video={video} />
    </SmartViewsContext.Provider>
  );

describe("MetadataSmartViewsSection", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete window.electronAPI;
  });

  it("lists the views the clip is part of, applies one on click, and re-checks after a rating", async () => {
    vi.useFakeTimers();
    const viewsForClip = vi.fn(async () => ({
      success: true,
      views: [
        { id: 1, name: "Best", searchScope: "library", ignored: [] },
        { id: 2, name: "Dance", searchScope: "folder", ignored: ["mightBe"] },
      ],
      unknown: [{ id: 3, name: "Lanterns", searchScope: "folder", ignored: [] }],
    }));
    window.electronAPI = { library: { viewsForClip } };
    const onApply = vi.fn();
    const video = { id: "a", instanceId: 7, rating: 4, tags: [] };
    const { rerender } = renderSection(video, onApply);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SMART_VIEWS_DEBOUNCE_MS);
    });
    expect(viewsForClip).toHaveBeenCalledWith(7);
    fireEvent.click(screen.getByRole("button", { name: /Best/ }));
    expect(onApply).toHaveBeenCalledWith(savedViews[0]);
    expect(screen.getByText(/Also filters on Might be/)).toBeInTheDocument();
    expect(screen.getByText(/Can't tell yet/)).toBeInTheDocument();

    rerender(
      <SmartViewsContext.Provider value={{ savedViews, onApply }}>
        <MetadataSmartViewsSection video={{ ...video, rating: 5 }} />
      </SmartViewsContext.Provider>
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SMART_VIEWS_DEBOUNCE_MS);
    });
    expect(viewsForClip).toHaveBeenCalledTimes(2);
  });

  it("says when the clip is in none, and shows nothing without saved views", async () => {
    vi.useFakeTimers();
    window.electronAPI = { library: { viewsForClip: vi.fn(async () => ({ success: true, views: [], unknown: [] })) } };
    renderSection({ id: "a", instanceId: 7 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SMART_VIEWS_DEBOUNCE_MS);
    });
    expect(screen.getByText("In none of your 3 smart views.")).toBeInTheDocument();

    const { container } = render(<MetadataSmartViewsSection video={{ id: "b", instanceId: 8 }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
