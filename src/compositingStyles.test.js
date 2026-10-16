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
});
