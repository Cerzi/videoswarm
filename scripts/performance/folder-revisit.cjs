#!/usr/bin/env node
/* global document, requestAnimationFrame, window */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const {
  chooseFolderThroughNativeDialog,
  launchProductionApp,
} = require("../../tests/electron/helpers/launchApp.cjs");
const {
  evaluateFolderRevisitReport,
} = require("./folder-revisit-budget.cjs");

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".m4v",
  ".flv",
  ".wmv",
  ".3gp",
  ".ogv",
]);
const IGNORED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "System Volume Information",
  "$RECYCLE.BIN",
  ".git",
]);
const FOLDER_PERFORMANCE_EVENT = "videoswarm:folder-performance";
const MAX_CAPTURED_MAIN_OUTPUT = 256 * 1024;

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

function printUsage() {
  console.log(`Usage:
  npm run profile:folder-revisit -- \\
    --folder-1000 /path/to/1000-plus-videos \\
    --folder-6000 /path/to/6000-plus-videos [options]

Options:
  --trials N                 Trials per scenario (default: 5)
  --timeout-minutes N        Per-open timeout (default: 15)
  --settle-ms N              Resource sampling delay (default: 750)
  --scenario NAME            all, cold, warm, or restart (default: all)
  --flat                     Scan only direct children (recursive by default)
  --output FILE              JSON report path
  --no-enforce               Write failures without a non-zero exit code
  --keep-profile-data        Retain temporary benchmark profiles

Each supplied folder is treated as a minimum-size class. The final application
count must still exactly match the supported video count found on disk.`);
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function isIgnoredDirectory(name) {
  return name.startsWith(".") || IGNORED_DIRECTORY_NAMES.has(name);
}

function inspectVideoFolder(rootPath, recursive) {
  const pending = [{ directory: rootPath, depth: 0 }];
  let fileCount = 0;
  let smallestVideoPath = null;
  let smallestVideoBytes = Infinity;
  while (pending.length) {
    const { directory, depth } = pending.pop();
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (
        entry.isFile() &&
        VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        const stats = fs.statSync(fullPath);
        fileCount += 1;
        if (stats.size < smallestVideoBytes) {
          smallestVideoBytes = stats.size;
          smallestVideoPath = fullPath;
        }
      } else if (
        recursive &&
        entry.isDirectory() &&
        depth < 10 &&
        !isIgnoredDirectory(entry.name)
      ) {
        pending.push({ directory: fullPath, depth: depth + 1 });
      }
    }
  }
  return { fileCount, smallestVideoPath, smallestVideoBytes };
}

function createSentinelFolder(runRoot, datasetKey, sourceVideoPath) {
  const sentinelPath = path.join(runRoot, `sentinel-${datasetKey}`);
  fs.mkdirSync(sentinelPath, { recursive: true });
  const extension = path.extname(sourceVideoPath).toLowerCase() || ".mp4";
  const destination = path.join(sentinelPath, `sentinel${extension}`);
  try {
    fs.linkSync(sourceVideoPath, destination);
  } catch {
    fs.copyFileSync(sourceVideoPath, destination);
  }
  return fs.realpathSync(sentinelPath);
}

function createBoundedOutputCollector() {
  let output = "";
  return {
    append(label, chunk) {
      output += `[${label}] ${chunk.toString()}`;
      if (output.length > MAX_CAPTURED_MAIN_OUTPUT) {
        output = output.slice(-MAX_CAPTURED_MAIN_OUTPUT);
      }
    },
    snapshot() {
      return output;
    },
  };
}

async function installFolderMetricsProbe(page) {
  await page.evaluate((eventName) => {
    window.__videoSwarmFolderRevisitMetrics = [];
    window.addEventListener(eventName, (event) => {
      window.__videoSwarmFolderRevisitMetrics.push(event.detail);
    });
  }, FOLDER_PERFORMANCE_EVENT);
}

async function ensureRecursiveMode(page, recursive) {
  const checkbox = page.locator(".subfolders-option input[type=checkbox]");
  await checkbox.waitFor({ state: "visible" });
  if ((await checkbox.isChecked()) !== recursive) {
    await checkbox.setChecked(recursive);
  }
}

async function resetFolderMetrics(page) {
  await page.evaluate(() => {
    window.__videoSwarmFolderRevisitMetrics = [];
  });
}

