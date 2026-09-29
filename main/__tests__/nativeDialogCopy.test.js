import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.resolve(process.cwd(), "main.js"), "utf8");

describe("native dialog wording", () => {
  it("titles the transfer destination picker for any selection, not only accepted clips", () => {
    expect(source).toContain('title: "Choose where to transfer the clips"');
    expect(source).not.toContain("Transfer accepted clips");
  });

  it("names the bin the way the platform does in the trash confirmation", () => {
    expect(source).toContain('const trashName = process.platform === "win32" ? "Recycle Bin" : "Trash";');
    expect(source).toContain("buttons: [`Move to ${trashName}`, \"Cancel\"]");
  });
});
