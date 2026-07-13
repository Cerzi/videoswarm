import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SortKey } from "../../sorting/sorting";
import { useMasonryLayout } from "./useMasonryLayout";

const io = vi.hoisted(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  isVisible: vi.fn(() => false),
  isNear: vi.fn(() => false),
  setNearPx: vi.fn(),
  refresh: vi.fn(),
}));
const useIoRegistry = vi.hoisted(() => vi.fn(() => io));

vi.mock("../../hooks/ui-perf/useIntersectionObserverRegistry", () => ({
  default: useIoRegistry,
}));

let frameQueue;

function flushFrames(limit = 20) {
  for (let index = 0; index < limit && frameQueue.length; index += 1) {
    const callbacks = frameQueue.splice(0);
    callbacks.forEach(({ callback }) => callback(performance.now()));
  }
}

function makeElement({ width, height }) {
  const element = document.createElement("div");
  Object.defineProperty(element, "clientWidth", {
    configurable: true,
    value: width,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: height,
  });
  element.getBoundingClientRect = () => ({
    width,
    height,
    top: 0,
    bottom: height,
    left: 0,
    right: width,
  });
  return element;
}

function makeVideos(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `clip-${index}`,
    name: `clip-${String(index).padStart(4, "0")}.mp4`,
    basename: `clip-${String(index).padStart(4, "0")}.mp4`,
    dirname: index % 2 ? "run-b" : "run-a",
    fullPath: `/library/clip-${index}.mp4`,
    size: 100 + index,
    dateModified: index,
    aspectRatio: 1,
    ...overrides,
  }));
}

function renderLayout(initialProps = {}) {
  const scrollElement = makeElement({ width: 1000, height: 600 });
  const gridElement = makeElement({ width: 1000, height: 0 });
  document.body.append(scrollElement, gridElement);
  const scrollContainerRef = { current: scrollElement };
  const gridRef = { current: gridElement };
  const videos = initialProps.videos || makeVideos(1000);

  const props = {
    videos,
    filteredVideos: videos,
    sortKey: SortKey.NAME,
    sortDir: "asc",
    groupByFolders: false,
    randomSeed: 1,
    zoomLevel: 1,
    scrollContainerRef,
    gridRef,
    renderLimit: null,
    pinnedIds: [],
    ...initialProps,
  };

  const hook = renderHook((nextProps) => useMasonryLayout(nextProps), {
    initialProps: props,
  });
  act(() => flushFrames());

  return { ...hook, props, scrollElement };
}

beforeEach(() => {
  frameQueue = [];
  vi.clearAllMocks();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback) => {
      const entry = { id: frameQueue.length + 1, callback };
      frameQueue.push(entry);
      return entry.id;
    })
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id) => {
      frameQueue = frameQueue.filter((entry) => entry.id !== id);
    })
  );
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      disconnect() {}
    }
  );
});