async function waitForFolderMilestones(page, rootPath, timeoutMs) {
  await page.waitForFunction(
    ({ expectedRoot }) => {
      const events = window.__videoSwarmFolderRevisitMetrics || [];
      const request = events.find(
        (event) => event?.milestone === "request" && event?.rootPath === expectedRoot
      );
      if (!request) return false;
      const matching = events.filter((event) => event?.scanId === request.scanId);
      if (matching.some((event) => event?.milestone === "error")) return true;
      return (
        matching.some((event) => event?.milestone === "first-usable-grid") &&
        matching.some((event) => event?.milestone === "scan-complete")
      );
    },
    { expectedRoot: rootPath },
    { timeout: timeoutMs }
  );

  const events = await page.evaluate((expectedRoot) => {
    const all = window.__videoSwarmFolderRevisitMetrics || [];
    const request = all.find(
      (event) => event?.milestone === "request" && event?.rootPath === expectedRoot
    );
    return request
      ? all.filter((event) => event?.scanId === request.scanId)
      : [];
  }, rootPath);
  const error = events.find((event) => event?.milestone === "error");
  if (error) {
    throw new Error(error.error || `Folder scan failed for ${rootPath}`);
  }
  return events;
}

async function waitForCollectionCount(page, count, timeoutMs) {
  await page.waitForFunction(
    (expectedCount) => {
      const text = document.querySelector(".debug-info")?.textContent || "";
      const match = text.match(/🎬\s+(\d+)\s+videos/u);
      return Number(match?.[1]) === expectedCount;
    },
    count,
    { timeout: timeoutMs }
  );
}

