import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

describe("playback window scheduling", () => {
  it("starts unthrottled and does not flip scheduling during mode changes", () => {
    const mainSource = fs.readFileSync(
      path.resolve(process.cwd(), "main.js"),
      "utf8"
    );

    expect(mainSource).toMatch(/backgroundThrottling:\s*false/);
    expect(mainSource).not.toContain("setBackgroundThrottling");
    expect(mainSource).not.toContain("playback:set-mode-scheduling");
  });
});
