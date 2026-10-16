#!/usr/bin/env node
// Prompt stacks over your own library, for checking the prompt key before
// relying on it. Reads the ComfyUI prompt embedded in each clip, groups clips
// by the prompt key exactly as the app does, and estimates how many stacks
// differ only by a few words. A development tool, not part of `npm test`: it
// reads your own files. See docs/architecture/prompt-stacks.md, Section 6.
//
//   node scripts/prompt-stack-report.cjs <folder> --out <report.html>
//        [--limit N] [--iso-only]
//
// Nothing leaves this machine. The script makes no network requests, and the
// report page is locked down so that it cannot either. The terminal output is
// counts only - never prompt text, file names, paths or keys (a key is a hash,
// and a hash of a short prompt can be guessed) - so it is safe to paste into a
// chat. The report file holds your prompts, paths and previews: open it
// yourself, and do not share it or have an AI assistant read it.
//
// MP4/MOV tags are read in-process; WebM/MKV need ffprobe on PATH and are
// skipped with --iso-only.

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { isIsoBmffPath, readIsoBmffEmbeddedPayload } = require("../main/container-tags");
const { createEmbeddedMetadataProbe } = require("../main/embedded-metadata-probe");
const { computeGenerationKeys, deriveGenerationKeyParts } = require("../main/generation-key");

const VIDEO = /\.(mp4|m4v|mov|qt|webm|mkv)$/i;
const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const SIMILAR_THRESHOLD = 0.8;
const MIN_SIMILAR_WORDS = 4;
const PREVIEWS_PER_STACK = 8;
const MAX_REPORTED_PAIRS = 200;
const SIZE_BUCKETS = Object.freeze([
  [2, 2],
  [3, 5],
  [6, 10],
  [11, 20],
  [21, 50],
  [51, Infinity],
]);
const WORD = /[\p{L}\p{N}]+/gu;

function usage() {
  return "usage: prompt-stack-report.cjs <folder> --out <report.html> [--limit N] [--iso-only]";
}

function parseArgs(argv) {
  const args = { root: null, out: null, limit: Infinity, isoOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") args.out = argv[++index] || null;
    else if (arg === "--limit") args.limit = Number(argv[++index]);
    else if (arg === "--iso-only") args.isoOnly = true;
    else if (!args.root) args.root = arg;
    else return { error: `unexpected argument (${index + 1})` };
  }
  if (!args.root || !args.out) return { error: "a folder and --out are required" };
  if (!(args.limit > 0)) return { error: "--limit must be a positive number" };
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
    // Symbolic links are neither followed nor read, so a loop or a link out
    // of the folder cannot widen what is scanned.
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && VIDEO.test(entry.name)) yield full;
  }
}

async function readPayload(file, probe, isoOnly) {
  if (isIsoBmffPath(file)) {
    const result = await readIsoBmffEmbeddedPayload(file);
    return { status: result.status, payload: result.payload || null };
  }
  if (isoOnly) return { status: "skipped", payload: null };
  const result = await probe.probe(file);
  return { status: result?.status || "unreadable", payload: result?.payload || null };
}

// One clip's evidence. `texts` and `media` stay in memory for the report and
// are never printed.
function describeClip({ relative, file, size, mtimeMs, read }) {
  const clip = { relative, file, size, mtimeMs, outcome: "unread" };
  if (read.status === "skipped") return { ...clip, outcome: "skipped" };
  if (read.status !== "found" && read.status !== "not-found") return clip;
  const prompt = read.payload?.prompt;
  if (read.status === "not-found" || typeof prompt !== "string" || !prompt) {
    return { ...clip, outcome: "no-prompt" };
  }
  const keys = computeGenerationKeys(prompt);
  if (!keys.promptKey) return { ...clip, outcome: "unkeyed" };
  const parts = deriveGenerationKeyParts(prompt);
  return {
    ...clip,
    outcome: "keyed",
    generationKey: keys.generationKey,
    promptKey: keys.promptKey,
    texts: parts?.texts || [],
    media: parts?.media || [],
  };
}

// Prompt groups, largest first. A group of two or more is a stack.
function groupByPrompt(clips) {
  const groups = new Map();
  for (const clip of clips) {
    if (clip.outcome !== "keyed") continue;
    let group = groups.get(clip.promptKey);
    if (!group) {
      group = {
        promptKey: clip.promptKey,
        texts: clip.texts,
        media: clip.media,
        clips: [],
        generations: new Map(),
      };
      groups.set(clip.promptKey, group);
    }
    if (!group.generations.has(clip.generationKey)) {
      group.generations.set(clip.generationKey, group.generations.size + 1);
    }
    group.clips.push(clip);
  }
  return [...groups.values()].sort(
    (a, b) =>
      b.clips.length - a.clips.length || (a.promptKey < b.promptKey ? -1 : 1)
  );
}

