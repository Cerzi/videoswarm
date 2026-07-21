import React, {
  useMemo,
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  forwardRef,
} from "react";
import {
  clampFloatingPanelPosition,
  computeFloatingPanelPosition,
  isNarrowFloatingPanel,
} from "../utils/floatingPanelPosition";
import {
  deriveMetadataSelectionCount,
  deriveMetadataSelectionKey,
  deriveSingleSelectionInfo,
} from "./metadata/metadataContent";
import MetadataInspectorContent from "./metadata/MetadataInspectorContent";
import { DockPanelIcon, FocusSelectionIcon } from "./UiIcons";
import "./MetadataPanel.css";

const PANEL_MARGIN = 12;
const PANEL_GAP = 12;
const NARROW_BREAKPOINT = 680;
const MIN_PANEL_WIDTH = 340;
const MAX_PANEL_WIDTH = 430;

const finiteNumber = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const rectFrom = (rect) => {
  if (!rect) return null;
  const left = finiteNumber(rect.left, finiteNumber(rect.x));
  const top = finiteNumber(rect.top, finiteNumber(rect.y));
  const right = Number.isFinite(Number(rect.right))
    ? Number(rect.right)
    : left + Math.max(0, finiteNumber(rect.width));
  const bottom = Number.isFinite(Number(rect.bottom))
    ? Number(rect.bottom)
    : top + Math.max(0, finiteNumber(rect.height));
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
};

const samePosition = (first, second) =>
  first?.x === second?.x &&
  first?.y === second?.y &&
  first?.sheet === second?.sheet &&
  first?.width === second?.width &&
  first?.maxHeight === second?.maxHeight &&
  first?.side === second?.side &&
  first?.ready === second?.ready;

