import { useEffect, useMemo, useRef } from "react";
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
  const enabledRef = useRef(enabled);

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

  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) {
      modelRef.current = null;
      return undefined;
    }

    modelRef.current = createLayoutProjectionModel(params);

    const unsubscribe = measurementStore?.subscribe?.((event) => {
      if (!enabledRef.current) return;
      if (event?.type === "measurement") {
        modelRef.current?.updateMeasurement(event.id, event.height);
      } else if (event?.type === "version") {
        modelRef.current?.reset?.();
      } else if (event?.type === "clear") {
        modelRef.current?.reset?.();
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [enabled, measurementStore, params]);

  const signatureRef = useRef(null);
  useEffect(() => {
    if (!enabledRef.current || !modelRef.current) return;
    const signature = buildSignature({ logicalOrder, columnCount, columnWidth, gapX, gapY });
    if (signatureRef.current === signature) return;
    signatureRef.current = signature;
    modelRef.current.reset();
  }, [logicalOrder, columnCount, columnWidth, gapX, gapY]);

  return modelRef.current;
}

export default useLayoutProjectionModel;
