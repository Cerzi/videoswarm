import { describe, it, expect } from "vitest";
import videoDimensions from "../videoDimensions";

const { __internals } = videoDimensions;

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
    const moovAtom = makeAtom("moov", trakAtom);

    const dims = parseMp4Moov(moovAtom.slice(8));
    expect(dims).toBeTruthy();
    expect(dims.width).toBeCloseTo(1280, 3);
    expect(dims.height).toBeCloseTo(720, 3);
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
    const tracks = makeEbmlElement(
      Buffer.from([0x16, 0x54, 0xae, 0x6b]),
      trackEntry
    );

    const dims = parseMatroska(tracks);
    expect(dims).toBeTruthy();
    expect(dims.width).toBe(1920);
    expect(dims.height).toBe(1080);
  });
});