function wordsOf(texts) {
  const words = new Set();
  for (const text of texts) {
    for (const match of text.matchAll(WORD)) words.add(match[0].toLowerCase());
  }
  return words;
}

function jaccard(a, b) {
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const word of small) if (large.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Prompt groups whose prompts differ by only a few words: what a future
 * "similar prompt" mode would add to exact stacking. Groups are compared only
 * when their input media match, because different media already mean
 * different clips. A text shared by many groups (typically the negative
 * prompt or a style suffix) says nothing about which prompt a clip is, so it
 * is left out of the comparison. Candidates come from an inverted index of
 * the rarer words, so this is an estimate, not an exhaustive search.
 */
function findSimilarGroups(groups, { threshold = SIMILAR_THRESHOLD } = {}) {
  const textFrequency = new Map();
  for (const group of groups) {
    for (const text of group.texts) {
      textFrequency.set(text, (textFrequency.get(text) || 0) + 1);
    }
  }
  const boilerplateAt = Math.max(3, Math.ceil(groups.length * 0.25));
  const profiles = groups.map((group) => ({
    media: JSON.stringify(group.media),
    words: wordsOf(group.texts.filter((text) => textFrequency.get(text) < boilerplateAt)),
  }));

  const postings = new Map();
  profiles.forEach((profile, index) => {
    if (profile.words.size < MIN_SIMILAR_WORDS) return;
    for (const word of profile.words) {
      if (!postings.has(word)) postings.set(word, []);
      postings.get(word).push(index);
    }
  });
  const maxPosting = Math.max(50, Math.ceil(groups.length * 0.02));

  const pairs = [];
  profiles.forEach((profile, index) => {
    if (profile.words.size < MIN_SIMILAR_WORDS) return;
    const candidates = new Set();
    for (const word of profile.words) {
      const list = postings.get(word);
      if (!list || list.length > maxPosting) continue;
      for (const other of list) if (other > index) candidates.add(other);
    }
    for (const other of candidates) {
      const candidate = profiles[other];
      if (candidate.media !== profile.media) continue;
      const sizes = [profile.words.size, candidate.words.size];
      if (Math.min(...sizes) / Math.max(...sizes) < threshold) continue;
      const similarity = jaccard(profile.words, candidate.words);
      if (similarity >= threshold) pairs.push({ a: index, b: other, similarity });
    }
  });
  pairs.sort((x, y) => y.similarity - x.similarity || x.a - y.a || x.b - y.b);

  // How many cards a similar-prompt mode would leave: each group joins the
  // first larger group it is close to, and never a chain of neighbours, so a
  // prompt refined one word at a time cannot collapse a whole session.
  const similar = new Map();
  for (const pair of pairs) {
    if (!similar.has(pair.a)) similar.set(pair.a, new Set());
    if (!similar.has(pair.b)) similar.set(pair.b, new Set());
    similar.get(pair.a).add(pair.b);
    similar.get(pair.b).add(pair.a);
  }
  const anchors = [];
  groups.forEach((_, index) => {
    const near = similar.get(index);
    if (!near || !anchors.some((anchor) => near.has(anchor))) anchors.push(index);
  });

  return {
    pairs,
    groupsInPairs: similar.size,
    groupsIfSimilarStacked: anchors.length,
  };
}

function bucketLabel([low, high]) {
  if (low === high) return String(low);
  return Number.isFinite(high) ? `${low}-${high}` : `${low}+`;
}

function summarize(clips, groups, similar, elapsedMs) {
  const count = (outcome) => clips.filter((clip) => clip.outcome === outcome).length;
  const stacks = groups.filter((group) => group.clips.length >= 2);
  const keyed = count("keyed");
  const notStackable = clips.length - keyed;
  const cardsNow = clips.length;
  const cardsStacked = notStackable + groups.length;
  const cardsSimilar = notStackable + similar.groupsIfSimilarStacked;
  const reduction = (cards) =>
    cardsNow ? `${Math.round((1 - cards / cardsNow) * 100)}%` : "0%";
  const sizes = SIZE_BUCKETS.map(
    (bucket) =>
      `${bucketLabel(bucket)}: ${stacks.filter((stack) => stack.clips.length >= bucket[0] && stack.clips.length <= bucket[1]).length}`
  );
  return [
    `clips found            ${cardsNow}`,
    `  with a prompt key    ${keyed}`,
    `  prompt but no key    ${count("unkeyed")}`,
    `  no embedded prompt   ${count("no-prompt")}`,
    `  unreadable           ${count("unread")}`,
    `  skipped (--iso-only) ${count("skipped")}`,
    `stacks (2+ clips)      ${stacks.length}`,
    `  clips in stacks      ${stacks.reduce((sum, stack) => sum + stack.clips.length, 0)}`,
    `  largest stack        ${stacks[0]?.clips.length || 0}`,
    `  stacks by size       ${sizes.join("  ")}`,
    `  with several seeds   ${stacks.filter((stack) => stack.generations.size > 1).length}`,
    `  one seed, versions   ${stacks.filter((stack) => stack.generations.size === 1).length}`,
    `grid cards             ${cardsNow} -> ${cardsStacked} stacked (${reduction(cardsStacked)} fewer)`,
    `close prompt pairs     ${similar.pairs.length} (estimate; ${similar.groupsInPairs} prompt groups involved)`,
    `  if similar stacked   ${cardsNow} -> ${cardsSimilar} cards (${reduction(cardsSimilar)} fewer)`,
    `time                   ${(elapsedMs / 1000).toFixed(1)} s`,
  ];
}

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
const shorten = (text, max = 400) => (text.length > max ? `${text.slice(0, max)}…` : text);

function renderTexts(texts) {
  if (texts.length === 0) return "";
  return `<ul class="texts">${texts
    .map((text) => `<li title="${escapeHtml(text)}">${escapeHtml(shorten(text))}</li>`)
    .join("")}</ul>`;
}

function renderPreview(clip) {
  return `<figure><video muted loop playsinline preload="none" data-src="${escapeHtml(
    pathToFileURL(clip.file).href
  )}"></video><figcaption>${escapeHtml(path.basename(clip.relative))}</figcaption></figure>`;
}

function renderStack(group, index) {
  const ordered = [...group.clips].sort(
    (a, b) =>
      group.generations.get(a.generationKey) - group.generations.get(b.generationKey) ||
      b.mtimeMs - a.mtimeMs
  );
  const rows = ordered
    .map(
      (clip) =>
        `<tr><td>G${group.generations.get(clip.generationKey)}</td><td>${escapeHtml(
          clip.relative
        )}</td><td>${(clip.size / 1048576).toFixed(1)} MB</td><td>${escapeHtml(
          new Date(clip.mtimeMs).toISOString().slice(0, 16).replace("T", " ")
        )}</td></tr>`
    )
    .join("");
  const media = group.media.length
    ? `<p class="media">Input media: ${group.media.map(escapeHtml).join(", ")}</p>`
    : "";
  return `<section class="stack" id="s${index + 1}">
<h3>Stack ${index + 1} · ${group.clips.length} clips · ${group.generations.size} seed${
    group.generations.size === 1 ? "" : "s"
  }</h3>
${renderTexts(group.texts)}${media}
<div class="previews">${ordered.slice(0, PREVIEWS_PER_STACK).map(renderPreview).join("")}</div>
<details><summary>All ${group.clips.length} clips (G = seed group)</summary><table>${rows}</table></details>
</section>`;
}

// Words in one prompt and not the other, highlighted, so a close pair can be
// judged at a glance.
function renderDifference(texts, otherWords) {
  return texts
    .map((text) =>
      // Split before escaping, so an entity can never be cut by a mark.
      shorten(text, 600)
        .split(/([\p{L}\p{N}]+)/u)
        .map((piece, index) => {
          const escaped = escapeHtml(piece);
          const isWord = index % 2 === 1;
          return isWord && !otherWords.has(piece.toLowerCase())
            ? `<mark>${escaped}</mark>`
            : escaped;
        })
        .join("")
    )
    .join("<br>");
}

function renderPairs(groups, similar) {
  if (similar.pairs.length === 0) return "<p>No close pairs found.</p>";
  const label = (index) =>
    groups[index].clips.length >= 2
      ? `<a href="#s${index + 1}">stack ${index + 1}</a> (${groups[index].clips.length})`
      : `single clip ${escapeHtml(groups[index].clips[0].relative)}`;
  return `<table class="pairs">${similar.pairs
    .slice(0, MAX_REPORTED_PAIRS)
    .map(({ a, b, similarity }) => {
      const wordsA = wordsOf(groups[a].texts);
      const wordsB = wordsOf(groups[b].texts);
      return `<tr><td>${Math.round(similarity * 100)}%</td><td>${label(a)}<br>${renderDifference(
        groups[a].texts,
        wordsB
      )}</td><td>${label(b)}<br>${renderDifference(groups[b].texts, wordsA)}</td></tr>`;
    })
    .join("")}</table>${
    similar.pairs.length > MAX_REPORTED_PAIRS
      ? `<p>…and ${similar.pairs.length - MAX_REPORTED_PAIRS} more.</p>`
      : ""
  }`;
}

// The page may load local media and nothing else: no network, no frames, no
// forms, whatever a prompt or a path happens to contain.
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; media-src file:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

const PAGE_STYLE = `
body { font: 13px/1.4 system-ui, sans-serif; margin: 16px; background: #111; color: #ddd; }
h1, h2, h3 { font-weight: 600; } h3 { margin: 0 0 6px; font-size: 14px; }
pre { background: #1b1b1b; padding: 8px; overflow-x: auto; }
.stack { border-top: 1px solid #333; padding: 12px 0; }
.texts { margin: 0 0 6px; padding-left: 18px; color: #bbb; }
.media { margin: 0 0 6px; color: #999; }
.previews { display: flex; flex-wrap: wrap; gap: 4px; }
figure { margin: 0; width: 180px; } figcaption { font-size: 11px; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
video { width: 180px; height: 110px; background: #000; object-fit: contain; }
table { border-collapse: collapse; } td { padding: 2px 8px; border-bottom: 1px solid #222; vertical-align: top; }
mark { background: #6b5200; color: #fff; } a { color: #8ab4ff; }
.warning { color: #f0b860; }`;

const PAGE_SCRIPT = `
const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const video = entry.target;
    if (entry.isIntersecting) {
      if (!video.src) { video.preload = "metadata"; video.src = video.dataset.src; }
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }
}, { rootMargin: "200px" });
document.querySelectorAll("video[data-src]").forEach((video) => observer.observe(video));`;

function renderReport({ groups, similar, summary }) {
  const stacks = groups.filter((group) => group.clips.length >= 2);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">
<meta name="referrer" content="no-referrer">
<title>Prompt stacks report</title>
<style>${PAGE_STYLE}</style></head><body>
<h1>Prompt stacks report</h1>
<p class="warning">This page contains your prompts and file paths. Keep it on this machine: don't share it or have an AI assistant read it. The summary below is counts only and is safe to share.</p>
<pre>${escapeHtml(summary.join("\n"))}</pre>
<h2>Close pairs (similar prompt candidates)</h2>
<p>Prompt groups whose wording overlaps by ${Math.round(SIMILAR_THRESHOLD * 100)}% or more, ignoring text shared by many groups. Highlighted words are the difference. Exact stacking keeps these apart.</p>
${renderPairs(groups, similar)}
<h2>Stacks (${stacks.length}), largest first</h2>
${stacks.map((group, index) => renderStack(group, index)).join("\n")}
<script>${PAGE_SCRIPT}</script>
</body></html>
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`${args.error}\n${usage()}`);
    process.exit(2);
  }
  const root = path.resolve(args.root);
  const out = path.resolve(args.out);
  if (isInside(REPOSITORY_ROOT, out)) {
    console.error(
      "Choose an --out path outside the Video Swarm repository, so the report can never be committed."
    );
    process.exit(2);
  }
  const started = Date.now();
  const files = [];
  for (const file of walk(root)) {
    if (files.length >= args.limit) break;
    files.push(file);
  }

  const probe = args.isoOnly ? null : createEmbeddedMetadataProbe();
  const clips = [];
  try {
    for (const [index, file] of files.entries()) {
      let stats = null;
      let read = { status: "unreadable", payload: null };
      try {
        stats = fs.statSync(file);
        read = await readPayload(file, probe, args.isoOnly);
      } catch {
        // Counted as unreadable.
      }
      clips.push(
        describeClip({
          relative: path.relative(root, file),
          file,
          size: stats?.size || 0,
          mtimeMs: stats?.mtimeMs || 0,
          read,
        })
      );
      if (process.stderr.isTTY && (index % 50 === 0 || index === files.length - 1)) {
        process.stderr.write(`\rreading ${index + 1}/${files.length}`);
      }
    }
  } finally {
    await probe?.shutdown?.();
  }
  if (process.stderr.isTTY) process.stderr.write("\n");

  const groups = groupByPrompt(clips);
  const similar = findSimilarGroups(groups);
  const summary = summarize(clips, groups, similar, Date.now() - started);
  fs.writeFileSync(out, renderReport({ groups, similar, summary }), {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(summary.join("\n"));
  console.log("\nReport written to the --out path. It contains your prompts and paths; open it yourself.");
}

if (require.main === module) {
  main().catch((error) => {
    // Only the error's code or name: its message or stack could carry a path.
    console.error(`prompt-stack-report failed: ${error?.code || error?.name || "error"}`);
    process.exit(1);
  });
}

module.exports = {
  CONTENT_SECURITY_POLICY,
  describeClip,
  findSimilarGroups,
  groupByPrompt,
  parseArgs,
  renderReport,
  summarize,
};
