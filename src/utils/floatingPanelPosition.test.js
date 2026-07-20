import { describe, expect, it } from "vitest";
import {
  FloatingPanelSide,
  clampFloatingPanelPosition,
  computeFloatingPanelPosition,
  isNarrowFloatingPanel,
} from "./floatingPanelPosition";

const rect = (left, top, width, height) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
});

describe("clampFloatingPanelPosition", () => {
  it("fully clamps each edge inside offset viewport bounds", () => {
    const bounds = rect(100, 50, 800, 600);
    const panel = { width: 300, height: 200 };

    expect(
      clampFloatingPanelPosition({ x: -500, y: -500 }, panel, bounds, 12)
    ).toEqual({ x: 112, y: 62 });
    expect(
      clampFloatingPanelPosition({ x: 2000, y: 2000 }, panel, bounds, 12)
    ).toEqual({ x: 588, y: 438 });
  });

  it("keeps the leading edge visible when the panel exceeds the bounds", () => {
    expect(
      clampFloatingPanelPosition(
        { x: 800, y: 700 },
        { width: 900, height: 700 },
        rect(100, 50, 600, 500),
        12
      )
    ).toEqual({ x: 112, y: 62 });
  });
});

describe("isNarrowFloatingPanel", () => {
  it("uses a sheet when no side fits in a narrow gallery", () => {
    expect(
      isNarrowFloatingPanel({
        boundsRect: rect(100, 40, 620, 700),
        galleryRect: rect(100, 40, 620, 700),
        anchorRect: rect(310, 140, 200, 140),
        panelSize: { width: 360, height: 300 },
      })
    ).toBe(true);
  });

  it("keeps an anchored window when either horizontal side has room", () => {
    expect(
      isNarrowFloatingPanel({
        boundsRect: rect(0, 0, 1200, 800),
        galleryRect: rect(200, 0, 1000, 800),
        anchorRect: rect(240, 120, 180, 120),
        panelSize: { width: 360, height: 300 },
      })
    ).toBe(false);
  });

  it("uses the compact sheet below the gallery breakpoint even if one side fits", () => {
    expect(
      isNarrowFloatingPanel({
        boundsRect: rect(0, 0, 660, 800),
        galleryRect: rect(0, 0, 660, 800),
        anchorRect: rect(20, 120, 180, 120),
        panelSize: { width: 340, height: 300 },
      })
    ).toBe(true);
  });

  it("detects a panel wider than the usable gallery", () => {
    expect(
      isNarrowFloatingPanel({
        boundsRect: rect(50, 30, 500, 600),
        panelSize: { width: 520, height: 300 },
      })
    ).toBe(true);
  });
});

describe("computeFloatingPanelPosition", () => {
  const bounds = rect(0, 0, 1400, 900);
  const gallery = rect(200, 0, 1200, 900);
  const anchor = rect(700, 200, 200, 140);
  const panelSize = { width: 300, height: 400 };

  it("opens left when the fitted context menu is to the right", () => {
    expect(
      computeFloatingPanelPosition({
        anchorRect: anchor,
        panelSize,
        boundsRect: bounds,
        galleryRect: gallery,
        avoidRect: rect(910, 200, 280, 420),
      })
    ).toMatchObject({
      x: 388,
      y: 200,
      side: FloatingPanelSide.LEFT,
      preferredSide: FloatingPanelSide.LEFT,
      sheet: false,
    });
  });

  it("opens right when the fitted context menu is to the left", () => {
    expect(
      computeFloatingPanelPosition({
        anchorRect: anchor,
        panelSize,
        boundsRect: bounds,
        galleryRect: gallery,
        avoidRect: rect(400, 200, 280, 420),
      })
    ).toMatchObject({
      x: 912,
      y: 200,
      side: FloatingPanelSide.RIGHT,
      preferredSide: FloatingPanelSide.RIGHT,
      sheet: false,
    });
  });

  it("falls back to the opposite horizontal side at a viewport edge", () => {
    const result = computeFloatingPanelPosition({
      anchorRect: rect(20, 160, 200, 140),
      panelSize,
      boundsRect: bounds,
      galleryRect: bounds,
      avoidRect: rect(1000, 160, 280, 420),
    });

    expect(result.preferredSide).toBe(FloatingPanelSide.LEFT);
    expect(result.side).toBe(FloatingPanelSide.RIGHT);
    expect(result.x).toBe(232);
    expect(result.y).toBe(160);
  });

  it("prefers the gallery over covering the library sidebar", () => {
    const result = computeFloatingPanelPosition({
      anchorRect: rect(320, 160, 200, 140),
      panelSize: { width: 280, height: 360 },
      boundsRect: rect(0, 0, 1400, 900),
      galleryRect: rect(300, 0, 1100, 900),
      avoidRect: rect(1000, 160, 280, 420),
    });

    expect(result.preferredSide).toBe(FloatingPanelSide.LEFT);
    expect(result.side).toBe(FloatingPanelSide.RIGHT);
    expect(result.x).toBe(532);
  });

  it("uses a vertical candidate instead of overlapping the context menu", () => {
    const result = computeFloatingPanelPosition({
      anchorRect: rect(20, 160, 200, 140),
      panelSize,
      boundsRect: bounds,
      galleryRect: bounds,
      avoidRect: rect(230, 160, 280, 420),
    });

    expect(result.preferredSide).toBe(FloatingPanelSide.LEFT);
    expect(result.side).toBe(FloatingPanelSide.BELOW);
    expect(result.y).toBe(312);
  });

  it("uses below and above candidates when neither horizontal side fits", () => {
    const common = {
      panelSize: { width: 300, height: 240 },
      boundsRect: rect(0, 0, 640, 800),
      galleryRect: rect(0, 0, 640, 800),
      narrowBreakpoint: 0,
    };

    expect(
      computeFloatingPanelPosition({
        ...common,
        anchorRect: rect(170, 100, 300, 150),
      })
    ).toMatchObject({ x: 170, y: 262, side: FloatingPanelSide.BELOW });

    expect(
      computeFloatingPanelPosition({
        ...common,
        anchorRect: rect(170, 600, 300, 150),
      })
    ).toMatchObject({ x: 170, y: 348, side: FloatingPanelSide.ABOVE });
  });

  it("returns a bottom sheet centered in a narrow offset gallery", () => {
    expect(
      computeFloatingPanelPosition({
        anchorRect: rect(310, 140, 200, 140),
        panelSize: { width: 360, height: 300 },
        boundsRect: rect(100, 40, 620, 700),
        galleryRect: rect(100, 40, 620, 700),
      })
    ).toMatchObject({
      x: 230,
      y: 428,
      side: FloatingPanelSide.SHEET,
      sheet: true,
      anchored: true,
    });
  });

  it("uses a stable top-right fallback when the anchor is not mounted", () => {
    expect(
      computeFloatingPanelPosition({
        panelSize: { width: 300, height: 240 },
        boundsRect: rect(100, 50, 900, 700),
        galleryRect: rect(260, 50, 740, 700),
        forceSheet: false,
      })
    ).toMatchObject({
      x: 688,
      y: 62,
      side: FloatingPanelSide.FALLBACK,
      sheet: false,
      anchored: false,
    });
  });
});
