// src/hooks/fullscreen/useAdoptedVideo.js
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Adopt an existing grid item (wrapper with data-video-id) into a modal host.
 * Falls back to a local <video> the caller renders if no grid item is found.
 *
 * API
 *   const { adoptHostRef, fallbackRef, activeVideoRef, usingAdopted } =
 *     useAdoptedVideo(currentVideo, gridRootRef)
 */
export function useAdoptedVideo(currentVideo, gridRootRef) {
  const adoptHostRef = useRef(null);     // <div> inside modal where we append the adopted wrapper
  const fallbackRef = useRef(null);      // <video> inside modal used when no adoption
  const adoptedWrapperRef = useRef(null);// the adopted wrapper element (with data-video-id)
  const originalParentRef = useRef(null);
  const originalNextRef = useRef(null);
  const [usingAdopted, setUsingAdopted] = useState(false);

  const activeVideoRef = useMemo(() => {
    if (usingAdopted && adoptedWrapperRef.current) {
      const v = adoptedWrapperRef.current.querySelector("video");
      return { current: v || null };
    }
    return fallbackRef;
  }, [usingAdopted]);

  // Helper to restore previously adopted wrapper back to its place
  function restorePrevious() {
    const wrapper = adoptedWrapperRef.current;
    const parent = originalParentRef.current;
    const next = originalNextRef.current;
    if (wrapper && parent) {
      try {
        if (next && next.parentNode === parent) {
          parent.insertBefore(wrapper, next);
        } else {
          parent.appendChild(wrapper);
        }
      } catch {
        // no-op in tests
      }
    }
    adoptedWrapperRef.current = null;
    originalParentRef.current = null;
    originalNextRef.current = null;
    setUsingAdopted(false);
  }

  useEffect(() => {
    const id = currentVideo?.id ?? currentVideo;
    const host = adoptHostRef.current;
    const gridRoot = gridRootRef?.current || document;

    // Always restore the previous adoption when id changes
    if (adoptedWrapperRef.current && originalParentRef.current) {
      restorePrevious();
    }

    if (!id || !host || !gridRoot) {
      setUsingAdopted(false);
      return;
    }

    // Find a wrapper carrying data-video-id="<id>"
    // Use a permissive escape to support slashes etc.
    const esc =
      CSS && CSS.escape ? CSS.escape(String(id)) : String(id).replace(/["\\]/g, "\\$&");
    let wrapper = gridRoot.querySelector(`[data-video-id="${esc}"]`);

    if (wrapper) {
      try {
        originalParentRef.current = wrapper.parentElement;
        originalNextRef.current = wrapper.nextSibling;
        host.appendChild(wrapper);
        adoptedWrapperRef.current = wrapper;
        setUsingAdopted(true);
      } catch {
        adoptedWrapperRef.current = null;
        originalParentRef.current = null;
        originalNextRef.current = null;
        setUsingAdopted(false);
      }
    } else {
      setUsingAdopted(false);
    }

    // Cleanup on unmount / change
    return () => {
      if (adoptedWrapperRef.current && originalParentRef.current) {
        restorePrevious();
      }
    };
    // We only depend on the current video id and the *identity* of the grid root
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentVideo?.id, gridRootRef]);

  return { adoptHostRef, fallbackRef, activeVideoRef, usingAdopted };
}

export default useAdoptedVideo;
