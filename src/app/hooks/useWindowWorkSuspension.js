import { useEffect, useMemo, useRef, useState } from "react";

const readDocumentActivity = () => {
  if (typeof document === "undefined") {
    return { hidden: false, visibilityState: "visible" };
  }

  const visibilityState = document.visibilityState || "visible";
  return {
    hidden: Boolean(document.hidden || visibilityState === "hidden"),
    visibilityState,
  };
};

const optionalBoolean = (value) =>
  typeof value === "boolean" ? value : null;

const normalizeWindowActivity = (payload) => {
  const source = payload?.activity && typeof payload.activity === "object"
    ? payload.activity
    : payload;

  if (typeof source === "boolean") {
    return {
      active: source,
      visible: null,
      hidden: null,
      minimized: null,
      reason: source ? null : "window-inactive",
    };
  }

  if (!source || typeof source !== "object") return null;

  const minimized = optionalBoolean(
    source.minimized ?? source.isMinimized
  );
  const hidden = optionalBoolean(source.hidden ?? source.isHidden);
  const visible = optionalBoolean(source.visible ?? source.isVisible);
  let active = optionalBoolean(source.active ?? source.isActive);

  if (active === null && (minimized !== null || hidden !== null || visible !== null)) {
    active = minimized !== true && hidden !== true && visible !== false;
  }

  return {
    active,
    visible,
    hidden,
    minimized,
    reason:
      typeof source.reason === "string" && source.reason.trim()
        ? source.reason.trim()
        : null,
  };
};

const disposeSubscription = (subscription) => {
  if (typeof subscription === "function") {
    subscription();
    return;
  }
  if (typeof subscription?.dispose === "function") {
    subscription.dispose();
    return;
  }
  subscription?.unsubscribe?.();
};

/**
 * Combines the Page Visibility API with Electron's optional window-activity
 * bridge. Document state is available synchronously; the bridge fills in
 * minimize/hide state without allowing a late initial query to overwrite a
 * newer activity event.
 */
export default function useWindowWorkSuspension({ enabled = true } = {}) {
  const [documentActivity, setDocumentActivity] = useState(readDocumentActivity);
  const [windowActivity, setWindowActivity] = useState(null);
  const remoteRevisionRef = useRef(0);

  useEffect(() => {
    const updateDocumentActivity = () => {
      const next = readDocumentActivity();
      setDocumentActivity((previous) =>
        previous.hidden === next.hidden &&
        previous.visibilityState === next.visibilityState
          ? previous
          : next
      );
    };

    updateDocumentActivity();
    if (typeof document === "undefined") return undefined;
    document.addEventListener?.("visibilitychange", updateDocumentActivity);
    return () => {
      document.removeEventListener?.(
        "visibilitychange",
        updateDocumentActivity
      );
    };
  }, []);

  useEffect(() => {
    const playbackApi =
      typeof window !== "undefined" ? window.electronAPI?.playback : null;
    if (!playbackApi) return undefined;

    let disposed = false;
    const applyEvent = (payload) => {
      if (disposed) return;
      remoteRevisionRef.current += 1;
      const normalized = normalizeWindowActivity(payload);
      if (normalized) setWindowActivity(normalized);
    };

    let subscription = null;
    try {
      subscription = playbackApi.onWindowActivity?.(applyEvent) ?? null;
    } catch {
      subscription = null;
    }

    const queryRevision = remoteRevisionRef.current;
    try {
      const initial = playbackApi.getWindowActivity?.();
      Promise.resolve(initial)
        .then((payload) => {
          if (disposed || remoteRevisionRef.current !== queryRevision) return;
          const normalized = normalizeWindowActivity(payload);
          if (normalized) setWindowActivity(normalized);
        })
        .catch(() => {});
    } catch {}

    return () => {
      disposed = true;
      remoteRevisionRef.current += 1;
      try {
        disposeSubscription(subscription);
      } catch {}
    };
  }, []);

  const result = useMemo(() => {
    const documentHidden = documentActivity.hidden;
    const minimized = windowActivity?.minimized === true;
    const windowHidden =
      windowActivity?.hidden === true || windowActivity?.visible === false;
    const windowInactive = windowActivity?.active === false;

    let reason = null;
    if (documentHidden) {
      reason = "document-hidden";
    } else if (minimized) {
      reason = windowActivity?.reason || "window-minimized";
    } else if (windowHidden) {
      reason = windowActivity?.reason || "window-hidden";
    } else if (windowInactive) {
      reason = windowActivity?.reason || "window-inactive";
    }

    const isSuspended = Boolean(enabled && reason);
    return {
      isSuspended,
      reason: isSuspended ? reason : null,
      activity: {
        active: !isSuspended,
        documentHidden,
        visibilityState: documentActivity.visibilityState,
        windowActive: windowActivity?.active ?? null,
        windowVisible: windowActivity?.visible ?? null,
        windowHidden: windowActivity?.hidden ?? null,
        minimized: windowActivity?.minimized ?? null,
      },
    };
  }, [documentActivity, enabled, windowActivity]);

  const rendererActive = result.activity.active;
  useEffect(() => {
    try {
      const notification =
        typeof window !== "undefined"
          ? window.electronAPI?.playback?.setRendererActive?.(rendererActive)
          : null;
      notification?.catch?.(() => {});
    } catch {}
  }, [rendererActive]);

  return result;
}

export { normalizeWindowActivity, readDocumentActivity };
