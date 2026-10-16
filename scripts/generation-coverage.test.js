import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  labelFolders,
  parseArgs,
  renderCoverageDetails,
  renderCoverageSummary,
} = require("./generation-coverage.cjs");

const bucket = (total, tagged, current, extra = {}) => ({
  total,
  tagged,
  base: {},
  current,
  quality: { partial: tagged },
  ...extra,
});

// Folder names that say what a library holds, and spot lines that name clips
// and show seeds, exactly as the script builds them.
const groups = new Map([
  ["secret-client-project", bucket(10, 8, { output: 8, checkpoint: 7, prompt: 8, seed: 8, steps: 6 })],
  [".", bucket(2, 1, { output: 1, prompt: 1 })],
  ["nsfw-tests", bucket(4, 4, { output: 4, seed: 4 })],
]);
const spots = [
  "  LOST prompt                  secret-client-project/hero_shot_00017.mp4",
  "  seen partial  seed=806024583300336 steps=30 models=1 loras=2  nsfw-tests/run_0003.mp4",
];

describe("generation coverage output", () => {
  it("requires a folder and validates its options", () => {
    expect(parseArgs([]).error).toBeTruthy();
    expect(parseArgs(["/lib", "--limit", "0"]).error).toBeTruthy();
    expect(parseArgs(["/lib", "--details"]).error).toBeTruthy();
    expect(parseArgs(["/lib", "extra"]).error).toBeTruthy();
    expect(parseArgs(["/lib", "--details", "/tmp/d.txt", "--fast"])).toMatchObject({
      root: "/lib",
      details: "/tmp/d.txt",
      fast: true,
    });
  });

  it("numbers folders instead of naming them", () => {
    expect(Object.fromEntries(labelFolders(groups.keys()))).toEqual({
      ".": "top level",
      "nsfw-tests": "folder 1",
      "secret-client-project": "folder 2",
    });
  });

  it("prints counts only: no folder name, path, seed or model", () => {
    for (const options of [
      { groups },
      { groups, baseline: true, lostCount: 1, spotCount: 2, detailsWritten: true },
    ]) {
      const output = renderCoverageSummary(options).join("\n");
      expect(output).toContain("folder 2");
      expect(output).toMatch(/ALL\s+16\s+13/);
      for (const forbidden of [
        "secret",
        "client",
        "nsfw",
        "hero_shot",
        "run_0003",
        ".mp4",
        "806024583300336",
        "loras=",
        "seed=",
      ]) {
        expect(output).not.toContain(forbidden);
      }
    }
    expect(renderCoverageSummary({ groups, baseline: true, lostCount: 1 }).join("\n")).toContain(
      "1 clip(s) lost a field the baseline found."
    );
  });

  it("keeps the names and spot checks for the owner's details file", () => {
    const text = renderCoverageDetails({ groups, spots });
    expect(text).toContain("don't share it or have an AI assistant read it");
    expect(text).toMatch(/folder 2\s+secret-client-project/);
    expect(text).toContain(spots[0]);
    expect(text).toContain(spots[1]);
  });
});
