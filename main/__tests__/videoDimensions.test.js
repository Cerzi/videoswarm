import fs from "fs";
import { afterEach, describe, it, expect, vi } from "vitest";
import videoDimensions from "../videoDimensions";

const {
  VIDEO_DIMENSIONS_CACHE_MAX_ENTRIES,
  VIDEO_DIMENSIONS_CACHE_MAX_IN_FLIGHT,
  __internals,
  clearVideoDimensionsCache,
  getVideoDimensions,
  getVideoDimensionsCacheSnapshot,
} = videoDimensions;

const {
  parseTkhd,
  parseMp4Moov,
  parseMatroska,
} = __internals;

function makeAtom(type, data) {
  const size = 8 + data.length;
  const buffer = Buffer.alloc(size);
  buffer.writeUInt32BE(size, 0);
  buffer.write(type, 4, 4, "ascii");
  data.copy(buffer, 8);
  return buffer;
}

function makeTkhdData({ width, height, rotation = 0 }) {
  const data = Buffer.alloc(92);
  data.writeUInt8(0, 0); // version
  const widthFixed = Math.round(width * 65536);
  const heightFixed = Math.round(height * 65536);
  const widthOffset = 76;
  const heightOffset = 80;
  const matrixOffset = 40;

  // identity matrix
  const matrixValues = {
    a: 1,
    b: 0,
    c: 0,
    d: 1,
  };

  if (rotation === 90) {
    matrixValues.a = 0;
    matrixValues.b = 1;
    matrixValues.c = -1;
    matrixValues.d = 0;
  } else if (rotation === 270) {
    matrixValues.a = 0;
    matrixValues.b = -1;
    matrixValues.c = 1;
    matrixValues.d = 0;
  } else if (rotation === 180) {
    matrixValues.a = -1;
    matrixValues.b = 0;
    matrixValues.c = 0;
    matrixValues.d = -1;
  }

  data.writeInt32BE(Math.round(matrixValues.a * 65536), matrixOffset + 0);
  data.writeInt32BE(Math.round(matrixValues.b * 65536), matrixOffset + 4);
  data.writeInt32BE(Math.round(matrixValues.c * 65536), matrixOffset + 8);
  data.writeInt32BE(Math.round(matrixValues.d * 65536), matrixOffset + 12);

  data.writeUInt32BE(widthFixed, widthOffset);
  data.writeUInt32BE(heightFixed, heightOffset);
  return data;
}

function encodeVint(value) {
  if (value < 0x7f) {
    return Buffer.from([0x80 | value]);
  }
  if (value < 0x3fff) {
    const high = 0x40 | ((value >> 8) & 0x3f);
    const low = value & 0xff;
    return Buffer.from([high, low]);
  }
  throw new Error("encodeVint only supports values < 0x3fff in tests");
}

function makeEbmlElement(idBytes, payload) {
  const sizeBytes = encodeVint(payload.length);
  return Buffer.concat([idBytes, sizeBytes, payload]);
}

