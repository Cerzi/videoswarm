import { describe, expect, it } from "vitest";
import { POSTER_WIDTHS, posterWidthFor, proxyIsSharpEnough } from "./cardMediaSize";

describe("proxyIsSharpEnough", () => {
  const uhd = { width: 3840, height: 2160 };
  const portrait = { width: 1080, height: 1920 };

  it("keeps the proxy for cards no bigger than it, with a little stretch", () => {
    expect(proxyIsSharpEnough(uhd, 640, 360)).toBe(true);
    expect(proxyIsSharpEnough(uhd, 1400, 788)).toBe(true);
    expect(proxyIsSharpEnough(uhd, 1600, 900)).toBe(false);
  });

  it("counts device pixels", () => {
    expect(proxyIsSharpEnough(uhd, 800, 450, 1)).toBe(true);
    expect(proxyIsSharpEnough(uhd, 800, 450, 2)).toBe(false);
  });

  it("measures portrait clips against the proxy's height", () => {
    // A 1080x1920 proxy is 405x720.
    expect(proxyIsSharpEnough(portrait, 400, 711)).toBe(true);
    expect(proxyIsSharpEnough(portrait, 540, 960)).toBe(false);
  });

  it("keeps the proxy when the dimensions are unknown", () => {
    expect(proxyIsSharpEnough(null, 4000, 3000)).toBe(true);
    expect(proxyIsSharpEnough({ width: 0, height: 0 }, 4000, 3000)).toBe(true);
  });
});

describe("posterWidthFor", () => {
  it("captures ordinary cards at the base width", () => {
    expect(posterWidthFor(120)).toBe(POSTER_WIDTHS.base);
    expect(posterWidthFor(480)).toBe(POSTER_WIDTHS.base);
    expect(posterWidthFor(undefined)).toBe(POSTER_WIDTHS.base);
  });

  it("rounds bigger cards up to a step, up to the maximum", () => {
    expect(posterWidthFor(481)).toBe(640);
    expect(posterWidthFor(700)).toBe(800);
    expect(posterWidthFor(500, 2)).toBe(1120);
    expect(posterWidthFor(2400)).toBe(POSTER_WIDTHS.max);
  });
});
