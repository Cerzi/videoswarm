const fs = require("fs");
const path = require("path");

const MP4_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".qt"]); // quicktime family

const MATROSKA_EXTENSIONS = new Set([".mkv", ".webm", ".mk3d", ".mka"]);

const CACHE = new Map();

function cacheKey(filePath, stats) {
  const size = stats?.size ?? 0;
  const mtimeMs = stats?.mtimeMs ?? 0;
  return `${filePath}::${size}::${mtimeMs}`;
}

function readFixed1616(buffer, offset) {
  if (offset + 4 > buffer.length) return null;
  const value = buffer.readInt32BE(offset);
  return value / 65536;
}

function nearlyEquals(value, target, tolerance = 1e-2) {
  return Math.abs(value - target) <= tolerance;
}

function detectRotationFromMatrix(matrix) {
  if (!matrix || matrix.length < 16) return 0;
  const a = readFixed1616(matrix, 0);
  const b = readFixed1616(matrix, 4);
  const c = readFixed1616(matrix, 8);
  const d = readFixed1616(matrix, 12);

  if ([a, b, c, d].some((v) => v === null)) {
    return 0;
  }

  if (nearlyEquals(a, 0) && nearlyEquals(b, 1) && nearlyEquals(c, -1) && nearlyEquals(d, 0)) {
    return 90;
  }
  if (nearlyEquals(a, 0) && nearlyEquals(b, -1) && nearlyEquals(c, 1) && nearlyEquals(d, 0)) {
    return 270;
  }
  if (nearlyEquals(a, -1) && nearlyEquals(b, 0) && nearlyEquals(c, 0) && nearlyEquals(d, -1)) {
    return 180;
  }
  return 0;
}

function parseTkhd(buffer) {
  if (!buffer || buffer.length < 84) return null;
  const version = buffer.readUInt8(0);
  const widthOffset = version === 1 ? 88 : 76;
  const matrixOffset = widthOffset - 36;

  if (buffer.length < widthOffset + 8 || matrixOffset < 0) {
    return null;
  }

  let width = readFixed1616(buffer, widthOffset);
  let height = readFixed1616(buffer, widthOffset + 4);

  if (!width || !height) {
    return null;
  }

  const rotation = detectRotationFromMatrix(buffer.slice(matrixOffset, matrixOffset + 16));
  if (rotation === 90 || rotation === 270) {
    [width, height] = [height, width];
  }

  return { width, height };
}

function readAtom(buffer, offset) {
  if (offset + 8 > buffer.length) return null;
  let size = buffer.readUInt32BE(offset);
  const type = buffer.toString("ascii", offset + 4, offset + 8);
  let headerSize = 8;

  if (size === 1) {
    if (offset + 16 > buffer.length) return null;
    const high = buffer.readUInt32BE(offset + 8);
    const low = buffer.readUInt32BE(offset + 12);
    size = Number((BigInt(high) << 32n) | BigInt(low));
    headerSize = 16;
  } else if (size === 0) {
    size = buffer.length - offset;
  }

  if (size < headerSize || offset + size > buffer.length) {
    return null;
  }

  return {
    type,
    size,
    headerSize,
    start: offset,
    end: offset + size,
    data: buffer.slice(offset + headerSize, offset + size),
  };
}

function findAtom(buffer, type) {
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const atom = readAtom(buffer, offset);
    if (!atom) break;
    if (atom.type === type) return atom;
    offset = atom.end;
  }
  return null;
}

function parseMp4Moov(buffer) {
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const atom = readAtom(buffer, offset);
    if (!atom) break;
    if (atom.type === "trak") {
      const handler = findAtom(atom.data, "mdia");
      let isVideoTrack = false;
      if (handler) {
        const hdlr = findAtom(handler.data, "hdlr");
        if (hdlr && hdlr.data.length >= 12) {
          const handlerType = hdlr.data.toString("ascii", 8, 12);
          isVideoTrack = handlerType === "vide";
        }
      }
      const tkhdAtom = findAtom(atom.data, "tkhd");
      if (tkhdAtom) {
        const dims = parseTkhd(tkhdAtom.data);
        if (dims && dims.width > 0 && dims.height > 0) {
          if (isVideoTrack) return dims;
          if (!isVideoTrack && !dims.guess) {
            return dims;
          }
        }
      }
    }
    offset = atom.end;
  }
  return null;
}

