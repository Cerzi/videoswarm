#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const {
  chooseFolderThroughNativeDialog,
  launchProductionApp,
} = require("../../tests/electron/helpers/launchApp.cjs");
const {
  evaluateSoakBudget,
  summarizeSoak,
} = require("./linux-soak-budget.cjs");

function readArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const equalsIndex = token.indexOf("=");
    if (equalsIndex > 2) {
      result[token.slice(2, equalsIndex)] = token.slice(equalsIndex + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

function countLinuxProcessResources(pids) {
  let fileHandles = 0;
  let inotifyWatches = 0;
  for (const pid of pids) {
    const fdPath = `/proc/${pid}/fd`;
    const fdInfoPath = `/proc/${pid}/fdinfo`;
    try {
      fileHandles += fs.readdirSync(fdPath).length;
    } catch {}
    try {
      for (const filename of fs.readdirSync(fdInfoPath)) {
        let contents = "";
        try {
          contents = fs.readFileSync(path.join(fdInfoPath, filename), "utf8");
        } catch {}
        inotifyWatches += contents
          .split("\n")
          .filter((line) => line.startsWith("inotify wd:")).length;
      }
    } catch {}
  }
  return { fileHandles, inotifyWatches };
}

function databaseSize(rootPath) {
  let total = 0;
  const pending = [rootPath];
  while (pending.length) {
    const current = pending.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      if (entry.isFile() && entry.name === "videoswarm-meta.db") {
        try {
          total += fs.statSync(fullPath).size;
        } catch {}
      }
    }
  }
  return total;
}

async function installRendererProbe(page) {
  await page.evaluate(() => {
    const state = {
      frameDelays: [],
      longTaskDurationMs: 0,
      lastFrameAt: null,
    };
    const frame = (timestamp) => {
      if (state.lastFrameAt !== null) {
        state.frameDelays.push(Math.max(0, timestamp - state.lastFrameAt));
        if (state.frameDelays.length > 1_200) state.frameDelays.shift();
      }
      state.lastFrameAt = timestamp;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTaskDurationMs += Math.max(0, entry.duration || 0);
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {}
    window.__videoSwarmSoakProbe = state;
  });
}

async function readRendererSample(page, forceGc = false) {
  return page.evaluate((shouldCollectGarbage) => {
    if (shouldCollectGarbage && typeof window.gc === "function") window.gc();
    const state = window.__videoSwarmSoakProbe || { frameDelays: [] };
    const delays = state.frameDelays.splice(0, state.frameDelays.length);
    const sorted = delays.filter(Number.isFinite).sort((a, b) => a - b);
    const percentile = (ratio) => {
      if (!sorted.length) return null;
      return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
    };
    const media = [...document.querySelectorAll("video")];
    let totalFrames = 0;
    let droppedFrames = 0;
    for (const element of media) {
      try {
        const quality = element.getVideoPlaybackQuality?.();
        totalFrames += Number(quality?.totalVideoFrames) || 0;
        droppedFrames += Number(quality?.droppedVideoFrames) || 0;
      } catch {}
    }
    const heapBytes = Number(performance.memory?.usedJSHeapSize);
    const measures = performance
      .getEntriesByType("measure")
      .filter((entry) => entry.name.toLowerCase().includes("videoswarm"))
      .map((entry) => ({ name: entry.name, duration: entry.duration }));
    return {
      heapUsedMB: Number.isFinite(heapBytes) ? heapBytes / 1024 / 1024 : null,
      eventLoopP95Ms: percentile(0.95),
      eventLoopMaxMs: percentile(1),
      longTaskDurationMs: state.longTaskDurationMs || 0,
      mediaElements: media.length,
      loadedMediaElements: media.filter((element) => element.readyState >= 2).length,
      playingMediaElements: media.filter((element) => !element.paused).length,
      droppedFrameRatio: totalFrames > 0 ? droppedFrames / totalFrames : null,
      mountedCards: document.querySelectorAll(".video-item").length,
      measures,
    };
  }, forceGc);
}

async function readSystemSample(electronApp, tempRoot) {
  const metrics = await electronApp.evaluate(({ app }) =>
    app.getAppMetrics().map((entry) => ({
      pid: entry.pid,
      type: entry.type,
      cpuPercent: Number(entry.cpu?.percentCPUUsage) || 0,
      workingSetKB: Number(entry.memory?.workingSetSize) || 0,
      privateKB: Number(entry.memory?.privateBytes) || 0,
    }))
  );
  const pids = metrics.map((entry) => entry.pid).filter(Number.isInteger);
  const linuxResources = countLinuxProcessResources(pids);
  return {
    rssMB: metrics.reduce((total, entry) => total + entry.workingSetKB, 0) / 1024,
    privateMB: metrics.reduce((total, entry) => total + entry.privateKB, 0) / 1024,
    cpuPercent: metrics.reduce((total, entry) => total + entry.cpuPercent, 0),
    processCount: metrics.length,
    databaseBytes: databaseSize(tempRoot),
    ...linuxResources,
  };
}

async function takeHeapSnapshot(page, outputPath) {
  const session = await page.context().newCDPSession(page);
  const stream = fs.createWriteStream(outputPath);
  session.on("HeapProfiler.addHeapSnapshotChunk", ({ chunk }) => stream.write(chunk));
  await session.send("HeapProfiler.enable");
  await session.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  await new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
  await session.detach();
}

async function main() {
  const args = readArguments(process.argv.slice(2));
  const folderPath = args.folder ? path.resolve(String(args.folder)) : null;
  if (process.platform !== "linux") {
    throw new Error("The local soak runner currently supports Linux only");
  }
  if (!folderPath || !fs.statSync(folderPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("Pass an existing directory with --folder /path/to/videos");
  }

  const durationMs = Math.max(1_000, Number(args["duration-seconds"] || 120) * 1_000);
  const intervalMs = Math.max(250, Number(args["sample-interval-ms"] || 2_000));
  const outputPath = path.resolve(
    String(
      args.output ||
        `performance-results/linux-soak-${new Date().toISOString().replaceAll(":", "-")}.json`
    )
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const baseline = args.baseline
    ? JSON.parse(fs.readFileSync(path.resolve(String(args.baseline)), "utf8"))
    : null;

  const context = await launchProductionApp({
    extraEnv: { VIDEOSWARM_PROFILE_RUN: "1" },
  });
  const { electronApp, page, tempRoot } = context;
  const samples = [];
  const mainOutput = [];
  const startedAt = Date.now();
  const tracePath = outputPath.replace(/\.json$/u, "-trace.json");
  electronApp.process().stdout?.on("data", (chunk) => mainOutput.push(chunk.toString()));
  electronApp.process().stderr?.on("data", (chunk) => mainOutput.push(chunk.toString()));

  try {
    if (args.trace) {
      await electronApp.evaluate(({ contentTracing }) =>
        contentTracing.startRecording({
          included_categories: [
            "blink",
            "cc",
            "disabled-by-default-v8.cpu_profiler",
            "gpu",
            "media",
            "renderer.scheduler",
            "toplevel",
            "v8",
          ],
        })
      );
    }
    await installRendererProbe(page);
    if (args.recursive) {
      await page.getByText("Subfolders", { exact: true }).click();
    }
    await chooseFolderThroughNativeDialog(electronApp, page, folderPath);
    await page.waitForFunction(
      () =>
        /🎬\s+\d+\s+videos/u.test(
          document.querySelector(".debug-info")?.textContent || ""
        ) &&
        (document.querySelector(".video-item") ||
          document.querySelector(".collection-empty-state")),
      null,
      { timeout: 10 * 60_000 }
    );

    const finishAt = startedAt + durationMs;
    let index = 0;
    while (Date.now() < finishAt) {
      const viewport = page.locator(".content-region__viewport");
      if ((await viewport.count()) > 0) {
        await viewport.evaluate((element, progress) => {
          element.scrollTop = Math.max(
            0,
            (element.scrollHeight - element.clientHeight) * progress
          );
          element.dispatchEvent(new Event("scroll"));
        }, index % 2 === 0 ? 1 : 0);
      }
      const [renderer, system] = await Promise.all([
        readRendererSample(page, index === 0),
        readSystemSample(electronApp, tempRoot),
      ]);
      samples.push({ elapsedMs: Date.now() - startedAt, renderer, system });
      index += 1;
      await delay(Math.min(intervalMs, Math.max(0, finishAt - Date.now())));
    }

    const [renderer, system] = await Promise.all([
      readRendererSample(page, true),
      readSystemSample(electronApp, tempRoot),
    ]);
    samples.push({ elapsedMs: Date.now() - startedAt, renderer, system });

    if (args["heap-snapshot"]) {
      await takeHeapSnapshot(page, outputPath.replace(/\.json$/u, "-heap.heapsnapshot"));
    }
    if (args.trace) {
      await electronApp.evaluate(
        ({ contentTracing }, destination) => contentTracing.stopRecording(destination),
        tracePath
      );
    }

    const summary = summarizeSoak(samples);
    const evaluation = evaluateSoakBudget(summary, { baseline });
    const result = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      environment: {
        platform: process.platform,
        release: os.release(),
        cpuModel: os.cpus()[0]?.model || "unknown",
        cpuCount: os.cpus().length,
        totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
        folderPath,
        recursive: Boolean(args.recursive),
      },
      configuration: { durationMs, intervalMs },
      summary,
      evaluation,
      samples,
      mainOutput,
    };
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Linux soak report: ${outputPath}`);
    console.log(JSON.stringify({ summary, evaluation }, null, 2));
    if (args.enforce && !evaluation.passed) process.exitCode = 1;
  } finally {
    await electronApp.close().catch(() => {});
    context.cleanupFiles();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
