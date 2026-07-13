import { useEffect, useMemo, useState } from "react";

const fallbackCapabilities = () => ({
  platform: window.electronAPI?.platform || "unknown",
  logicalCores: Math.max(1, Number(navigator.hardwareConcurrency) || 1),
  totalMemoryMB: 0,
  videoDecodeStatus: "unknown",
  hardwareDecodeDetected: false,
  hardwareDecodeGuaranteed: false,
  proxyAvailable: true,
});

export function describeDecodeCapability(capabilities) {
  if (capabilities?.platform !== "linux") {
    return capabilities?.hardwareDecodeDetected
      ? "Chromium reports accelerated video decode; actual use is not guaranteed."
      : "Video decode acceleration is not reported by Chromium.";
  }

  return capabilities?.hardwareDecodeDetected
    ? "Linux: Chromium reports video decode enabled; hardware acceleration is detected, not guaranteed."
    : "Linux: hardware video decode was not detected; software decoding is likely.";
}

export default function usePlaybackCapabilities() {
  const [capabilities, setCapabilities] = useState(fallbackCapabilities);

  useEffect(() => {
    let alive = true;
    const request = window.electronAPI?.playback?.getCapabilities?.();
    if (!request?.then) return () => {
      alive = false;
    };

    request
      .then((value) => {
        if (!alive || !value || typeof value !== "object") return;
        setCapabilities((previous) => ({ ...previous, ...value }));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const statusText = useMemo(
    () => describeDecodeCapability(capabilities),
    [capabilities]
  );

  return { capabilities, statusText };
}
