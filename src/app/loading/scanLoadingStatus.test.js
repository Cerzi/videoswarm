import {
  createScanLoadingStatus,
  getLoadingProgressPercent,
  mergeScanLoadingProgress,
} from "./scanLoadingStatus";

describe("scan loading status", () => {
  it("maps native scan counters into the renderer status model", () => {
    const initial = createScanLoadingStatus({
      scanId: "scan-a",
      rootPath: "/clips",
      recursive: true,
      startedAt: 100,
    });

    const next = mergeScanLoadingProgress(initial, {
      scanId: "scan-a",
      phase: "indexing",
      phaseCurrent: 25,
      phaseTotal: 100,
      directoriesScanned: 8,
      entriesChecked: 340,
      videosFound: 100,
      indexedFiles: 25,
      fingerprintsReused: 18,
      currentPath: "run-04",
      updatedAt: 200,
    });

    expect(next).toMatchObject({
      phase: "indexing",
      message: "Indexing and fingerprinting files",
      completed: 25,
      total: 100,
      directoriesScanned: 8,
      entriesInspected: 340,
      videosDiscovered: 100,
      indexed: 25,
      fingerprintsReused: 18,
      currentPath: "run-04",
      updatedAt: 200,
    });
    expect(getLoadingProgressPercent(next)).toBe(25);
  });

  it("keeps unknown discovery work indeterminate", () => {
    const status = mergeScanLoadingProgress(
      createScanLoadingStatus({ scanId: "scan-a" }),
      {
        phase: "enumerating",
        phaseCurrent: null,
        phaseTotal: null,
        videosFound: 42,
      }
    );

    expect(status.videosDiscovered).toBe(42);
    expect(getLoadingProgressPercent(status)).toBeNull();
  });

  it("clears a previous phase total when the native phase becomes indeterminate", () => {
    const indexing = mergeScanLoadingProgress(
      createScanLoadingStatus({ scanId: "scan-a" }),
      { phase: "indexing", phaseCurrent: 50, phaseTotal: 100 }
    );
    const reconciling = mergeScanLoadingProgress(indexing, {
      phase: "reconciling",
      phaseCurrent: 0,
      phaseTotal: null,
    });

    expect(reconciling.completed).toBe(0);
    expect(reconciling.total).toBeNull();
    expect(getLoadingProgressPercent(reconciling)).toBeNull();
  });
});
