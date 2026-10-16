#!/usr/bin/env node
// Generation-panel coverage over a real library: for every clip, what the
// panel would store and show - output, checkpoint, prompt, seed, steps - and
// with which evidence (Direct / Graph-derived / Partial). A development tool,
// not part of `npm test`: it reads your own files. See
// docs/architecture/generation-type-flow.md, Section 7.
//
//   node scripts/generation-coverage.cjs <folder> [--baseline <parser.js>]
//        [--fast] [--limit N] [--spot N] [--details <file>]
//
// The terminal output is counts only: folders are numbered rather than named,
// and no clip path, seed, model or prompt text is printed, so it is safe to
// paste into a chat. --details writes the folder names, the spot checks and
// the paths of clips that lost a field to a local file outside the
// repository. That file is for its owner: don't share it or have an AI
// assistant read it.
//
// By default tags are read with the ffprobe probe the Generation panel uses,
// and each result goes through the metadata service's own support check and
// persistence mapping. --fast reads ISO-BMFF tags in-process instead.
// --baseline names another module exporting parseComfyGenerationPayload (for
// example the previous parser, extracted from git) to compare against; a
// field the baseline found and the current reader lost is counted as lost.

const fs = require("fs");
const path = require("path");
const { readIsoBmffEmbeddedPayload, isIsoBmffPath } = require("../main/container-tags");
const { createEmbeddedMetadataProbe } = require("../main/embedded-metadata-probe");
const { parseComfyGenerationPayload } = require("../main/comfy-generation-parser");
const {
  buildPersistenceInput,
  hasSupportedFields,
} = require("../main/generation-metadata-service");

const VIDEO = /\.(mp4|mov|m4v|webm|mkv)$/i;
const FIELDS = ["output", "checkpoint", "prompt", "seed", "steps"];
const QUALITIES = ["exact", "derived", "partial", "none"];
const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const ROOT_GROUP = ".";

function usage() {
  return "usage: generation-coverage.cjs <folder> [--baseline <parser.js>] [--fast] [--limit N] [--spot N] [--details <file>]";
}

function parseArgs(argv) {
  const args = {
    root: null,
    baseline: null,
    fast: false,
    limit: Infinity,
    spot: 12,
    details: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--limit") args.limit = Number(argv[++index]);
    else if (arg === "--spot") args.spot = Number(argv[++index]);
    else if (arg === "--baseline") args.baseline = path.resolve(argv[++index] || "");
    else if (arg === "--details") args.details = argv[++index] || null;
    else if (arg === "--fast") args.fast = true;
    else if (!args.root) args.root = arg;
    else return { error: `unexpected argument (${index + 1})` };
  }
  if (!args.root) return { error: "a folder is required" };
  if (!(args.limit > 0)) return { error: "--limit must be a positive number" };
  if (!(args.spot >= 0)) return { error: "--spot must be zero or more" };
  if (argv.includes("--details") && !args.details) {
    return { error: "--details needs a file path" };
  }
  return args;
}

function isInside(parent, target) {
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function* walk(directory) {
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && VIDEO.test(entry.name)) yield full;
  }
}

// What the panel would persist for this parse, via the service's own rules.
function panelView(parse, payload, file) {
  let analysis = null;
  try {
    analysis = parse(payload, {
      fileName: path.basename(file),
      origin: { kind: "embedded", carrier: path.extname(file).slice(1) },
    });
  } catch {
    analysis = null;
  }
  if (!hasSupportedFields(analysis)) {
    return { fields: Object.fromEntries(FIELDS.map((field) => [field, false])), quality: "none", analysis };
  }
  const stored = buildPersistenceInput({
    analysis,
    sourceKind: "embedded",
    sourceFormat: path.extname(file).slice(1),
    sourceLabel: "Embedded",
    signature: { size: 0, mtimeMs: 0 },
    readerAvailable: true,
    readerStatus: "found",
    fallbackDiagnostics: [],
    limits: { maxDiagnostics: 64 },
  });
  return {
    fields: {
      output: Boolean(analysis.output),
      checkpoint: stored.models.length > 0,
      prompt: Boolean(
        stored.positivePrompt ||
          stored.promptFragments.some((fragment) => fragment.role === "positive")
      ),
      seed: stored.seed !== null && stored.seed !== undefined,
      steps: stored.samplingParameters.steps !== undefined,
    },
    quality: stored.quality,
    analysis,
    stored,
  };
}

async function readPayload(file, probe, fast) {
  if (fast && isIsoBmffPath(file)) {
    const result = await readIsoBmffEmbeddedPayload(file, {}, { includeWorkflow: true });
    return result.status === "found" ? result.payload : null;
  }
  const result = await probe.probe(file);
  return result.status === "found" ? result.payload : null;
}

const percent = (count, total) =>
  total ? `${Math.round((count / total) * 100)}%`.padStart(4) : "  - ";

const emptyBucket = () => ({ total: 0, tagged: 0, base: {}, current: {}, quality: {} });

// Folder names say what a library holds, so the shareable output numbers the
// folders instead; the --details file maps the numbers back to names.
function labelFolders(groupNames) {
  const labels = new Map();
  let next = 1;
  for (const name of [...groupNames].sort()) {
    labels.set(name, name === ROOT_GROUP ? "top level" : `folder ${next++}`);
  }
  return labels;
}

/**
 * The shareable summary: the coverage table with numbered folders and the
 * count of clips that lost a field. `groups` maps a folder name to its counts.
 * Never includes a folder name, a path, a seed, a model or prompt text.
 */