const MetadataPanel = forwardRef((
  {
    isOpen,
    onClose,
    selectionCount,
    selectedVideos = [],
    availableTags = [],
    onAddTag,
    onRemoveTag,
    onApplyTagToSelection,
    onSetRating,
    onClearRating,
    onSetReviewState,
    reviewModeEnabled = true,
    suggestionLimit,
    generationMetadataState = null,
    generationExpanded,
    onGenerationExpandedChange,
    focusToken,
    onFocusSelection,
    onDock,
    selectionKey,
    anchorId,
    resolveAnchorRect,
    resolveBoundsRect,
    resolveContainerRect,
    placementRequest = null,
    boundsVersion,
  },
  ref
) => {
  const [panelLayout, setPanelLayout] = useState({
    x: 0,
    y: 0,
    side: "fallback",
    sheet: false,
    width: 400,
    maxHeight: 520,
    ready: false,
  });
  const inputRef = useRef(null);
  // Treat the token present at mount as the baseline. This prevents a stale
  // context-menu request from stealing focus if the inspector remounts later.
  const handledFocusTokenRef = useRef(focusToken);
  const layerRef = useRef(null);
  const panelRef = useRef(null);
  const layoutRef = useRef(panelLayout);
  const manualPlacementRef = useRef(false);
  const activeDragCleanupRef = useRef(null);
  const placementFrameRef = useRef(null);
  const lifecycleRef = useRef({
    open: false,
    selectionKey: null,
    anchorId: null,
    placementRevision: null,
  });

  layoutRef.current = panelLayout;

  const setLayerRef = useCallback(
    (node) => {
      layerRef.current = node;
      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    },
    [ref]
  );

  const cancelPlacementFrame = useCallback(() => {
    if (placementFrameRef.current == null) return;
    if (typeof window !== "undefined" && window.cancelAnimationFrame) {
      window.cancelAnimationFrame(placementFrameRef.current);
    } else {
      clearTimeout(placementFrameRef.current);
    }
    placementFrameRef.current = null;
  }, []);

  const stopActiveDrag = useCallback((commit = false) => {
    if (typeof activeDragCleanupRef.current === "function") {
      activeDragCleanupRef.current(commit);
      activeDragCleanupRef.current = null;
    }
  }, []);

  const resolveGeometry = useCallback(
    (requestedAnchorId = anchorId) => {
      const containerRect = rectFrom(
        resolveContainerRect?.() || layerRef.current?.getBoundingClientRect?.()
      );
      const boundsRect = rectFrom(resolveBoundsRect?.() || containerRect);
      if (!containerRect || !boundsRect) return null;

      const anchorRect = rectFrom(
        requestedAnchorId != null
          ? resolveAnchorRect?.(requestedAnchorId)
          : null
      );
      const viewportWidth =
        typeof window !== "undefined" && Number.isFinite(window.innerWidth)
          ? window.innerWidth
          : containerRect.width;
      const naturalWidth = Math.min(
        MAX_PANEL_WIDTH,
        Math.max(MIN_PANEL_WIDTH, viewportWidth * 0.32)
      );
      const measuredPanel = rectFrom(panelRef.current?.getBoundingClientRect?.());
      const measuredHeight = measuredPanel?.height > 0 ? measuredPanel.height : 460;
      const sheet = isNarrowFloatingPanel({
        boundsRect,
        galleryRect: boundsRect,
        anchorRect,
        panelSize: { width: naturalWidth, height: measuredHeight },
        margin: PANEL_MARGIN,
        gap: PANEL_GAP,
        breakpoint: NARROW_BREAKPOINT,
      });
      const width = sheet
        ? Math.max(0, boundsRect.width - 16)
        : Math.min(naturalWidth, Math.max(0, boundsRect.width - PANEL_MARGIN * 2));
      const maxHeight = Math.max(
        0,
        sheet
          ? Math.min(boundsRect.height - 16, boundsRect.height * 0.68)
          : boundsRect.height - PANEL_MARGIN * 2
      );
      const height = Math.min(measuredHeight, maxHeight);

      return {
        containerRect,
        boundsRect,
        anchorRect,
        panelSize: { width, height },
        width,
        maxHeight,
        sheet,
      };
    },
    [anchorId, resolveAnchorRect, resolveBoundsRect, resolveContainerRect]
  );

  const applyPanelTransform = useCallback((position) => {
    if (!panelRef.current || !position) return;
    panelRef.current.style.transform = `translate3d(${Math.round(
      position.x
    )}px, ${Math.round(position.y)}px, 0)`;
  }, []);

  const commitLayout = useCallback(
    (nextLayout) => {
      layoutRef.current = nextLayout;
      applyPanelTransform(nextLayout);
      setPanelLayout((current) =>
        samePosition(current, nextLayout) ? current : nextLayout
      );
    },
    [applyPanelTransform]
  );

  const positionPanel = useCallback(
    ({ automatic = false, requestedAnchorId = anchorId, avoidRect = null } = {}) => {
      const geometry = resolveGeometry(requestedAnchorId);
      if (!geometry) return;

      const current = layoutRef.current;
      const modeChanged = current.ready && current.sheet !== geometry.sheet;
      const shouldAuto = automatic || !current.ready || modeChanged || geometry.sheet;
      let viewportPosition;
      let side = current.side;

      if (shouldAuto) {
        const computed = computeFloatingPanelPosition({
          anchorRect: geometry.anchorRect,
          panelSize: geometry.panelSize,
          boundsRect: geometry.boundsRect,
          galleryRect: geometry.boundsRect,
          avoidRect,
          margin: PANEL_MARGIN,
          gap: PANEL_GAP,
          narrowBreakpoint: NARROW_BREAKPOINT,
          forceSheet: geometry.sheet,
        });
        viewportPosition = computed;
        side = computed.side;
        if (modeChanged) {
          manualPlacementRef.current = false;
        }
      } else {
        viewportPosition = clampFloatingPanelPosition(
          {
            x: geometry.containerRect.left + current.x,
            y: geometry.containerRect.top + current.y,
          },
          geometry.panelSize,
          geometry.boundsRect,
          PANEL_MARGIN
        );
      }

      commitLayout({
        x: viewportPosition.x - geometry.containerRect.left,
        y: viewportPosition.y - geometry.containerRect.top,
        side,
        sheet: geometry.sheet,
        width: geometry.width,
        maxHeight: geometry.maxHeight,
        ready: true,
      });
    },
    [anchorId, commitLayout, resolveGeometry]
  );

  const derivedSelectionCount = useMemo(
    () => deriveMetadataSelectionCount(selectionCount, selectedVideos),
    [selectionCount, selectedVideos]
  );

  const hasSelection = derivedSelectionCount > 0;
  const resolvedSelectionKey = useMemo(
    () => deriveMetadataSelectionKey(selectedVideos, selectionKey),
    [selectedVideos, selectionKey]
  );
  const placementRevision =
    placementRequest?.revision ?? placementRequest?.requestId ?? null;

  useLayoutEffect(() => {
    const previous = lifecycleRef.current;

    if (!isOpen || !hasSelection) {
      stopActiveDrag(false);
      cancelPlacementFrame();
      manualPlacementRef.current = false;
      lifecycleRef.current = {
        open: false,
        selectionKey: resolvedSelectionKey,
        anchorId,
        placementRevision,
      };
      return;
    }

    const opening = !previous.open;
    const selectionChanged = previous.selectionKey !== resolvedSelectionKey;
    const anchorChanged = previous.anchorId !== anchorId;
    const placementChanged = previous.placementRevision !== placementRevision;

    if (opening) {
      manualPlacementRef.current = false;
    }

    if (
      opening ||
      !layoutRef.current.ready ||
      (!manualPlacementRef.current &&
        (selectionChanged || anchorChanged || placementChanged))
    ) {
      positionPanel({
        automatic: true,
        requestedAnchorId: placementRequest?.anchorId ?? anchorId,
        avoidRect: placementRequest?.avoidRect ?? null,
      });
    } else if (selectionChanged || anchorChanged || placementChanged) {
      positionPanel({ automatic: false });
    }

    lifecycleRef.current = {
      open: true,
      selectionKey: resolvedSelectionKey,
      anchorId,
      placementRevision,
    };
  }, [
    anchorId,
    cancelPlacementFrame,
    hasSelection,
    isOpen,
    placementRequest?.anchorId,
    placementRequest?.avoidRect,
    placementRevision,
    positionPanel,
    resolvedSelectionKey,
    stopActiveDrag,
  ]);

  const schedulePositionClamp = useCallback(() => {
    if (!isOpen || !hasSelection || typeof window === "undefined") return;
    cancelPlacementFrame();
    const callback = () => {
      placementFrameRef.current = null;
      positionPanel({ automatic: false });
    };
    placementFrameRef.current = window.requestAnimationFrame
      ? window.requestAnimationFrame(callback)
      : window.setTimeout(callback, 0);
  }, [
    cancelPlacementFrame,
    hasSelection,
    isOpen,
    positionPanel,
  ]);

  useLayoutEffect(() => {
    if (!isOpen || !hasSelection || !layoutRef.current.ready) return;
    positionPanel({ automatic: false });
  }, [boundsVersion, hasSelection, isOpen, positionPanel]);

  useEffect(() => {
    if (!isOpen || !hasSelection || typeof window === "undefined") return undefined;
    const handleResize = () => schedulePositionClamp();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [hasSelection, isOpen, schedulePositionClamp]);

  useEffect(() => {
    if (
      !isOpen ||
      !hasSelection ||
      !panelRef.current ||
      typeof ResizeObserver === "undefined"
    ) {
      return undefined;
    }
    const observer = new ResizeObserver(() => schedulePositionClamp());
    observer.observe(panelRef.current);
    return () => observer.disconnect();
  }, [hasSelection, isOpen, schedulePositionClamp]);

  useEffect(
    () => () => {
      stopActiveDrag(false);
      cancelPlacementFrame();
    },
    [cancelPlacementFrame, stopActiveDrag]
  );

  const handleDragPointerDown = useCallback(
    (event) => {
      if (
        layoutRef.current.sheet ||
        !layoutRef.current.ready ||
        event.isPrimary === false ||
        (event.pointerType === "mouse" && event.button !== 0) ||
        typeof window === "undefined"
      ) {
        return;
      }

      const interactiveTarget = event.target?.closest?.(
        "button, a, input, textarea, select, [contenteditable='true']"
      );
      if (interactiveTarget) return;

      const geometry = resolveGeometry(anchorId);
      if (!geometry) return;

      stopActiveDrag(false);
      event.preventDefault();

      const handleNode = event.currentTarget;
      const pointerId = event.pointerId;
      const startClient = {
        x: finiteNumber(event.clientX),
        y: finiteNumber(event.clientY),
      };
      const startPosition = {
        x: layoutRef.current.x,
        y: layoutRef.current.y,
      };
      let latestClient = startClient;
      let latestPosition = startPosition;
      let moveFrame = null;
      let finished = false;

      const applyLatestMove = () => {
        moveFrame = null;
        const clamped = clampFloatingPanelPosition(
          {
            x:
              geometry.containerRect.left +
              startPosition.x +
              latestClient.x -
              startClient.x,
            y:
              geometry.containerRect.top +
              startPosition.y +
              latestClient.y -
              startClient.y,
          },
          geometry.panelSize,
          geometry.boundsRect,
          PANEL_MARGIN
        );
        latestPosition = {
          x: clamped.x - geometry.containerRect.left,
          y: clamped.y - geometry.containerRect.top,
        };
        applyPanelTransform(latestPosition);
      };

      const scheduleMove = () => {
        if (moveFrame != null) return;
        moveFrame = window.requestAnimationFrame
          ? window.requestAnimationFrame(applyLatestMove)
          : window.setTimeout(applyLatestMove, 0);
      };

      const handlePointerMove = (moveEvent) => {
        if (pointerId != null && moveEvent.pointerId !== pointerId) return;
        latestClient = {
          x: finiteNumber(moveEvent.clientX, latestClient.x),
          y: finiteNumber(moveEvent.clientY, latestClient.y),
        };
        moveEvent.preventDefault?.();
        scheduleMove();
      };

      const finish = (commit) => {
        if (finished) return;
        finished = true;
        if (moveFrame != null) {
          if (window.cancelAnimationFrame) {
            window.cancelAnimationFrame(moveFrame);
          } else {
            clearTimeout(moveFrame);
          }
          moveFrame = null;
          if (commit) applyLatestMove();
        }
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerCancel);
        panelRef.current?.classList.remove("metadata-panel__container--dragging");
        document.body?.classList.remove("metadata-panel-drag-active");
        try {
          if (pointerId != null) handleNode?.releasePointerCapture?.(pointerId);
        } catch (err) {}
        if (commit) {
          manualPlacementRef.current = true;
          commitLayout({ ...layoutRef.current, ...latestPosition });
        } else {
          applyPanelTransform(layoutRef.current);
        }
        activeDragCleanupRef.current = null;
      };

      const handlePointerUp = (upEvent) => {
        if (pointerId != null && upEvent.pointerId !== pointerId) return;
        latestClient = {
          x: finiteNumber(upEvent.clientX, latestClient.x),
          y: finiteNumber(upEvent.clientY, latestClient.y),
        };
        finish(true);
      };

      const handlePointerCancel = (cancelEvent) => {
        if (pointerId != null && cancelEvent.pointerId !== pointerId) return;
        finish(false);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerCancel);
      panelRef.current?.classList.add("metadata-panel__container--dragging");
      document.body?.classList.add("metadata-panel-drag-active");
      activeDragCleanupRef.current = finish;

      try {
        if (pointerId != null) handleNode?.setPointerCapture?.(pointerId);
      } catch (err) {}
    },
    [
      anchorId,
      applyPanelTransform,
      commitLayout,
      resolveGeometry,
      stopActiveDrag,
    ]
  );

  const handleDragKeyDown = useCallback(
    (event) => {
      if (event.key === "Home") {
        event.preventDefault();
        manualPlacementRef.current = false;
        positionPanel({ automatic: true, requestedAnchorId: anchorId });
        return;
      }

      const movement = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      }[event.key];
      if (!movement || layoutRef.current.sheet) return;

      const geometry = resolveGeometry(anchorId);
      if (!geometry) return;
      event.preventDefault();
      const step = event.shiftKey ? 48 : 16;
      const current = layoutRef.current;
      const clamped = clampFloatingPanelPosition(
        {
          x: geometry.containerRect.left + current.x + movement[0] * step,
          y: geometry.containerRect.top + current.y + movement[1] * step,
        },
        geometry.panelSize,
        geometry.boundsRect,
        PANEL_MARGIN
      );
      manualPlacementRef.current = true;
      commitLayout({
        ...current,
        x: clamped.x - geometry.containerRect.left,
        y: clamped.y - geometry.containerRect.top,
      });
    },
    [anchorId, commitLayout, positionPanel, resolveGeometry]
  );

  const handlePanelKeyDown = useCallback(
    (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose?.();
    },
    [onClose]
  );

  useEffect(() => {
    if (
      !isOpen ||
      !hasSelection ||
      !focusToken ||
      handledFocusTokenRef.current === focusToken
    ) {
      return;
    }
    handledFocusTokenRef.current = focusToken;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken, hasSelection, isOpen]);

  const singleSelectionInfo = useMemo(
    () => deriveSingleSelectionInfo(selectedVideos, derivedSelectionCount),
    [derivedSelectionCount, selectedVideos]
  );

  if (!isOpen || !hasSelection) return null;

  const panelClass = [
    "metadata-panel",
    "metadata-panel--open",
    panelLayout.ready ? "metadata-panel--ready" : "",
    panelLayout.sheet ? "metadata-panel--sheet" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const showFocusButton = typeof onFocusSelection === "function";
  const selectionSubtitle = `${derivedSelectionCount} clip${
    derivedSelectionCount === 1 ? "" : "s"
  } selected`;
  const announcement =
    derivedSelectionCount === 1 && singleSelectionInfo?.filename
      ? `Details updated for ${singleSelectionInfo.filename}`
      : `Details updated for ${selectionSubtitle}`;

  return (
    <aside
      ref={setLayerRef}
      className={panelClass}
      role="complementary"
      aria-label="Selection details"
      onKeyDown={handlePanelKeyDown}
    >
      <div
        ref={panelRef}
        className="metadata-panel__container"
        data-placement-side={panelLayout.side}
        style={{
          width: `${Math.round(panelLayout.width)}px`,
          maxHeight: `${Math.round(panelLayout.maxHeight)}px`,
          transform: `translate3d(${Math.round(panelLayout.x)}px, ${Math.round(
            panelLayout.y
          )}px, 0)`,
        }}
      >
        <div
          className="metadata-panel__header"
          role="group"
          tabIndex={0}
          aria-label="Move selection details"
          aria-disabled={panelLayout.sheet || undefined}
          title={
            panelLayout.sheet
              ? "Details are fixed as a bottom sheet in this window size"
              : "Drag to move. Use arrow keys to move, Shift for larger steps, or Home to reset."
          }
          onPointerDown={handleDragPointerDown}
          onKeyDown={handleDragKeyDown}
        >
          <div
            className="metadata-panel__grip"
            aria-hidden="true"
          >
            <span />
            <span />
            <span />
          </div>
          <div className="metadata-panel__titles">
            <span className="metadata-panel__title">Details</span>
            <span className="metadata-panel__subtitle">{selectionSubtitle}</span>
          </div>
          <div className="metadata-panel__header-actions">
            {typeof onDock === "function" ? (
              <button
                type="button"
                className="metadata-panel__button metadata-panel__button--compact metadata-panel__button--dock"
                onClick={onDock}
                aria-label="Dock selection details in sidebar"
                title="Dock details in sidebar"
              >
                <DockPanelIcon />
                <span>Dock</span>
              </button>
            ) : null}
            {showFocusButton && (
              <button
                type="button"
                className="metadata-panel__button metadata-panel__button--compact metadata-panel__button--focus"
                onClick={onFocusSelection}
                aria-label="Focus selection in grid"
                title="Scroll to selected videos"
              >
                <FocusSelectionIcon />
                <span>Focus</span>
              </button>
            )}
          </div>
          <button
            type="button"
            className="metadata-panel__close"
            onClick={() => onClose?.()}
            aria-label="Close selection details"
            title="Close details"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <span className="metadata-panel__announcement" aria-live="polite">
          {announcement}
        </span>
        <div className="metadata-panel__content">
          <MetadataInspectorContent
            ref={inputRef}
            selectionCount={derivedSelectionCount}
            selectedVideos={selectedVideos}
            availableTags={availableTags}
            active={isOpen}
            selectionKey={resolvedSelectionKey}
            suggestionLimit={suggestionLimit}
            generationMetadataState={generationMetadataState}
            generationExpanded={generationExpanded}
            onGenerationExpandedChange={onGenerationExpandedChange}
            onAddTag={onAddTag}
            onRemoveTag={onRemoveTag}
            onApplyTagToSelection={onApplyTagToSelection}
            onSetRating={onSetRating}
            onClearRating={onClearRating}
            onSetReviewState={onSetReviewState}
            reviewModeEnabled={reviewModeEnabled}
          />
        </div>
      </div>
    </aside>
  );
});

MetadataPanel.displayName = "MetadataPanel";

export default MetadataPanel;