async function extractMp4Dimensions(filePath) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const chunkSize = 512 * 1024; // 512KB
    const maxRead = 8 * 1024 * 1024; // 8MB cap
    const moovToken = Buffer.from("moov");
    let buffer = Buffer.alloc(0);
    let bytesReadTotal = 0;

    while (bytesReadTotal < maxRead) {
      const chunk = Buffer.alloc(chunkSize);
      const { bytesRead } = await handle.read(chunk, 0, chunkSize, bytesReadTotal);
      if (!bytesRead) break;
      bytesReadTotal += bytesRead;
      buffer = Buffer.concat([buffer, chunk.slice(0, bytesRead)]);

      let searchIndex = 0;
      while (true) {
        const idx = buffer.indexOf(moovToken, searchIndex);
        if (idx === -1) break;
        if (idx < 4) {
          searchIndex = idx + 1;
          continue;
        }
        const start = idx - 4;
        const atomSize = buffer.readUInt32BE(start);
        if (atomSize <= 0) {
          searchIndex = idx + 1;
          continue;
        }
        if (buffer.length < start + atomSize) {
          // Need more data
          break;
        }
        const moovBuffer = buffer.slice(start + 8, start + atomSize);
        const dims = parseMp4Moov(moovBuffer);
        if (dims && dims.width > 0 && dims.height > 0) {
          return dims;
        }
        searchIndex = idx + 1;
      }

      if (buffer.length > 4 * chunkSize) {
        buffer = buffer.slice(buffer.length - 4 * chunkSize);
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

function decodeVint(buffer, offset) {
  if (offset >= buffer.length) return null;
  const firstByte = buffer[offset];
  let mask = 0x80;
  let length = 1;
  while (length <= 8 && (firstByte & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8 || offset + length > buffer.length) return null;
  let value = firstByte & (mask - 1);
  for (let i = 1; i < length; i++) {
    value = (value << 8) + buffer[offset + i];
  }
  return { length, value };
}

function parseMatroska(buffer) {
  let offset = 0;
  const TRACKS_ID = Buffer.from([0x16, 0x54, 0xae, 0x6b]);
  const TRACK_ENTRY_ID = Buffer.from([0xae]);
  const VIDEO_ID = Buffer.from([0xe0]);
  const PIXEL_WIDTH_ID = Buffer.from([0xb0]);
  const PIXEL_HEIGHT_ID = Buffer.from([0xba]);

  while (offset < buffer.length) {
    const idInfo = decodeVint(buffer, offset);
    if (!idInfo) break;
    const idBytes = buffer.slice(offset, offset + idInfo.length);
    offset += idInfo.length;

    const sizeInfo = decodeVint(buffer, offset);
    if (!sizeInfo) break;
    offset += sizeInfo.length;
    const dataSize = sizeInfo.value;

    if (offset + dataSize > buffer.length) break;

    if (idBytes.equals(TRACKS_ID)) {
      const tracksBuffer = buffer.slice(offset, offset + dataSize);
      let tracksOffset = 0;
      while (tracksOffset < tracksBuffer.length) {
        const trackIdInfo = decodeVint(tracksBuffer, tracksOffset);
        if (!trackIdInfo) break;
        const trackIdBytes = tracksBuffer.slice(tracksOffset, tracksOffset + trackIdInfo.length);
        tracksOffset += trackIdInfo.length;

        const trackSizeInfo = decodeVint(tracksBuffer, tracksOffset);
        if (!trackSizeInfo) break;
        tracksOffset += trackSizeInfo.length;
        const trackSize = trackSizeInfo.value;

        if (!trackIdBytes.equals(TRACK_ENTRY_ID)) {
          tracksOffset += trackSize;
          continue;
        }

        const trackBuffer = tracksBuffer.slice(tracksOffset, tracksOffset + trackSize);
        tracksOffset += trackSize;

        let trackBufferOffset = 0;
        let width = null;
        let height = null;
        let isVideo = false;

        while (trackBufferOffset < trackBuffer.length) {
          const elementIdInfo = decodeVint(trackBuffer, trackBufferOffset);
          if (!elementIdInfo) break;
          const elementIdBytes = trackBuffer.slice(
            trackBufferOffset,
            trackBufferOffset + elementIdInfo.length
          );
          trackBufferOffset += elementIdInfo.length;

          const elementSizeInfo = decodeVint(trackBuffer, trackBufferOffset);
          if (!elementSizeInfo) break;
          trackBufferOffset += elementSizeInfo.length;
          const elementSize = elementSizeInfo.value;

          if (trackBufferOffset + elementSize > trackBuffer.length) break;

          if (elementIdBytes.equals(Buffer.from([0x83]))) {
            // Track Type
            const trackType = trackBuffer.readUInt8(trackBufferOffset);
            if (trackType === 1) {
              isVideo = true;
            }
          } else if (elementIdBytes.equals(VIDEO_ID)) {
            let videoOffset = trackBufferOffset;
            const videoBuffer = trackBuffer.slice(videoOffset, videoOffset + elementSize);
            let innerOffset = 0;
            while (innerOffset < videoBuffer.length) {
              const innerIdInfo = decodeVint(videoBuffer, innerOffset);
              if (!innerIdInfo) break;
              const innerIdBytes = videoBuffer.slice(
                innerOffset,
                innerOffset + innerIdInfo.length
              );
              innerOffset += innerIdInfo.length;

              const innerSizeInfo = decodeVint(videoBuffer, innerOffset);
              if (!innerSizeInfo) break;
              innerOffset += innerSizeInfo.length;
              const innerSize = innerSizeInfo.value;

              if (innerOffset + innerSize > videoBuffer.length) break;

              if (innerIdBytes.equals(PIXEL_WIDTH_ID)) {
                width = 0;
                for (let i = 0; i < innerSize; i++) {
                  width = (width << 8) + videoBuffer[innerOffset + i];
                }
              } else if (innerIdBytes.equals(PIXEL_HEIGHT_ID)) {
                height = 0;
                for (let i = 0; i < innerSize; i++) {
                  height = (height << 8) + videoBuffer[innerOffset + i];
                }
              }
              innerOffset += innerSize;
            }
          }

          trackBufferOffset += elementSize;
        }

        if (isVideo && width && height) {
          return { width, height };
        }
      }
    }

    offset += dataSize;
  }

  return null;
}

async function extractMatroskaDimensions(filePath) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const chunkSize = 512 * 1024;
    const maxRead = 8 * 1024 * 1024;
    let buffer = Buffer.alloc(0);
    let bytesReadTotal = 0;

    while (bytesReadTotal < maxRead) {
      const chunk = Buffer.alloc(chunkSize);
      const { bytesRead } = await handle.read(chunk, 0, chunkSize, bytesReadTotal);
      if (!bytesRead) break;
      bytesReadTotal += bytesRead;
      buffer = Buffer.concat([buffer, chunk.slice(0, bytesRead)]);

      const dims = parseMatroska(buffer);
      if (dims && dims.width > 0 && dims.height > 0) {
        return dims;
      }

      if (buffer.length > maxRead) {
        buffer = buffer.slice(buffer.length - maxRead);
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function getVideoDimensions(filePath, stats = null) {
  const key = cacheKey(filePath, stats);
  if (CACHE.has(key)) {
    return CACHE.get(key);
  }

  const ext = path.extname(filePath).toLowerCase();
  let dims = null;

  try {
    if (MP4_EXTENSIONS.has(ext)) {
      dims = await extractMp4Dimensions(filePath);
    } else if (MATROSKA_EXTENSIONS.has(ext)) {
      dims = await extractMatroskaDimensions(filePath);
    }
  } catch (error) {
    console.warn(`[dimensions] Failed to parse ${filePath}:`, error.message || error);
    dims = null;
  }

  if (dims && dims.width > 0 && dims.height > 0) {
    dims = {
      width: Math.round(dims.width),
      height: Math.round(dims.height),
      aspectRatio: dims.width / dims.height,
    };
  } else {
    dims = null;
  }

  CACHE.set(key, dims);
  return dims;
}

module.exports = {
  getVideoDimensions,
  __internals: {
    parseTkhd,
    detectRotationFromMatrix,
    parseMp4Moov,
    parseMatroska,
  },
};
