import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  isIsoBmffPath,
  parseMoovTags,
  readIsoBmffEmbeddedPayload,
} = require("../container-tags");

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-tags-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function box(type, ...payloads) {
  const typeBytes = Buffer.isBuffer(type) ? type : Buffer.from(type, "latin1");
  const body = Buffer.concat(payloads);
  return Buffer.concat([uint32(8 + body.length), typeBytes, body]);
}

function dataBox(value, typeIndicator = 1) {
  return box("data", uint32(typeIndicator), uint32(0), Buffer.from(value, "utf8"));
}

function mdtaMeta(entries, { fullBox = true } = {}) {
  const keyEntries = entries.map(([name]) => {
    const nameBytes = Buffer.from(name, "utf8");
    return Buffer.concat([uint32(8 + nameBytes.length), Buffer.from("mdta"), nameBytes]);
  });
  const keys = box("keys", uint32(0), uint32(entries.length), ...keyEntries);
  const items = entries.map(([, value, typeIndicator], index) =>
    box(uint32(index + 1), dataBox(value, typeIndicator))
  );
  const hdlr = box("hdlr", Buffer.alloc(8), Buffer.from("mdta"), Buffer.alloc(13));
  return box("meta", ...(fullBox ? [uint32(0)] : []), hdlr, keys, box("ilst", ...items));
}

function mp4({ moovChildren, moovFirst = true, mdatBytes = 4096 }) {
  const ftyp = box("ftyp", Buffer.from("isom"), uint32(512), Buffer.from("isomiso2"));
  const moov = box("moov", box("mvhd", Buffer.alloc(100)), ...moovChildren);
  const mdat = box("mdat", Buffer.alloc(mdatBytes, 7));
  return Buffer.concat(moovFirst ? [ftyp, moov, mdat] : [ftyp, mdat, moov]);
}

async function readBuffer(buffer, { name = "clip.mp4", expected } = {}) {
  const filePath = path.join(temporaryDirectory(), name);
  fs.writeFileSync(filePath, buffer);
  const stats = fs.statSync(filePath);
  return readIsoBmffEmbeddedPayload(
    filePath,
    expected || { size: stats.size, mtimeMs: stats.mtimeMs }
  );
}

const PROMPT = '{"1":{"inputs":{"seed":1,"text":"four words of text"}}}';

