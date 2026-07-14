const os = require("os");

const DETECTED_VIDEO_DECODE_STATES = new Set([
  "enabled",
  "enabled_on",
  "hardware_accelerated",
]);
const PLAYBACK_MODES = new Set([
  "balanced",
  "adaptive-motion",
  "all-motion",
  "static-hover",
]);

function normalizePlaybackMode(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return PLAYBACK_MODES.has(normalized) ? normalized : "balanced";
}

function normalizeVideoDecodeStatus(value) {
  const normalized = String(value ?? "unknown")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return normalized || "unknown";
}

function isHardwareDecodeDetected(status) {
  const normalized = normalizeVideoDecodeStatus(status);
  return (
    DETECTED_VIDEO_DECODE_STATES.has(normalized) ||
    normalized.startsWith("enabled_")
  );
}

function createPlaybackCapabilities({
  platform = process.platform,
  gpuFeatureStatus = {},
  logicalCores = os.cpus()?.length || 1,
  totalMemoryMB = Math.round(os.totalmem() / 1024 / 1024),
  proxyAvailable = true,
} = {}) {
  const videoDecodeStatus = normalizeVideoDecodeStatus(
    gpuFeatureStatus?.video_decode
  );

  return {
    platform,
    logicalCores: Math.max(1, Math.floor(Number(logicalCores) || 1)),
    totalMemoryMB: Math.max(0, Math.floor(Number(totalMemoryMB) || 0)),
    videoDecodeStatus,
    hardwareDecodeDetected: isHardwareDecodeDetected(videoDecodeStatus),
    hardwareDecodeGuaranteed: false,
    proxyAvailable: Boolean(proxyAvailable),
  };
}

module.exports = {
  createPlaybackCapabilities,
  isHardwareDecodeDetected,
  normalizePlaybackMode,
  normalizeVideoDecodeStatus,
};
