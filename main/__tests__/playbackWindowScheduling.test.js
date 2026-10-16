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

  it("shows the dark main window on its first paint, with a fallback", () => {
    const mainSource = fs.readFileSync(
      path.resolve(process.cwd(), "main.js"),
      "utf8"
    );
    const appCss = fs.readFileSync(
      path.resolve(process.cwd(), "src/App.css"),
      "utf8"
    );
    const [, colorBg] = appCss.match(/--color-bg:\s*(#[0-9a-f]{6})/i);

    expect(mainSource).toMatch(/show:\s*false,/);
    expect(mainSource).toContain(`backgroundColor: "${colorBg}"`);
    expect(mainSource).toMatch(
      /createdWindow\.once\("ready-to-show", showWhenPainted\)/
    );
    expect(mainSource).toMatch(/setTimeout\(showWhenPainted, \d+\)/);
    expect(appCss).toMatch(/:root\s*{[^}]*color-scheme:\s*dark;/);
  });

  it("watches the main window for covering and lets the renderer toggle it", () => {
    const mainSource = fs.readFileSync(
      path.resolve(process.cwd(), "main.js"),
      "utf8"
    );
    expect(mainSource).toMatch(
      /windowCoverMonitor\.attach\(createdWindow,[\s\S]{0,200}"playback:window-covered"/
    );
    expect(mainSource).toMatch(
      /ipcMain\.handle\("playback:set-pause-when-covered"[\s\S]{0,200}windowCoverMonitor\.setEnabled/
    );
    expect(mainSource).toMatch(/pauseWhenCovered: source\.pauseWhenCovered === true/);
  });

  it("reads GPU feature status only after the GPU process reports", () => {
    const mainSource = fs.readFileSync(
      path.resolve(process.cwd(), "main.js"),
      "utf8"
    );
    // Read before the GPU process starts, every feature says software.
    expect(mainSource).toMatch(
      /getGPUInfo\("basic"\)\s*\.then\(\(\) => console\.log\("GPU status:", app\.getGPUFeatureStatus\(\)\)\)/
    );
    expect(mainSource).toMatch(
      /"playback:get-capabilities"[\s\S]{0,200}await app\.getGPUInfo\("basic"\)[\s\S]{0,400}getGPUFeatureStatus/
    );
    expect(mainSource).not.toMatch(/console\.log\("GPU status:", app\.getGPUFeatureStatus\(\)\);/);
  });
});

