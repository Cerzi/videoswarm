#!/usr/bin/env node
// Generation-metadata coverage over a real library: how often the shipped
// class-list parser and the socket-type reader each find a render's output,
// checkpoint, prompt, seed and steps. A development tool, not part of
// `npm test`: it reads your own files. Prints counts and field presence only,
// never prompt text. See docs/architecture/generation-type-flow.md, Section 7.
//
//   node scripts/generation-coverage.cjs <folder> [--limit N] [--spot N]
//
// Clips are grouped by the first folder level under <folder>.

const fs = require("fs");
const path = require("path");
const { readIsoBmffEmbeddedPayload, isIsoBmffPath } = require("../main/container-tags");
const { createEmbeddedMetadataProbe } = require("../main/embedded-metadata-probe");
const { parseComfyGenerationPayload } = require("../main/comfy-generation-parser");
const { parseComfyTypeFlow } = require("../main/comfy-type-flow");

const VIDEO = /\.(mp4|mov|m4v|webm|mkv)$/i;
const FIELDS = ["output", "checkpoint", "prompt", "seed", "steps"];

function parseArgs(argv) {
  const args = { root: null, limit: Infinity, spot: 12 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--limit") args.limit = Number(argv[++index]);
    else if (argv[index] === "--spot") args.spot = Number(argv[++index]);
    else args.root = argv[index];
  }
  if (!args.root) {
    console.error("usage: generation-coverage.cjs <folder> [--limit N] [--spot N]");
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

function presence(result) {
  const finalStage = result?.samplerStages?.find((stage) => stage.role === "final") ||
    result?.samplerStages?.at(-1);
  return {
    output: Boolean(result?.output),
    checkpoint: Boolean(result?.models?.length),
    prompt: Boolean(
      result?.prompt || result?.promptFragments?.some((fragment) => fragment.role === "positive")
    ),
    seed: result?.seed !== null && result?.seed !== undefined,
    steps: finalStage?.steps !== null && finalStage?.steps !== undefined,
  };
}

function safely(parse) {
  try {
    return parse() || null;
  } catch {
    return null;
  }
}

async function readPayload(file, probe) {
  if (isIsoBmffPath(file)) {
    const result = await readIsoBmffEmbeddedPayload(file, {}, { includeWorkflow: true });
    return result.status === "found" ? result.payload : null;
  }
  const result = await probe.probe(file);
  return result.status === "found" ? result.payload : null;
}

function percent(count, total) {
  return total ? `${Math.round((count / total) * 100)}%`.padStart(5) : "   - ";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
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
      groups.set(group, { total: 0, tagged: 0, old: {}, flow: {} });
    }
    const bucket = groups.get(group);
    bucket.total += 1;
    const payload = await readPayload(file, probe).catch(() => null);
    if (!payload?.prompt) continue;
    bucket.tagged += 1;
    const options = { fileName: path.basename(file), origin: { kind: "embedded" } };
    const old = presence(safely(() => parseComfyGenerationPayload(payload.prompt, options)));
    const flowResult = safely(() => parseComfyTypeFlow(payload, options));
    const flow = presence(flowResult);
    for (const field of FIELDS) {
      bucket.old[field] = (bucket.old[field] || 0) + Number(old[field]);
      bucket.flow[field] = (bucket.flow[field] || 0) + Number(flow[field]);
    }
    const lost = FIELDS.filter((field) => old[field] && !flow[field]);
    if (lost.length && spots.length < args.spot) {
      spots.push(`  LOST ${lost.join(",").padEnd(20)} ${relative}`);
    } else if (spots.length < args.spot && seen % 97 === 0) {
      spots.push(
        `  seen ${FIELDS.map((field) => `${field}:${Number(old[field])}->${Number(flow[field])}`).join(" ")}  ${relative}` +
          (flowResult ? `  seed=${flowResult.seed} steps=${flowResult.samplerStages?.find((stage) => stage.role === "final")?.steps ?? "-"}` : "")
      );
    }
  }
  await probe.shutdown();

  const header = `${"folder".padEnd(18)} ${"clips".padStart(6)} ${"tagged".padStart(6)}  ` +
    FIELDS.map((field) => `${field.padEnd(10)}`).join(" ") + "   (shipped -> type-flow, % of tagged)";
  console.log(header);
  const totals = { total: 0, tagged: 0, old: {}, flow: {} };
  for (const [group, bucket] of [...groups.entries()].sort()) {
    totals.total += bucket.total;
    totals.tagged += bucket.tagged;
    for (const field of FIELDS) {
      totals.old[field] = (totals.old[field] || 0) + (bucket.old[field] || 0);
      totals.flow[field] = (totals.flow[field] || 0) + (bucket.flow[field] || 0);
    }
    console.log(
      `${group.slice(0, 18).padEnd(18)} ${String(bucket.total).padStart(6)} ${String(bucket.tagged).padStart(6)}  ` +
        FIELDS.map((field) =>
          `${percent(bucket.old[field] || 0, bucket.tagged)}->${percent(bucket.flow[field] || 0, bucket.tagged)}`.padEnd(10)
        ).join(" ")
    );
  }
  console.log(
    `${"ALL".padEnd(18)} ${String(totals.total).padStart(6)} ${String(totals.tagged).padStart(6)}  ` +
      FIELDS.map((field) =>
        `${percent(totals.old[field] || 0, totals.tagged)}->${percent(totals.flow[field] || 0, totals.tagged)}`.padEnd(10)
      ).join(" ")
  );
  if (spots.length) {
    console.log("\nspot checks:");
    spots.forEach((line) => console.log(line));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
