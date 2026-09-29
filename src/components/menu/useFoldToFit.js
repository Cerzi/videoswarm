import { useCallback, useEffect, useLayoutEffect, useState } from "react";

// Keeps a one-row bar on one row: while its children are wider than the bar,
// the next key in `order` is folded (the bar then renders that control in its
// ⋯ menu, or a shorter form of it). A wider window unfolds everything and
// lets the pass fold again from the start. Used by the top bar and the
// review bar (UX redesign D6).
//
//   order        keys, folded first to last
//   foldable     { key: boolean } — keys that currently exist to be folded
//   isSqueezed   optional (bar) => boolean: overflow the widths cannot show,
//                such as a label shrunk below its readable minimum
export default function useFoldToFit(
  barRef,
  { order, foldable = {}, initialFolded = [], isSqueezed = null }
) {
  const [folded, setFolded] = useState(initialFolded);

  // Measured from the children, not the bar's scroll width, so an open menu
  // hanging below the bar never counts.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || !bar.clientWidth) return;
    const style = window.getComputedStyle(bar);
    const gap = parseFloat(style.columnGap || style.gap) || 0;
    const children = [...bar.children].filter(
      (child) => window.getComputedStyle(child).position !== "absolute"
    );
    const needed =
      children.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0) +
      gap * Math.max(0, children.length - 1) +
      (parseFloat(style.paddingLeft) || 0) +
      (parseFloat(style.paddingRight) || 0);
    if (needed <= bar.clientWidth + 1 && !(isSqueezed && isSqueezed(bar))) return;
    const next = order.find((key) => foldable[key] !== false && !folded.includes(key));
    if (next) setFolded((previous) => [...previous, next]);
  });

  useEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === "undefined") return undefined;
    let lastWidth = bar.clientWidth;
    const observer = new ResizeObserver(() => {
      const width = bar.clientWidth;
      if (width > lastWidth + 1) setFolded([]);
      lastWidth = width;
    });
    observer.observe(bar);
    return () => observer.disconnect();
  }, [barRef]);

  const isFolded = useCallback((key) => folded.includes(key), [folded]);
  return { folded, isFolded };
}
