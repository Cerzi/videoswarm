import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createLayoutProjectionModel } from "./layoutProjectionModel";

function buildSignature({ logicalOrder, columnCount, columnWidth, gapX, gapY }) {
  const array = Array.isArray(logicalOrder) ? logicalOrder : [];
  const prefix = array.slice(0, 4);
  const suffix = array.slice(-4);
  return JSON.stringify({
    logicalLength: array.length,
    prefix,
    suffix,
    columnCount,
    columnWidth,
    gapX,
    gapY,
  });
}

export function useLayoutProjectionModel({
  enabled = false,
  logicalOrder = [],
  columnCount = 1,
  columnWidth = 200,
  gapX = 12,
  gapY = 12,
  measurementStore,
  defaultHeight,
} = {}) {
  const modelRef = useRef(null);
  const [model, setModel] = useState(null);
  const enabledRef = useRef(enabled);
  const pendingMeasurementsRef = useRef([]);
  const flushHandleRef = useRef({ type: null, id: null });

  const params = useMemo(
    () => ({
      logicalOrder,
      columnCount,
      columnWidth,
      gapX,
      gapY,
      measure: measurementStore,
      defaultHeight,
    }),
    [logicalOrder, columnCount, columnWidth, gapX, gapY, measurementStore, defaultHeight]
  );

  const cancelScheduledFlush = useCallback(() => {
    const handle = flushHandleRef.current;
    if (!handle || handle.id == null) return;
    if (handle.type === "raf") {
      if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(handle.id);
      }
    } else if (handle.type === "timeout") {
      clearTimeout(handle.id);
    }
    flushHandleRef.current = { type: null, id: null };
  }, []);

  const flushMeasurements = useCallback(() => {
    flushHandleRef.current = { type: null, id: null };
    if (!enabledRef.current) {
      pendingMeasurementsRef.current = [];
      return;
    }
    const instance = modelRef.current;
    if (!instance || typeof instance.applyMeasurements !== "function") {
      pendingMeasurementsRef.current = [];
      return;
    }
    const queue = pendingMeasurementsRef.current;
    if (!queue.length) return;
    const dedup = new Map();
    for (let i = 0; i < queue.length; i += 1) {
      const item = queue[i];
      if (!item || !item.id) continue;
      dedup.set(item.id, item);
    }
    pendingMeasurementsRef.current = [];
    if (!dedup.size) return;
    instance.applyMeasurements(Array.from(dedup.values()));
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushHandleRef.current.id != null) return;
    if (
      typeof window !== "undefined" &&
      typeof window.requestAnimationFrame === "function"
    ) {
      const id = window.requestAnimationFrame(() => {
        flushMeasurements();
      });
      flushHandleRef.current = { type: "raf", id };
      return;
    }
    const id = setTimeout(() => {
      flushMeasurements();
    }, 16);
    flushHandleRef.current = { type: "timeout", id };
  }, [flushMeasurements]);

  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) {
      modelRef.current = null;
      setModel(null);
      pendingMeasurementsRef.current = [];
      cancelScheduledFlush();
      return undefined;
    }

    const instance = createLayoutProjectionModel(params);
    modelRef.current = instance;
    setModel(instance);

    const unsubscribe = measurementStore?.subscribe?.((event) => {
      if (!enabledRef.current) return;
      if (event?.type === "measurement") {
        pendingMeasurementsRef.current.push({ id: event.id, height: event.height });
        if (pendingMeasurementsRef.current.length >= 256) {
          const queue = pendingMeasurementsRef.current.splice(0);
          const dedup = new Map();
          for (let i = 0; i < queue.length; i += 1) {
            const item = queue[i];
            if (!item || !item.id) continue;
            dedup.set(item.id, item);
          }
          if (dedup.size) {
            modelRef.current?.applyMeasurements?.(Array.from(dedup.values()));
          }
          cancelScheduledFlush();
        } else {
          scheduleFlush();
        }
      } else if (event?.type === "version") {
        modelRef.current?.reset?.();
        pendingMeasurementsRef.current = [];
        cancelScheduledFlush();
      } else if (event?.type === "clear") {
        modelRef.current?.reset?.();
        pendingMeasurementsRef.current = [];
        cancelScheduledFlush();
      }
    });

    return () => {
      unsubscribe?.();
      cancelScheduledFlush();
      pendingMeasurementsRef.current = [];
    };
  }, [enabled, measurementStore, params, cancelScheduledFlush, scheduleFlush]);

  const signatureRef = useRef(null);
  useEffect(() => {
    if (!enabledRef.current || !modelRef.current) return;
    const signature = buildSignature({ logicalOrder, columnCount, columnWidth, gapX, gapY });
    if (signatureRef.current === signature) return;
    signatureRef.current = signature;
    modelRef.current.reset();
  }, [logicalOrder, columnCount, columnWidth, gapX, gapY]);

  return model;
}

export default useLayoutProjectionModel;