describe("useMasonryLayout virtual layout", () => {
  it("keeps a real 5,000-item hook window bounded at top, middle, and bottom", () => {
    const videos = makeVideos(5000);
    const rendered = renderLayout({ videos, filteredVideos: videos });
    const mountedBound = 100;

    expect(rendered.result.current.visualOrderedIds).toHaveLength(5000);
    expect(new Set(rendered.result.current.visualOrderedIds).size).toBe(5000);
    expect(rendered.result.current.virtualItems.length).toBeLessThan(
      mountedBound
    );

    ["clip-2500", "clip-4999"].forEach((id) => {
      act(() => {
        expect(rendered.result.current.scrollToId(id, { align: "center" })).toBe(
          true
        );
        flushFrames();
      });
      expect(
        rendered.result.current.virtualItems.some((item) => item.id === id)
      ).toBe(true);
      expect(rendered.result.current.virtualItems.length).toBeLessThan(
        mountedBound
      );
    });
  });

  it("keeps the full sorted collection while virtualizing only the limited prefix", () => {
    const videos = makeVideos(1000);
    const { result } = renderLayout({
      videos,
      filteredVideos: videos,
      renderLimit: 120,
      pinnedIds: ["clip-119"],
    });

    expect(result.current.orderedVideos).toHaveLength(1000);
    expect(result.current.orderedIds).toHaveLength(1000);
    expect(result.current.visualOrderedIds).toHaveLength(120);
    expect(result.current.orderForRange).toEqual(result.current.visualOrderedIds);
    expect(result.current.virtualItems.length).toBeLessThan(120);
    expect(result.current.virtualItems.some((entry) => entry.id === "clip-119")).toBe(
      true
    );
    expect(result.current.activationIdSet.has("clip-119")).toBe(false);
    expect(result.current.activationIds).toEqual(
      result.current.activationIds.filter((id, index, ids) => ids.indexOf(id) === index)
    );
    expect(new Set(result.current.centerPriorityIds)).toEqual(
      new Set(result.current.activationIds)
    );
    expect(result.current.activationTarget).toBeLessThanOrEqual(600);
    expect(result.current.mountedVideoCount).toBe(result.current.virtualItems.length);
    expect(result.current.totalHeight).toBeGreaterThan(600);
    expect(result.current.getPositionById("clip-999")).toBeNull();
  });

  it("orders decoder priority by logical distance from the viewport center", () => {
    const rendered = renderLayout({ videos: makeVideos(200) });
    const viewportCenter =
      rendered.scrollElement.scrollTop + rendered.scrollElement.clientHeight / 2;
    const distances = rendered.result.current.centerPriorityIds.map((id) => {
      const position = rendered.result.current.getPositionById(id);
      return Math.abs(position.y + position.height / 2 - viewportCenter);
    });

    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it("batches aspect corrections and discards an override after the file changes", () => {
    const videos = makeVideos(200);
    const rendered = renderLayout({ videos, filteredVideos: videos });
    const before = rendered.result.current.getPositionById("clip-0");

    act(() => {
      rendered.result.current.updateAspectRatio("clip-0", 0.5);
      rendered.result.current.updateAspectRatio("clip-0", 2);
    });
    expect(rendered.result.current.getPositionById("clip-0").height).toBe(
      before.height
    );

    act(() => flushFrames());
    const corrected = rendered.result.current.getPositionById("clip-0");
    expect(corrected.height).toBe(Math.round(corrected.width / 2));

    const changedVideos = videos.map((video, index) =>
      index === 0
        ? { ...video, size: video.size + 1, dateModified: video.dateModified + 1 }
        : video
    );
    act(() => {
      rendered.rerender({
        ...rendered.props,
        videos: changedVideos,
        filteredVideos: changedVideos,
      });
      flushFrames();
    });

    const afterChange = rendered.result.current.getPositionById("clip-0");
    expect(afterChange.height).toBe(Math.round(afterChange.width));
  });

  it("scrolls directly to an offscreen item and keeps observer options stable", () => {
    const videos = makeVideos(500);
    const rendered = renderLayout({ videos, filteredVideos: videos });
    const firstThreshold = useIoRegistry.mock.calls.at(-1)[1].threshold;

    act(() => {
      expect(
        rendered.result.current.scrollToId("clip-450", { align: "center" })
      ).toBe(true);
    });
    act(() => flushFrames());

    expect(rendered.scrollElement.scrollTop).toBeGreaterThan(0);
    expect(
      rendered.result.current.virtualItems.some((entry) => entry.id === "clip-450")
    ).toBe(true);
    expect(useIoRegistry.mock.calls.at(-1)[1].threshold).toBe(firstThreshold);
    expect(rendered.result.current.scrollToId("missing")).toBe(false);
  });

  it("keeps the first visible logical item anchored after an aspect correction", () => {
    const videos = makeVideos(600);
    const rendered = renderLayout({ videos, filteredVideos: videos });

    act(() => {
      rendered.result.current.scrollToId("clip-500", { align: "center" });
      flushFrames();
    });

    const beforeScrollTop = rendered.scrollElement.scrollTop;
    const anchorId = rendered.result.current.orderForRange.find((id) => {
      const position = rendered.result.current.getPositionById(id);
      return position?.bottom > beforeScrollTop;
    });
    const beforeAnchor = rendered.result.current.getPositionById(anchorId);
    const beforeOffset = beforeAnchor.y - beforeScrollTop;
    const queryAll = vi.spyOn(Element.prototype, "querySelectorAll");
    io.refresh.mockClear();

    act(() => {
      for (let index = 0; index < 450; index += 1) {
        rendered.result.current.updateAspectRatio(`clip-${index}`, 4);
      }
      flushFrames();
    });

    const afterAnchor = rendered.result.current.getPositionById(anchorId);
    const afterOffset = afterAnchor.y - rendered.scrollElement.scrollTop;
    expect(afterAnchor.y).not.toBe(beforeAnchor.y);
    expect(afterOffset).toBeCloseTo(beforeOffset, 5);
    expect(io.refresh).toHaveBeenCalledOnce();
    expect(queryAll).not.toHaveBeenCalled();
    queryAll.mockRestore();
  });

  it("attaches scrolling and observer root when the conditional grid mounts later", () => {
    const videos = makeVideos(500);
    const scrollContainerRef = { current: null };
    const gridRef = { current: null };
    const baseProps = {
      videos,
      filteredVideos: videos,
      sortKey: SortKey.NAME,
      sortDir: "asc",
      groupByFolders: false,
      randomSeed: 1,
      zoomLevel: 1,
      scrollContainerRef,
      gridRef,
      scrollContainerElement: null,
      gridElement: null,
      renderLimit: null,
      pinnedIds: [],
    };
    const rendered = renderHook((props) => useMasonryLayout(props), {
      initialProps: baseProps,
    });
    act(() => flushFrames());

    const scrollElement = makeElement({ width: 1000, height: 600 });
    const gridElement = makeElement({ width: 1000, height: 0 });
    scrollContainerRef.current = scrollElement;
    gridRef.current = gridElement;
    act(() => {
      rendered.rerender({
        ...baseProps,
        scrollContainerElement: scrollElement,
        gridElement,
      });
      flushFrames();
    });

    expect(useIoRegistry.mock.calls.at(-1)[0].current).toBe(scrollElement);
    const distant = rendered.result.current.getPositionById("clip-450");
    scrollElement.scrollTop = distant.y;
    act(() => {
      scrollElement.dispatchEvent(new Event("scroll"));
      flushFrames();
    });

    expect(
      rendered.result.current.virtualItems.some((item) => item.id === "clip-450")
    ).toBe(true);
  });
});
