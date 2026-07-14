import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FOLDER_OPEN_MILESTONES,
  FOLDER_OPEN_PERFORMANCE_EVENT,
  beginFolderOpenMeasurement,
  getFolderOpenMeasurement,
  recordFolderOpenMilestone,
  resetFolderOpenMeasurements,
} from "./folderOpenMetrics";

describe("folderOpenMetrics", () => {
  afterEach(() => {
    resetFolderOpenMeasurements();
    vi.restoreAllMocks();
  });

  it("publishes stable request-to-grid measurements for cache A/B evidence", () => {
    const events = [];
    window.addEventListener(FOLDER_OPEN_PERFORMANCE_EVENT, (event) => {
      events.push(event.detail);
    }, { once: false });
    const nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValueOnce(10).mockReturnValueOnce(25).mockReturnValueOnce(40);

    beginFolderOpenMeasurement({
      scanId: "scan-cache",
      rootPath: "/clips",
      recursive: true,
    });
    recordFolderOpenMilestone(
      "scan-cache",
      FOLDER_OPEN_MILESTONES.CACHED_PREVIEW,
      { recordCount: 6000, previewSource: "cache" }
    );
    const grid = recordFolderOpenMilestone(
      "scan-cache",
      FOLDER_OPEN_MILESTONES.FIRST_USABLE_GRID,
      { recordCount: 6000, previewSource: "cache" }
    );

    expect(grid).toMatchObject({
      milestone: "first-usable-grid",
      elapsedMs: 30,
      recordCount: 6000,
      previewSource: "cache",
    });
    expect(events.map((event) => event.milestone)).toEqual([
      "request",
      "cached-preview",
      "first-usable-grid",
    ]);
    expect(getFolderOpenMeasurement("scan-cache")?.milestones).toHaveProperty(
      "first-usable-grid"
    );
  });

  it("records each milestone once and ignores late non-terminal work", () => {
    beginFolderOpenMeasurement({ scanId: "scan-cancelled" });
    expect(
      recordFolderOpenMilestone(
        "scan-cancelled",
        FOLDER_OPEN_MILESTONES.FIRST_BATCH
      )
    ).not.toBeNull();
    expect(
      recordFolderOpenMilestone(
        "scan-cancelled",
        FOLDER_OPEN_MILESTONES.FIRST_BATCH
      )
    ).toBeNull();
    recordFolderOpenMilestone(
      "scan-cancelled",
      FOLDER_OPEN_MILESTONES.CANCELLED
    );
    expect(
      recordFolderOpenMilestone(
        "scan-cancelled",
        FOLDER_OPEN_MILESTONES.ENRICHMENT_COMPLETE
      )
    ).toBeNull();
  });

  it("allows the first committed grid render to follow native completion", () => {
    beginFolderOpenMeasurement({ scanId: "scan-fast-native" });
    recordFolderOpenMilestone(
      "scan-fast-native",
      FOLDER_OPEN_MILESTONES.SCAN_COMPLETE
    );

    expect(
      recordFolderOpenMilestone(
        "scan-fast-native",
        FOLDER_OPEN_MILESTONES.FIRST_USABLE_GRID,
        { recordCount: 3 }
      )
    ).toMatchObject({ milestone: "first-usable-grid", recordCount: 3 });
  });

  it("bounds retained sessions and sanitizes event details", () => {
    for (let index = 0; index < 20; index += 1) {
      beginFolderOpenMeasurement({ scanId: `scan-${index}` });
    }
    expect(getFolderOpenMeasurement("scan-0")).toBeNull();
    expect(getFolderOpenMeasurement("scan-19")).not.toBeNull();

    const detail = recordFolderOpenMilestone(
      "scan-19",
      FOLDER_OPEN_MILESTONES.ERROR,
      { error: "x".repeat(1000), nested: { retained: false } }
    );
    expect(detail.error).toHaveLength(512);
    expect(detail).not.toHaveProperty("nested");
  });
});