async function sampleRendererResources(page, inactiveRootPath = null, forceGc = false) {
  return page.evaluate(
    async ({ inactiveRoot, shouldCollectGarbage }) => {
      if (shouldCollectGarbage && typeof window.gc === "function") {
        window.gc();
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const normalizePath = (value) => {
        let normalized = String(value || "").replaceAll("\\", "/").replace(/\/+$/u, "");
        if (/^[A-Z]:/u.test(normalized)) normalized = normalized.toLowerCase();
        return normalized;
      };
      const normalizedRoot = normalizePath(inactiveRoot);
      const belongsToInactiveRoot = (value) => {
        if (!normalizedRoot) return false;
        const normalized = normalizePath(value);
        return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
      };

      const cards = [...document.querySelectorAll(".video-item[data-video-id]")];
      const slots = [...document.querySelectorAll(".masonry-slot[data-masonry-id]")];
      const media = [...document.querySelectorAll("video")];
      const debugText = document.querySelector(".debug-info")?.textContent || "";
      const collectionMatch = debugText.match(/🎬\s+(\d+)\s+videos/u);
      let memory = null;
      try {
        memory = await window.appMem?.get?.();
      } catch {}
      const heapBytes = Number(performance.memory?.usedJSHeapSize);

      return {
        collectionCount: Number(collectionMatch?.[1]),
        mountedCards: cards.length,
        masonrySlots: slots.length,
        mediaElements: media.length,
        loadedMediaElements: media.filter((element) => element.readyState >= 2).length,
        playingMediaElements: media.filter((element) => !element.paused).length,
        inactiveRootCards: cards.filter((element) =>
          belongsToInactiveRoot(element.dataset.videoId)
        ).length,
        inactiveRootMasonrySlots: slots.filter((element) =>
          belongsToInactiveRoot(element.dataset.masonryId)
        ).length,
        inactiveRootMediaElements: media.filter((element) =>
          belongsToInactiveRoot(element.dataset.filePath)
        ).length,
        heapUsedMB: Number.isFinite(heapBytes) ? heapBytes / 1024 / 1024 : null,
        workingSetMB: Number(memory?.totals?.wsMB) || null,
      };
    },
    { inactiveRoot: inactiveRootPath, shouldCollectGarbage: forceGc }
  );
}

async function readAuthoritativeCollectionIdentity(page, rootPath, recursive) {
  const relativePaths = await page.evaluate(
    async ({ folderPath, scanRecursive }) => {
      const result = await window.electronAPI?.readDirectoryCache?.(
        folderPath,
        scanRecursive,
        `benchmark-validation-${Date.now()}`
      );
      if (!result?.cached || !Array.isArray(result.files)) {
        throw new Error("The completed folder did not produce an indexed snapshot");
      }
      return result.files
        .map((file) => String(file.relativePath || file.name || ""))
        .sort();
    },
    { folderPath: rootPath, scanRecursive: recursive }
  );
  const digest = createHash("sha256")
    .update(JSON.stringify(relativePaths))
    .digest("hex");
  return { recordCount: relativePaths.length, relativePathDigest: digest };
}

async function openFolder(page, electronApp, folderPath, expectedCount, options) {
  await resetFolderMetrics(page);
  const wallStartedAt = Date.now();
  await chooseFolderThroughNativeDialog(electronApp, page, folderPath);
  const events = await waitForFolderMilestones(
    page,
    folderPath,
    options.timeoutMs
  );
  const firstGrid = events.find(
    (event) => event.milestone === "first-usable-grid"
  );
  const completion = events.find((event) => event.milestone === "scan-complete");
  const cachedPreview = events.find(
    (event) => event.milestone === "cached-preview"
  );
  await waitForCollectionCount(page, expectedCount, options.timeoutMs);
  await delay(options.settleMs);
  return {
    scanId: completion.scanId,
    wallDurationMs: Date.now() - wallStartedAt,
    timings: {
      firstGridMs: Number(firstGrid.elapsedMs),
      refreshCompleteMs: Number(completion.elapsedMs),
      cachedPreviewMs: cachedPreview ? Number(cachedPreview.elapsedMs) : null,
    },
    milestoneRecordCount: Number(completion.recordCount),
    firstGridRecordCount: Number(firstGrid.recordCount),
    cache: {
      previewObserved: Boolean(cachedPreview),
      previewRecordCount: cachedPreview ? Number(cachedPreview.recordCount) : null,
      usablePreviewObserved:
        Boolean(cachedPreview) && Number(cachedPreview.recordCount) > 0,
      completionReportedCache: completion.cachedPreview === true,
    },
  };
}

async function runMeasuredTrial(context, dataset, options, metadata) {
  const measured = await openFolder(
    context.page,
    context.electronApp,
    dataset.rootPath,
    dataset.diskFileCount,
    options
  );
  const authoritativeCollection = await readAuthoritativeCollectionIdentity(
    context.page,
    dataset.rootPath,
    options.recursive
  );
  const activeResources = await sampleRendererResources(context.page);
  await openFolder(
    context.page,
    context.electronApp,
    dataset.sentinelPath,
    1,
    options
  );
  const cleanupResources = await sampleRendererResources(
    context.page,
    dataset.rootPath,
    true
  );
  return {
    ...metadata,
    processRunId: context.benchmarkProcessRunId,
    processId: context.electronApp.process().pid,
    ...measured,
    finalCollectionCount: activeResources.collectionCount,
    authoritativeCollection,
    activeResources,
    cleanupResources,
  };
}

async function launchBenchmarkApp(userDataPath, options, label) {
  const homePath = path.join(userDataPath, "home");
  const configPath = path.join(userDataPath, "config");
  const cachePath = path.join(userDataPath, "cache");
  const chromiumUserDataPath = path.join(userDataPath, "user-data");
  for (const directory of [
    homePath,
    configPath,
    cachePath,
    chromiumUserDataPath,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const context = await launchProductionApp({
    extraArgs: [
      `--user-data-dir=${chromiumUserDataPath}`,
      "--js-flags=--expose-gc",
      "--enable-precise-memory-info",
    ],
    extraEnv: {
      HOME: homePath,
      USERPROFILE: homePath,
      XDG_CACHE_HOME: cachePath,
      XDG_CONFIG_HOME: configPath,
      VIDEOSWARM_PROFILE_RUN: "1",
    },
  });
  context.benchmarkProcessRunId = label;
  context.electronApp.process().stdout?.on("data", (chunk) => {
    options.outputCollector.append(label, chunk);
  });
  context.electronApp.process().stderr?.on("data", (chunk) => {
    options.outputCollector.append(label, chunk);
  });
  await context.page.locator(".app").waitFor({ state: "visible" });
  await installFolderMetricsProbe(context.page);
  await ensureRecursiveMode(context.page, options.recursive);
  return context;
}

async function closeBenchmarkApp(context) {
  if (!context) return;
  await context.electronApp.close().catch(() => {});
  context.cleanupFiles();
}

function errorTrial(metadata, error) {
  return {
    ...metadata,
    error: error?.stack || error?.message || String(error),
  };
}

async function runColdTrials(dataset, options, persistReport) {
  for (let index = 0; index < options.trials; index += 1) {
    const metadata = { scenario: "cold", trial: index + 1 };
    const userDataPath = path.join(
      options.runRoot,
      dataset.key,
      "cold",
      String(index + 1)
    );
    let context = null;
    console.log(`[${dataset.key}] cold ${index + 1}/${options.trials}`);
    try {
      context = await launchBenchmarkApp(
        userDataPath,
        options,
        `${dataset.key}:cold:${index + 1}`
      );
      dataset.scenarios.cold.push(
        await runMeasuredTrial(context, dataset, options, metadata)
      );
    } catch (error) {
      dataset.scenarios.cold.push(errorTrial(metadata, error));
      console.error(error?.stack || error);
    } finally {
      await closeBenchmarkApp(context);
      persistReport();
    }
  }
}

async function runWarmTrials(dataset, options, persistReport) {
  const userDataPath = path.join(options.runRoot, dataset.key, "warm");
  let context = null;
  try {
    context = await launchBenchmarkApp(
      userDataPath,
      options,
      `${dataset.key}:warm`
    );
    console.log(`[${dataset.key}] priming same-process cache`);
    await runMeasuredTrial(context, dataset, options, {
      scenario: "warm-prime",
      trial: 0,
    });
    for (let index = 0; index < options.trials; index += 1) {
      const metadata = { scenario: "warm", trial: index + 1 };
      console.log(`[${dataset.key}] warm ${index + 1}/${options.trials}`);
      try {
        dataset.scenarios.warm.push(
          await runMeasuredTrial(context, dataset, options, metadata)
        );
      } catch (error) {
        dataset.scenarios.warm.push(errorTrial(metadata, error));
        console.error(error?.stack || error);
        break;
      } finally {
        persistReport();
      }
    }
  } catch (error) {
    dataset.errors.push({ scenario: "warm-setup", error: error?.stack || String(error) });
    console.error(error?.stack || error);
  } finally {
    await closeBenchmarkApp(context);
    persistReport();
  }
}

async function primeRestartCache(dataset, userDataPath, options) {
  let context = null;
  try {
    context = await launchBenchmarkApp(
      userDataPath,
      options,
      `${dataset.key}:restart-prime`
    );
    console.log(`[${dataset.key}] priming restart cache`);
    await runMeasuredTrial(context, dataset, options, {
      scenario: "restart-prime",
      trial: 0,
    });
    return true;
  } catch (error) {
    dataset.errors.push({
      scenario: "restart-prime",
      error: error?.stack || String(error),
    });
    console.error(error?.stack || error);
    return false;
  } finally {
    await closeBenchmarkApp(context);
  }
}

async function runRestartTrials(dataset, options, persistReport) {
  const userDataPath = path.join(options.runRoot, dataset.key, "restart");
  if (!(await primeRestartCache(dataset, userDataPath, options))) {
    persistReport();
    return;
  }
  for (let index = 0; index < options.trials; index += 1) {
    const metadata = { scenario: "restart", trial: index + 1 };
    let context = null;
    console.log(`[${dataset.key}] restart ${index + 1}/${options.trials}`);
    try {
      context = await launchBenchmarkApp(
        userDataPath,
        options,
        `${dataset.key}:restart:${index + 1}`
      );
      dataset.scenarios.restart.push(
        await runMeasuredTrial(context, dataset, options, metadata)
      );
    } catch (error) {
      dataset.scenarios.restart.push(errorTrial(metadata, error));
      console.error(error?.stack || error);
    } finally {
      await closeBenchmarkApp(context);
      persistReport();
    }
  }
}

async function main() {
  const args = readArguments(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (process.platform !== "linux") {
    throw new Error("The real-hardware folder revisit benchmark currently supports Linux only");
  }
  if (!fs.existsSync(path.resolve("dist-react/index.html"))) {
    throw new Error("Build the renderer first with `npm run vite:build`");
  }

  const requestedDatasets = [
    { key: "1000", declaredCount: 1000, argument: args["folder-1000"] },
    { key: "6000", declaredCount: 6000, argument: args["folder-6000"] },
  ].filter((dataset) => dataset.argument);
  if (!requestedDatasets.length) {
    printUsage();
    throw new Error("Pass --folder-1000, --folder-6000, or both");
  }

  const trials = positiveInteger(args.trials, 5, "trials");
  const timeoutMinutes = positiveInteger(
    args["timeout-minutes"],
    15,
    "timeout-minutes"
  );
  const settleMs = positiveInteger(args["settle-ms"], 750, "settle-ms");
  const recursive = args.flat !== true;
  const scenario = String(args.scenario || "all").toLowerCase();
  if (!["all", "cold", "warm", "restart"].includes(scenario)) {
    throw new Error("scenario must be all, cold, warm, or restart");
  }
  const capturedAt = new Date().toISOString();
  const outputPath = path.resolve(
    String(
      args.output ||
        `performance-results/folder-revisit-${capturedAt.replaceAll(":", "-")}.json`
    )
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-revisit-"));
  const outputCollector = createBoundedOutputCollector();

  const datasets = requestedDatasets.map((requested) => {
    const candidatePath = path.resolve(String(requested.argument));
    if (!fs.statSync(candidatePath, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Not a directory: ${candidatePath}`);
    }
    const rootPath = fs.realpathSync(candidatePath);
    const inspected = inspectVideoFolder(rootPath, recursive);
    if (inspected.fileCount < requested.declaredCount) {
      throw new Error(
        `${rootPath} contains ${inspected.fileCount} supported videos; ` +
        `${requested.declaredCount}+ are required for this size class`
      );
    }
    if (!inspected.smallestVideoPath) {
      throw new Error(`No supported video found in ${rootPath}`);
    }
    return {
      key: requested.key,
      label: `${requested.declaredCount.toLocaleString()}+ clips`,
      declaredCount: requested.declaredCount,
      diskFileCount: inspected.fileCount,
      rootPath,
      sentinelPath: createSentinelFolder(
        runRoot,
        requested.key,
        inspected.smallestVideoPath
      ),
      scenarios: { cold: [], warm: [], restart: [] },
      errors: [],
    };
  });

  const report = {
    schemaVersion: 1,
    capturedAt,
    completedAt: null,
    environment: {
      platform: process.platform,
      release: os.release(),
      cpuModel: os.cpus()[0]?.model || "unknown",
      cpuCount: os.cpus().length,
      totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
    },
    configuration: {
      trials,
      recursive,
      timeoutMs: timeoutMinutes * 60_000,
      settleMs,
      scenario,
      minimumCachedFirstGridSpeedup: 2,
    },
    datasets,
    evaluation: null,
    mainOutput: "",
  };
  const persistReport = () => {
    report.mainOutput = outputCollector.snapshot();
    report.evaluation = evaluateFolderRevisitReport(report);
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  };
  const options = {
    trials,
    recursive,
    timeoutMs: timeoutMinutes * 60_000,
    settleMs,
    runRoot,
    outputCollector,
  };

  try {
    persistReport();
    for (const dataset of datasets) {
      if (scenario === "all" || scenario === "cold") {
        await runColdTrials(dataset, options, persistReport);
      }
      if (scenario === "all" || scenario === "warm") {
        await runWarmTrials(dataset, options, persistReport);
      }
      if (scenario === "all" || scenario === "restart") {
        await runRestartTrials(dataset, options, persistReport);
      }
    }
    report.completedAt = new Date().toISOString();
    report.evaluation = evaluateFolderRevisitReport(report);
    persistReport();
    console.log(`Folder revisit report: ${outputPath}`);
    console.log(JSON.stringify(report.evaluation.summary, null, 2));
    if (!args["no-enforce"] && !report.evaluation.passed) {
      process.exitCode = 1;
      console.error(JSON.stringify({ failures: report.evaluation.failures }, null, 2));
    }
  } finally {
    if (!args["keep-profile-data"]) {
      fs.rmSync(runRoot, { recursive: true, force: true });
    } else {
      console.log(`Benchmark profile data retained at: ${runRoot}`);
    }
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
