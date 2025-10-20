import { useEffect } from "react";

function readHeight(element) {
  if (!element) return 0;
  const rect = typeof element.getBoundingClientRect === "function"
    ? element.getBoundingClientRect()
    : null;
  if (rect && Number.isFinite(rect.height) && rect.height > 0) {
    return rect.height;
  }
  const offsetHeight = Number(element.offsetHeight);
  if (Number.isFinite(offsetHeight) && offsetHeight > 0) return offsetHeight;
  const clientHeight = Number(element.clientHeight);
  if (Number.isFinite(clientHeight) && clientHeight > 0) return clientHeight;
  return 0;
}

export function useReportMeasuredHeight({
  id,
  elementRef,
  measurementStore,
  layoutEpoch,
}) {
  useEffect(() => {
    const element = elementRef?.current;
    if (!id || !measurementStore || !element) return undefined;

    const report = () => {
      const height = readHeight(element);
      if (!height || height <= 0) return;
      const columnValue = Number(element?.dataset?.column);
      const column = Number.isFinite(columnValue) ? columnValue : null;
      measurementStore.upsert(id, height, { column });
    };

    report();

    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(() => report());
      observer.observe(element);
      return () => observer.disconnect();
    }

    return undefined;
  }, [id, elementRef, measurementStore, layoutEpoch]);
}

export default useReportMeasuredHeight;
