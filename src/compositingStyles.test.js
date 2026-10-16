import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// Anything layered over the grid sits over many live videos. A backdrop
// filter or blend mode there is recomputed for every video frame, and on
// Linux that work is paid continuously by the compositor, so the renderer
// styles use opaque or translucent surfaces instead.
const listStyleSources = (directory) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listStyleSources(fullPath);
    if (/\.test\./.test(entry.name)) return [];
    return /\.(css|jsx?)$/.test(entry.name) ? [fullPath] : [];
  });

describe("renderer compositing styles", () => {
  it("uses no backdrop filters or blend modes", () => {
    const offenders = listStyleSources(path.resolve(process.cwd(), "src"))
      .flatMap((file) =>
        fs
          .readFileSync(file, "utf8")
          .split("\n")
          .map((line, index) => ({ file, line, number: index + 1 }))
      )
      .filter(({ line }) =>
        /(backdrop-filter|backdropFilter|mix-blend-mode|mixBlendMode)\s*:\s*(?!\s*["']?none\b)/.test(
          line
        )
      )
      .map(({ file, number, line }) =>
        `${path.relative(process.cwd(), file)}:${number}: ${line.trim()}`
      );

    expect(offenders).toEqual([]);
  });

  it("never clips a grid card, which would round-clip its playing video", () => {
    const css = fs
      .readFileSync(path.resolve(process.cwd(), "src/App.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const cardRules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .map(([, selector, body]) => ({ selector: selector.trim(), body }))
      .filter(({ selector }) =>
        selector
          .split(",")
          .some((part) => /\.video-item(?![-\w])(?![^\s]*::?(after|before))[^\s]*$/.test(part.trim()))
      );

    expect(cardRules.length).toBeGreaterThan(0);
    const offenders = cardRules.filter(({ body }) =>
      /overflow\s*:\s*(hidden|clip)|contain\s*:[^;]*\bpaint\b|content-visibility/.test(body)
    );
    expect(offenders.map(({ selector }) => selector)).toEqual([]);
  });
});

