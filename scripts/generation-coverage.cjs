#!/usr/bin/env node
// Generation-panel coverage over a real library: for every clip, what the
// panel would store and show - output, checkpoint, prompt, seed, steps - and
// with which evidence (Direct / Graph-derived / Partial). A development tool,
// not part of `npm test`: it reads your own files. Prints counts and field
// presence only, never prompt text. See
// docs/architecture/generation-type-flow.md, Section 7.
//
//   node scripts/generation-coverage.cjs <folder> [--baseline <parser.js>]
//        [--fast] [--limit N] [--spot N]
//
// By default tags are read with the ffprobe probe the Generation panel uses,
// and each result goes through the metadata service's own support check and
// persistence mapping. --fast reads ISO-BMFF tags in-process instead.
// --baseline names another module exporting parseComfyGenerationPayload (for
// example the previous parser, extracted from git) to compare against; a
// field the baseline found and the current reader lost is listed as LOST.

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

function parseArgs(argv) {
  const args = { root: null, baseline: null, fast: false, limit: Infinity, spot: 12 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--limit") args.limit = Number(argv[++index]);
    else if (arg === "--spot") args.spot = Number(argv[++index]);
    else if (arg === "--baseline") args.baseline = path.resolve(argv[++index]);
    else if (arg === "--fast") args.fast = true;
    else args.root = arg;
  }
  if (!args.root) {
    console.error(
      "usage: generation-coverage.cjs <folder> [--baseline <parser.js>] [--fast] [--limit N] [--spot N]"
    );
    process.exit(2);
  }
  return args;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  const baseline = args.baseline ? require(args.baseline).parseComfyGenerationPayload : null;
  const probe = createEmbeddedMetadataProbe();
  const groups = new Map();
  const spots = [];
  let seen = 0;

  for (const file of walk(root)) {
    if (seen >= args.limit) break;
    seen += 1;
    const relative = path.relative(root, file);
    const group = relative.includes(path.sep) ? relative.split(path.sep)[0] : ".";
    if (!groups.has(group)) {
      groups.set(group, { total: 0, tagged: 0, base: {}, current: {}, quality: {} });
    }
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
      spots.push(`  LOST ${lost.join(",").padEnd(22)} ${relative}`);
    } else if (spots.length < args.spot && seen % 97 === 0) {
      const finalStage = current.stored?.samplingParameters || {};
      spots.push(
        `  seen ${current.quality.padEnd(8)} seed=${current.stored?.seed ?? "-"} steps=${finalStage.steps ?? "-"} ` +
          `models=${current.stored?.models.length ?? 0} loras=${current.stored?.loras.length ?? 0}  ${relative}`
      );
    }
  }
  await probe.shutdown();

  const cell = (bucket, field) =>
    baseline
      ? `${percent(bucket.base[field] || 0, bucket.tagged)}->${percent(bucket.current[field] || 0, bucket.tagged)}`
      : percent(bucket.current[field] || 0, bucket.tagged);
  const width = baseline ? 11 : 6;
  console.log(
    `${"folder".padEnd(16)} ${"clips".padStart(5)} ${"tagged".padStart(6)}  ` +
      FIELDS.map((field) => field.padEnd(width)).join(" ") +
      `  ${QUALITIES.map((quality) => quality.padStart(7)).join("")}` +
      (baseline ? "   (baseline -> current, % of tagged)" : "   (% of tagged)")
  );
  const totals = { total: 0, tagged: 0, base: {}, current: {}, quality: {} };
  const row = (name, bucket) =>
    `${name.slice(0, 16).padEnd(16)} ${String(bucket.total).padStart(5)} ${String(bucket.tagged).padStart(6)}  ` +
    FIELDS.map((field) => cell(bucket, field).padEnd(width)).join(" ") +
    `  ${QUALITIES.map((quality) => String(bucket.quality[quality] || 0).padStart(7)).join("")}`;
  for (const [group, bucket] of [...groups.entries()].sort()) {
    totals.total += bucket.total;
    totals.tagged += bucket.tagged;
    for (const field of FIELDS) {
      totals.base[field] = (totals.base[field] || 0) + (bucket.base[field] || 0);
      totals.current[field] = (totals.current[field] || 0) + (bucket.current[field] || 0);
    }
    for (const quality of QUALITIES) {
      totals.quality[quality] = (totals.quality[quality] || 0) + (bucket.quality[quality] || 0);
    }
    console.log(row(group, bucket));
  }
  console.log(row("ALL", totals));
  const lostCount = spots.filter((line) => line.startsWith("  LOST")).length;
  if (baseline) console.log(`\n${lostCount} clip(s) lost a field the baseline found.`);
  if (spots.length) {
    console.log("\nspot checks:");
    spots.slice(0, Math.max(args.spot, lostCount)).forEach((line) => console.log(line));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