function renderCoverageSummary({
  groups,
  baseline = false,
  lostCount = 0,
  spotCount = 0,
  detailsWritten = false,
}) {
  const labels = labelFolders(groups.keys());
  const cell = (bucket, field) =>
    baseline
      ? `${percent(bucket.base[field] || 0, bucket.tagged)}->${percent(bucket.current[field] || 0, bucket.tagged)}`
      : percent(bucket.current[field] || 0, bucket.tagged);
  const width = baseline ? 11 : 6;
  const lines = [
    `${"folder".padEnd(16)} ${"clips".padStart(5)} ${"tagged".padStart(6)}  ` +
      FIELDS.map((field) => field.padEnd(width)).join(" ") +
      `  ${QUALITIES.map((quality) => quality.padStart(7)).join("")}` +
      (baseline ? "   (baseline -> current, % of tagged)" : "   (% of tagged)"),
  ];
  const totals = emptyBucket();
  const row = (name, bucket) =>
    `${name.slice(0, 16).padEnd(16)} ${String(bucket.total).padStart(5)} ${String(bucket.tagged).padStart(6)}  ` +
    FIELDS.map((field) => cell(bucket, field).padEnd(width)).join(" ") +
    `  ${QUALITIES.map((quality) => String(bucket.quality[quality] || 0).padStart(7)).join("")}`;
  for (const [group, bucket] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    totals.total += bucket.total;
    totals.tagged += bucket.tagged;
    for (const field of FIELDS) {
      totals.base[field] = (totals.base[field] || 0) + (bucket.base[field] || 0);
      totals.current[field] = (totals.current[field] || 0) + (bucket.current[field] || 0);
    }
    for (const quality of QUALITIES) {
      totals.quality[quality] = (totals.quality[quality] || 0) + (bucket.quality[quality] || 0);
    }
    lines.push(row(labels.get(group), bucket));
  }
  lines.push(row("ALL", totals));
  if (baseline) lines.push("", `${lostCount} clip(s) lost a field the baseline found.`);
  lines.push(
    "",
    detailsWritten
      ? `Folder names, ${spotCount} spot check(s) and lost-field paths were written to the --details file.`
      : "Folder names, spot checks and lost-field paths: rerun with --details <file> to list them."
  );
  return lines;
}

// The owner's file: folder names for the numbers, then the spot checks and
// lost-field lines, which name clips and show seeds.
function renderCoverageDetails({ groups, spots }) {
  const labels = labelFolders(groups.keys());
  return [
    "Generation coverage details",
    "",
    "This file names your folders and clips and shows seeds. Keep it on this machine:",
    "don't share it or have an AI assistant read it.",
    "",
    "folders:",
    ...[...labels.entries()].map(([name, label]) => `  ${label.padEnd(12)} ${name}`),
    "",
    spots.length ? "spot checks:" : "no spot checks",
    ...spots,
    "",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`${args.error}\n${usage()}`);
    process.exit(2);
  }
  const details = args.details ? path.resolve(args.details) : null;
  if (details && isInside(REPOSITORY_ROOT, details)) {
    console.error(
      "Choose a --details path outside the Video Swarm repository, so the file can never be committed."
    );
    process.exit(2);
  }
  const root = path.resolve(args.root);
  const baseline = args.baseline ? require(args.baseline).parseComfyGenerationPayload : null;
  const probe = createEmbeddedMetadataProbe();
  const groups = new Map();
  const spots = [];
  let seen = 0;
  let lostCount = 0;

  for (const file of walk(root)) {
    if (seen >= args.limit) break;
    seen += 1;
    const relative = path.relative(root, file);
    const group = relative.includes(path.sep) ? relative.split(path.sep)[0] : ROOT_GROUP;
    if (!groups.has(group)) groups.set(group, emptyBucket());
    const bucket = groups.get(group);
    bucket.total += 1;
    const payload = await readPayload(file, probe, args.fast).catch(() => null);
    if (!payload?.prompt) continue;
    bucket.tagged += 1;
    const current = panelView(parseComfyGenerationPayload, payload, file);
    bucket.quality[current.quality] = (bucket.quality[current.quality] || 0) + 1;
    const base = baseline ? panelView(baseline, payload, file) : null;
    for (const field of FIELDS) {
      bucket.current[field] = (bucket.current[field] || 0) + Number(current.fields[field]);
      if (base) bucket.base[field] = (bucket.base[field] || 0) + Number(base.fields[field]);
    }
    const lost = base ? FIELDS.filter((field) => base.fields[field] && !current.fields[field]) : [];
    if (lost.length) {
      lostCount += 1;
      spots.push(`  LOST ${lost.join(",").padEnd(22)} ${relative}`);
    } else if (spots.length - lostCount < args.spot && seen % 97 === 0) {
      const finalStage = current.stored?.samplingParameters || {};
      spots.push(
        `  seen ${current.quality.padEnd(8)} seed=${current.stored?.seed ?? "-"} steps=${finalStage.steps ?? "-"} ` +
          `models=${current.stored?.models.length ?? 0} loras=${current.stored?.loras.length ?? 0}  ${relative}`
      );
    }
  }
  await probe.shutdown();

  if (details) {
    fs.writeFileSync(details, renderCoverageDetails({ groups, spots }), {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  console.log(
    renderCoverageSummary({
      groups,
      baseline: Boolean(baseline),
      lostCount,
      spotCount: spots.length,
      detailsWritten: Boolean(details),
    }).join("\n")
  );
}

if (require.main === module) {
  main().catch((error) => {
    // Only the error's code or name: its message or stack could carry a path.
    console.error(`generation-coverage failed: ${error?.code || error?.name || "error"}`);
    process.exit(1);
  });
}

module.exports = {
  labelFolders,
  parseArgs,
  renderCoverageDetails,
  renderCoverageSummary,
};