describe("videoDimensions internals", () => {
  afterEach(() => {
    clearVideoDimensionsCache();
    vi.restoreAllMocks();
  });

  it("extracts width/height from tkhd without rotation", () => {
    const data = makeTkhdData({ width: 1920, height: 1080 });
    const dims = parseTkhd(data);
    expect(dims).toBeTruthy();
    expect(dims.width).toBeCloseTo(1920, 3);
    expect(dims.height).toBeCloseTo(1080, 3);
  });

  it("swaps width/height when rotation matrix indicates 90°", () => {
    const data = makeTkhdData({ width: 1080, height: 1920, rotation: 90 });
    const dims = parseTkhd(data);
    expect(dims).toBeTruthy();
    expect(dims.width).toBeCloseTo(1920, 3);
    expect(dims.height).toBeCloseTo(1080, 3);
  });

  it("parses moov/trak structure for mp4", () => {
    const tkhdData = makeTkhdData({ width: 1280, height: 720 });
    const tkhdAtom = makeAtom("tkhd", tkhdData);

    const hdlrData = Buffer.alloc(24);
    hdlrData.writeUInt8(0, 0); // version
    hdlrData.writeUInt8(0, 1);
    hdlrData.writeUInt8(0, 2);
    hdlrData.writeUInt8(1, 3); // flags (set handler to media)
    hdlrData.writeUInt32BE(0, 4); // pre_defined
    hdlrData.write("vide", 8, 4, "ascii");
    const hdlrAtom = makeAtom("hdlr", hdlrData);
    const mdiaAtom = makeAtom("mdia", hdlrAtom);

    const trakAtom = makeAtom("trak", Buffer.concat([tkhdAtom, mdiaAtom]));
    const audioHandlerData = Buffer.alloc(24);
    audioHandlerData.write("soun", 8, 4, "ascii");
    const audioTrack = makeAtom(
      "trak",
      makeAtom("mdia", makeAtom("hdlr", audioHandlerData))
    );
    const moovAtom = makeAtom("moov", Buffer.concat([trakAtom, audioTrack]));

    const dims = parseMp4Moov(moovAtom.slice(8));
    expect(dims).toBeTruthy();
    expect(dims.width).toBeCloseTo(1280, 3);
    expect(dims.height).toBeCloseTo(720, 3);
    expect(dims.hasAudio).toBe(true);
  });

  it("parses matroska track entry pixel dimensions", () => {
    const pixelWidth = makeEbmlElement(Buffer.from([0xb0]), Buffer.from([0x07, 0x80])); // 1920
    const pixelHeight = makeEbmlElement(Buffer.from([0xba]), Buffer.from([0x04, 0x38])); // 1080
    const video = makeEbmlElement(Buffer.from([0xe0]), Buffer.concat([pixelWidth, pixelHeight]));
    const trackType = makeEbmlElement(Buffer.from([0x83]), Buffer.from([0x01]));
    const trackEntry = makeEbmlElement(
      Buffer.from([0xae]),
      Buffer.concat([trackType, video])
    );
    const audioTrack = makeEbmlElement(
      Buffer.from([0xae]),
      makeEbmlElement(Buffer.from([0x83]), Buffer.from([0x02]))
    );
    const tracks = makeEbmlElement(
      Buffer.from([0x16, 0x54, 0xae, 0x6b]),
      Buffer.concat([trackEntry, audioTrack])
    );

    const dims = parseMatroska(tracks);
    expect(dims).toBeTruthy();
    expect(dims.width).toBe(1920);
    expect(dims.height).toBe(1080);
    expect(dims.hasAudio).toBe(true);
  });

  it("stats before forming a key when callers omit file stats", async () => {
    const stat = vi
      .spyOn(fs.promises, "stat")
      .mockResolvedValueOnce({ size: 10, mtimeMs: 100 })
      .mockResolvedValueOnce({ size: 20, mtimeMs: 200 });

    await expect(getVideoDimensions("/virtual/clip.avi")).resolves.toBeNull();
    await expect(getVideoDimensions("/virtual/clip.avi")).resolves.toBeNull();

    expect(stat).toHaveBeenCalledTimes(2);
    expect(getVideoDimensionsCacheSnapshot()).toMatchObject({
      entries: 2,
      inFlight: 0,
      maxEntries: VIDEO_DIMENSIONS_CACHE_MAX_ENTRIES,
      maxInFlight: VIDEO_DIMENSIONS_CACHE_MAX_IN_FLIGHT,
    });
  });

  it("seeks over a large MP4 media atom to read tail metadata", async () => {
    const tkhdAtom = makeAtom(
      "tkhd",
      makeTkhdData({ width: 1024, height: 576 })
    );
    const videoHandler = Buffer.alloc(24);
    videoHandler.write("vide", 8, 4, "ascii");
    const videoTrack = makeAtom(
      "trak",
      Buffer.concat([
        tkhdAtom,
        makeAtom("mdia", makeAtom("hdlr", videoHandler)),
      ])
    );
    const audioHandler = Buffer.alloc(24);
    audioHandler.write("soun", 8, 4, "ascii");
    const audioTrack = makeAtom(
      "trak",
      makeAtom("mdia", makeAtom("hdlr", audioHandler))
    );
    const moov = makeAtom("moov", Buffer.concat([videoTrack, audioTrack]));
    const mediaAtomSize = 512 * 1024;
    const file = Buffer.alloc(8 + mediaAtomSize + moov.length);
    file.writeUInt32BE(8, 0);
    file.write("ftyp", 4, 4, "ascii");
    file.writeUInt32BE(mediaAtomSize, 8);
    file.write("mdat", 12, 4, "ascii");
    moov.copy(file, 8 + mediaAtomSize);

    const read = vi.fn(async (target, offset, length, position) => {
      const available = Math.max(0, Math.min(length, file.length - position));
      if (available > 0) file.copy(target, offset, position, position + available);
      return { bytesRead: available };
    });
    const close = vi.fn(async () => {});
    vi.spyOn(fs.promises, "open").mockResolvedValue({ read, close });

    await expect(
      getVideoDimensions("/virtual/tail.mp4", {
        size: file.length,
        mtimeMs: 9876,
      })
    ).resolves.toMatchObject({
      width: 1024,
      height: 576,
      hasAudio: true,
    });
    expect(
      read.mock.calls.reduce((total, call) => total + Number(call[2] || 0), 0)
    ).toBeLessThan(2048);
    expect(close).toHaveBeenCalledOnce();
  });

  it("deduplicates active parsing and exposes deterministic cache reset", async () => {
    const read = vi.fn(async () => ({ bytesRead: 0 }));
    const close = vi.fn(async () => {});
    const open = vi
      .spyOn(fs.promises, "open")
      .mockResolvedValue({ read, close });
    const stats = { size: 64, mtimeMs: 1234 };

    const [first, second] = await Promise.all([
      getVideoDimensions("/virtual/shared.mp4", stats),
      getVideoDimensions("/virtual/shared.mp4", stats),
    ]);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(getVideoDimensionsCacheSnapshot()).toMatchObject({
      entries: 1,
      inFlight: 0,
      maxEntries: VIDEO_DIMENSIONS_CACHE_MAX_ENTRIES,
      maxInFlight: VIDEO_DIMENSIONS_CACHE_MAX_IN_FLIGHT,
    });

    clearVideoDimensionsCache();
    expect(getVideoDimensionsCacheSnapshot()).toMatchObject({
      entries: 0,
      inFlight: 0,
    });
  });
});