describe("readIsoBmffEmbeddedPayload", () => {
  it("reads an mdta prompt tag and skips the workflow", async () => {
    const result = await readBuffer(
      mp4({
        moovChildren: [
          box("udta", mdtaMeta([["workflow", '{"nodes":[]}'], ["prompt", PROMPT], ["encoder", "x"]])),
        ],
      })
    );
    expect(result).toEqual({ status: "found", payload: { prompt: PROMPT } });
  });

  it("finds moov after a large mdat", async () => {
    const result = await readBuffer(
      mp4({
        moovFirst: false,
        mdatBytes: 1024 * 1024,
        moovChildren: [box("udta", mdtaMeta([["prompt", PROMPT]]))],
      })
    );
    expect(result.payload).toEqual({ prompt: PROMPT });
  });

  it("unwraps a VHS comment envelope in a ©cmt item or QuickTime text atom", async () => {
    const envelope = JSON.stringify({ prompt: PROMPT, workflow: "{}" });
    const cmt = Buffer.from([0xa9, 0x63, 0x6d, 0x74]);
    const hdlr = box("hdlr", Buffer.alloc(8), Buffer.from("mdir"), Buffer.alloc(13));
    const ilstStyle = await readBuffer(
      mp4({
        moovChildren: [
          box("udta", box("meta", uint32(0), hdlr, box("ilst", box(cmt, dataBox(envelope))))),
        ],
      })
    );
    expect(ilstStyle.payload.prompt).toBe(PROMPT);

    const text = Buffer.from(envelope, "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt16BE(text.length, 0);
    const quickTime = await readBuffer(
      mp4({ moovChildren: [box("udta", box(cmt, header, text))] }),
      { name: "clip.mov" }
    );
    expect(quickTime.payload.prompt).toBe(PROMPT);
  });

  it("prefers a direct prompt tag over a comment envelope", async () => {
    const envelope = JSON.stringify({ prompt: '{"other":1}' });
    const result = await readBuffer(
      mp4({
        moovChildren: [box("udta", mdtaMeta([["comment", envelope], ["prompt", PROMPT]]))],
      })
    );
    expect(result.payload.prompt).toBe(PROMPT);
  });

  it("accepts QuickTime meta without the full-box header and moov-level meta", async () => {
    const quickTime = await readBuffer(
      mp4({ moovChildren: [box("udta", mdtaMeta([["prompt", PROMPT]], { fullBox: false }))] })
    );
    expect(quickTime.payload.prompt).toBe(PROMPT);
    const moovLevel = await readBuffer(mp4({ moovChildren: [mdtaMeta([["prompt", PROMPT]])] }));
    expect(moovLevel.payload.prompt).toBe(PROMPT);
  });

  it("reports not-found for missing tags, non-UTF-8 items and non-ISO files", async () => {
    expect((await readBuffer(mp4({ moovChildren: [] }))).status).toBe("not-found");
    expect(
      (await readBuffer(mp4({ moovChildren: [box("udta", mdtaMeta([["prompt", PROMPT, 13]]))] })))
        .status
    ).toBe("not-found");
    expect((await readBuffer(Buffer.from("not a container at all"))).status).toBe("not-found");
    expect((await readBuffer(Buffer.alloc(0))).status).toBe("not-found");
  });

  it("survives truncated and self-inconsistent boxes without throwing", async () => {
    const valid = mp4({ moovChildren: [box("udta", mdtaMeta([["prompt", PROMPT]]))] });
    for (const length of [9, 40, 60, 120, valid.length - 5]) {
      const result = await readBuffer(valid.subarray(0, length));
      expect(["not-found", "found"]).toContain(result.status);
    }
    const lying = Buffer.from(valid);
    lying.writeUInt32BE(0xffffff00, 32 + 8 + 108 + 8);
    expect(["not-found", "found"]).toContain((await readBuffer(lying)).status);
    const badKeyCount = mp4({
      moovChildren: [box("udta", box("meta", uint32(0), box("keys", uint32(0), uint32(1e6))))],
    });
    expect((await readBuffer(badKeyCount)).status).toBe("not-found");
  });

  it("refuses to read beyond the moov bound", async () => {
    const huge = mp4({
      moovChildren: [box("free", Buffer.alloc(8 * 1024 * 1024 + 16)), box("udta", mdtaMeta([["prompt", PROMPT]]))],
    });
    expect((await readBuffer(huge)).status).toBe("not-found");
  });

  it("reports a changed file instead of reading it", async () => {
    const buffer = mp4({ moovChildren: [box("udta", mdtaMeta([["prompt", PROMPT]]))] });
    const result = await readBuffer(buffer, { expected: { size: buffer.length + 1, mtimeMs: 0 } });
    expect(result).toEqual({ status: "changed" });
  });

  it("treats missing files, directories and symbolic links as unreadable", async () => {
    const directory = temporaryDirectory();
    expect((await readIsoBmffEmbeddedPayload(path.join(directory, "gone.mp4"))).status).toBe(
      "unreadable"
    );
    expect((await readIsoBmffEmbeddedPayload(directory)).status).toBe("unreadable");
    if (process.platform !== "win32") {
      const target = path.join(directory, "real.mp4");
      fs.writeFileSync(target, mp4({ moovChildren: [box("udta", mdtaMeta([["prompt", PROMPT]]))] }));
      const link = path.join(directory, "link.mp4");
      fs.symlinkSync(target, link);
      expect((await readIsoBmffEmbeddedPayload(link)).status).toBe("unreadable");
    }
  });

  it("parses moov payloads directly with bounded iteration", () => {
    const moov = box("udta", mdtaMeta([["prompt", PROMPT]]));
    expect(parseMoovTags(moov, { maxBoxesPerLevel: 16, maxKeys: 4, maxValueBytes: 1024, maxTotalValueBytes: 1024 }))
      .toEqual({ prompt: PROMPT });
    expect(parseMoovTags(moov, { maxBoxesPerLevel: 16, maxKeys: 4, maxValueBytes: 8, maxTotalValueBytes: 1024 }))
      .toEqual({});
  });

  it("recognizes ISO-BMFF extensions only", () => {
    expect(isIsoBmffPath("/a/b.MP4")).toBe(true);
    expect(isIsoBmffPath("/a/b.mov")).toBe(true);
    expect(isIsoBmffPath("/a/b.webm")).toBe(false);
    expect(isIsoBmffPath(null)).toBe(false);
  });
});
