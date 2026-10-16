import path from "path";
import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  CONTENT_SECURITY_POLICY,
  describeClip,
  findSimilarGroups,
  groupByPrompt,
  parseArgs,
  renderReport,
  summarize,
} = require("./prompt-stack-report.cjs");

const NEGATIVE = "blurry, low quality, watermark, text overlay";

function prompt({ seed, text, steps = 20, media = null }) {
  const nodes = {
    3: { class_type: "KSampler", inputs: { seed, steps, positive: ["6", 0], negative: ["7", 0] } },
    6: { class_type: "CLIPTextEncode", inputs: { text } },
    7: { class_type: "CLIPTextEncode", inputs: { text: NEGATIVE } },
  };
  if (media) nodes[9] = { class_type: "LoadImage", inputs: { image: media } };
  return JSON.stringify(nodes);
}

let nextClip = 1;
function clip(name, payloadPrompt, status = "found") {
  const index = nextClip++;
  return describeClip({
    relative: path.join("secret-project", name),
    file: path.join(path.sep, "home", "someone", "secret-project", name),
    size: 1024 * index,
    mtimeMs: Date.UTC(2026, 0, index),
    read: { status, payload: payloadPrompt === null ? null : { prompt: payloadPrompt } },
  });
}

const NOON = "a red car driving through the desert at noon";
const DUSK = "a red car driving through the desert at dusk";
const STORM = "a lighthouse on a cliff in a storm";

function library() {
  return [
    clip("car_00001.mp4", prompt({ seed: 1, text: NOON })),
    clip("car_00002.mp4", prompt({ seed: 2, text: NOON })),
    clip("car_00001_final.mp4", prompt({ seed: 1, steps: 40, text: NOON })),
    clip("car_dusk.mp4", prompt({ seed: 5, text: DUSK })),
    clip("lighthouse.mp4", prompt({ seed: 9, text: STORM })),
    clip("plain.mp4", null, "not-found"),
    // A prompt with no seed has no key.
    clip("seedless.mp4", JSON.stringify({ 6: { class_type: "Encode", inputs: { text: STORM } } })),
    clip("locked.mp4", null, "unreadable"),
  ];
}

describe("prompt stack report", () => {
  it("requires a folder and an output path", () => {
    expect(parseArgs([]).error).toBeTruthy();
    expect(parseArgs(["/library"]).error).toBeTruthy();
    expect(parseArgs(["/library", "--out", "/tmp/r.html", "--limit", "0"]).error).toBeTruthy();
    expect(parseArgs(["/library", "--out", "/tmp/r.html", "--iso-only"])).toMatchObject({
      root: "/library",
      out: "/tmp/r.html",
      isoOnly: true,
    });
  });

  it("stacks runs of one prompt across seeds and nests their versions", () => {
    const clips = library();
    expect(clips.map((entry) => entry.outcome)).toEqual([
      "keyed",
      "keyed",
      "keyed",
      "keyed",
      "keyed",
      "no-prompt",
      "unkeyed",
      "unread",
    ]);
    const groups = groupByPrompt(clips);
    expect(groups.map((group) => group.clips.length)).toEqual([3, 1, 1]);
    expect(groups[0].generations.size).toBe(2);
    expect(groups[0].texts).toContain(NOON);
  });

  it("finds prompts a few words apart, ignoring shared boilerplate", () => {
    const groups = groupByPrompt(library());
    const similar = findSimilarGroups(groups);
    expect(similar.pairs).toHaveLength(1);
    const [pair] = similar.pairs;
    const texts = [groups[pair.a].texts, groups[pair.b].texts].flat();
    expect(texts).toEqual(expect.arrayContaining([NOON, DUSK]));
    expect(similar.groupsIfSimilarStacked).toBe(2);
  });

  it("never pairs prompts whose input media differ", () => {
    const clips = [
      clip("a.mp4", prompt({ seed: 1, text: NOON, media: "start-a.png" })),
      clip("b.mp4", prompt({ seed: 2, text: DUSK, media: "start-b.png" })),
    ];
    expect(findSimilarGroups(groupByPrompt(clips)).pairs).toEqual([]);
  });

  it("joins a group only to an anchor, so wording drift cannot chain", () => {
    const base = "one two three four five six seven eight nine ten";
    const drift1 = base.replace("ten", "eleven");
    const drift2 = drift1.replace("nine", "twelve");
    const clips = [
      clip("a1.mp4", prompt({ seed: 1, text: base })),
      clip("a2.mp4", prompt({ seed: 2, text: base })),
      clip("b.mp4", prompt({ seed: 3, text: drift1 })),
      clip("c.mp4", prompt({ seed: 4, text: drift2 })),
    ];
    const similar = findSimilarGroups(groupByPrompt(clips));
    // base~drift1 and drift1~drift2 are close, base and drift2 are not.
    expect(similar.pairs).toHaveLength(2);
    expect(similar.groupsIfSimilarStacked).toBe(2);
  });

  it("prints counts only: no prompt text, names, paths or keys", () => {
    const clips = library();
    const groups = groupByPrompt(clips);
    const output = summarize(clips, groups, findSimilarGroups(groups), 1234).join("\n");
    expect(output).toContain("clips found            8");
    expect(output).toContain("8 -> 6 stacked");
    const forbidden = [
      "red",
      "desert",
      "lighthouse",
      "blurry",
      "secret-project",
      "someone",
      "car_",
      ".mp4",
      "gk1-",
      "pk1-",
      ...groups.map((group) => group.promptKey.slice(4, 12)),
    ];
    for (const word of forbidden) expect(output).not.toContain(word);
    expect(output).toMatch(/^[\w\s().,:;%+\->/]*$/);
  });

  it("writes a locked-down report that escapes whatever a prompt or path holds", () => {
    const hostile = '<script>alert("x")</script> & a red car "quoted" driving fast';
    const clips = [
      clip('<img src=x onerror=alert(1)>.mp4', prompt({ seed: 1, text: hostile })),
      clip("second.mp4", prompt({ seed: 2, text: hostile })),
    ];
    const groups = groupByPrompt(clips);
    const similar = findSimilarGroups(groups);
    const html = renderReport({
      groups,
      similar,
      summary: summarize(clips, groups, similar, 0),
    });
    expect(html).toContain(`content="${CONTENT_SECURITY_POLICY}"`);
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; a red car");
    expect(html).not.toMatch(/https?:\/\//);
    // Previews are local file URLs, loaded only when scrolled into view.
    expect(html).toMatch(/data-src="file:\/\/[^"]+"/);
    expect(html).not.toMatch(/<video[^>]* src=/);
  });
});
