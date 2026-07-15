import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const LEGACY_COLLECTION_OWNER = "fullscreen:legacy-collection";

let fullscreenSessionSequence = 0;

const createSessionToken = () =>
  `fullscreen-${Date.now().toString(36)}-${(
    ++fullscreenSessionSequence
  ).toString(36)}`;

const hasRecordId = (video) =>
  video != null && video.id !== null && video.id !== undefined;

const encodeIdentityPart = (value) =>
  `${typeof value}:${String(value).length}:${String(value)}`;

/**
 * `video.id` is the renderer's instance identity. The collection owner is kept
 * separately so an identical ID can never cross a root, profile, or web-file
 * selection boundary.
 */
export const getFullscreenRecordIdentity = (video) =>
  hasRecordId(video) ? `video:${encodeIdentityPart(video.id)}` : null;

const isAvailableRecord = (video) =>
  hasRecordId(video) && video.present !== false;

const sameOwner = (first, second) => Object.is(first, second);

const findIdentityIndex = (videos, identity) => {
  if (!identity) return -1;
  return videos.findIndex(
    (video) => getFullscreenRecordIdentity(video) === identity
  );
};

const findIdIndex = (videos, id) =>
  videos.findIndex((video) => Object.is(video?.id, id));

const resolveTargetIndex = (videos, target) => {
  if (target == null) return -1;

  if (typeof target === "object") {
    const identity = getFullscreenRecordIdentity(target);
    const identityIndex = findIdentityIndex(videos, identity);
    if (identityIndex >= 0) return identityIndex;
    return hasRecordId(target) ? findIdIndex(videos, target.id) : -1;
  }

  const identityIndex = findIdentityIndex(videos, target);
  return identityIndex >= 0 ? identityIndex : findIdIndex(videos, target);
};

const createSession = ({
  videos,
  index,
  ownerKey,
  sessionToken,
}) => {
  const currentRecord = videos[index];
  if (!isAvailableRecord(currentRecord)) return null;

  return {
    ownerKey,
    sessionToken,
    currentRecord,
    currentIdentity: getFullscreenRecordIdentity(currentRecord),
    lastKnownIndex: index,
    previousId: index > 0 ? videos[index - 1]?.id ?? null : null,
    nextId:
      index + 1 < videos.length ? videos[index + 1]?.id ?? null : null,
  };
};

const refreshSessionFromCollection = (session, videos) => {
  if (!session) return { session: null, index: -1, sourceRemoved: false };

  const index = findIdentityIndex(videos, session.currentIdentity);
  if (index < 0) {
    return { session, index: -1, sourceRemoved: false };
  }

  const currentRecord = videos[index];
  if (!isAvailableRecord(currentRecord)) {
    return { session, index, sourceRemoved: true };
  }

  return {
    index,
    sourceRemoved: false,
    session: {
      ...session,
      currentRecord,
      lastKnownIndex: index,
      previousId: index > 0 ? videos[index - 1]?.id ?? null : null,
      nextId:
        index + 1 < videos.length ? videos[index + 1]?.id ?? null : null,
    },
  };
};

const sessionNeedsRefresh = (stored, refreshed) =>
  stored?.currentRecord !== refreshed?.currentRecord ||
  stored?.lastKnownIndex !== refreshed?.lastKnownIndex ||
  !Object.is(stored?.previousId, refreshed?.previousId) ||
  !Object.is(stored?.nextId, refreshed?.nextId);

const findAvailableIdIndex = (videos, id, excludedIdentity) => {
  if (id == null) return -1;
  const index = findIdIndex(videos, id);
  if (index < 0 || !isAvailableRecord(videos[index])) return -1;
  return getFullscreenRecordIdentity(videos[index]) === excludedIdentity
    ? -1
    : index;
};

const resolveSourceRemovalFallbackIndex = (session, videos) => {
  if (!session) return -1;

  const candidates = [];
  const addCandidate = (index) => {
    if (
      index < 0 ||
      index >= videos.length ||
      candidates.includes(index) ||
      !isAvailableRecord(videos[index]) ||
      getFullscreenRecordIdentity(videos[index]) === session.currentIdentity
    ) {
      return;
    }
    candidates.push(index);
  };

  // Prefer the captured successor, then the record which shifted into the old
  // index after removal. Only then fall back to the captured predecessor.
  addCandidate(
    findAvailableIdIndex(videos, session.nextId, session.currentIdentity)
  );
  addCandidate(session.lastKnownIndex);
  addCandidate(
    findAvailableIdIndex(videos, session.previousId, session.currentIdentity)
  );
  addCandidate(session.lastKnownIndex - 1);

  return candidates[0] ?? -1;
};

const resolveDirectionalIndex = (
  session,
  videos,
  direction,
  { skipFingerprint = null } = {}
) => {
  if (!session) return -1;

  const step = direction === "next" ? 1 : -1;
  const currentIndex = findIdentityIndex(videos, session.currentIdentity);
  let candidateIndex;
  if (currentIndex >= 0) {
    candidateIndex = currentIndex + step;
  } else {
    const capturedId =
      direction === "next" ? session.nextId : session.previousId;
    candidateIndex = findIdIndex(videos, capturedId);
    if (candidateIndex < 0) {
      candidateIndex =
        direction === "next"
          ? Math.min(session.lastKnownIndex, videos.length - 1)
          : Math.min(session.lastKnownIndex - 1, videos.length - 1);
    }
  }

  while (candidateIndex >= 0 && candidateIndex < videos.length) {
    const candidate = videos[candidateIndex];
    if (
      isAvailableRecord(candidate) &&
      (skipFingerprint == null ||
        !Object.is(candidate.fingerprint, skipFingerprint))
    ) {
      return candidateIndex;
    }
    candidateIndex += step;
  }

  return -1;
};

const normalizeArguments = (input, secondArgument) => {
  if (Array.isArray(input)) {
    return {
      orderedVideos: input,
      collectionOwnerKey:
        secondArgument === undefined
          ? LEGACY_COLLECTION_OWNER
          : secondArgument,
    };
  }

  if (Array.isArray(secondArgument)) {
    return {
      orderedVideos: secondArgument,
      collectionOwnerKey: input,
    };
  }

  return {
    orderedVideos: Array.isArray(input?.orderedVideos)
      ? input.orderedVideos
      : [],
    collectionOwnerKey: input?.collectionOwnerKey ?? null,
  };
};

/**
 * Bounded fullscreen navigation controller.
 *
 * Preferred signature:
 *   useFullScreenModal({ collectionOwnerKey, orderedVideos })
 *
 * The legacy `(orderedVideos, collectionOwnerKey?)` form remains available
 * while App integration migrates. No collection snapshot is retained.
 */
export const useFullScreenModal = (input = [], secondArgument) => {
  const { orderedVideos, collectionOwnerKey } = normalizeArguments(
    input,
    secondArgument
  );
  const [storedSession, setStoredSession] = useState(null);
  const orderedVideosRef = useRef(orderedVideos);
  const ownerKeyRef = useRef(collectionOwnerKey);
  const activeSessionRef = useRef(null);

  orderedVideosRef.current = orderedVideos;
  ownerKeyRef.current = collectionOwnerKey;

  const ownerMatches = Boolean(
    storedSession && sameOwner(storedSession.ownerKey, collectionOwnerKey)
  );
  const refreshed = useMemo(
    () =>
      ownerMatches
        ? refreshSessionFromCollection(storedSession, orderedVideos)
        : { session: null, index: -1, sourceRemoved: false },
    [orderedVideos, ownerMatches, storedSession]
  );
  const activeSession = ownerMatches ? refreshed.session : null;
  activeSessionRef.current = activeSession;

  const activateIndex = useCallback((index, { newSession = false } = {}) => {
    const videos = orderedVideosRef.current;
    const current = activeSessionRef.current;
    const nextSession = createSession({
      videos,
      index,
      ownerKey: ownerKeyRef.current,
      sessionToken:
        newSession || !current?.sessionToken
          ? createSessionToken()
          : current.sessionToken,
    });
    if (!nextSession) return null;

    activeSessionRef.current = nextSession;
    setStoredSession(nextSession);
    return nextSession.currentRecord;
  }, []);

  const close = useCallback(() => {
    const closingRecord = activeSessionRef.current?.currentRecord ?? null;
    activeSessionRef.current = null;
    setStoredSession(null);
    return closingRecord;
  }, []);

  const open = useCallback(
    (target) => {
      const index = resolveTargetIndex(orderedVideosRef.current, target);
      if (index < 0) return null;
      return activateIndex(index, { newSession: true });
    },
    [activateIndex]
  );

  const goTo = useCallback(
    (target) => {
      if (!activeSessionRef.current) return null;
      const index = resolveTargetIndex(orderedVideosRef.current, target);
      if (index < 0) return null;
      return activateIndex(index);
    },
    [activateIndex]
  );

  const previous = useCallback((options) => {
    const session = activeSessionRef.current;
    if (!session) return null;

    const videos = orderedVideosRef.current;
    const targetIndex = resolveDirectionalIndex(
      session,
      videos,
      "previous",
      options
    );
    if (targetIndex < 0) return null;
    return activateIndex(targetIndex);
  }, [activateIndex]);

  const next = useCallback((options) => {
    const session = activeSessionRef.current;
    if (!session) return null;

    const videos = orderedVideosRef.current;
    const targetIndex = resolveDirectionalIndex(
      session,
      videos,
      "next",
      options
    );
    if (targetIndex < 0) return null;
    return activateIndex(targetIndex);
  }, [activateIndex]);

  const peekNavigation = useCallback((direction, options) => {
    const session = activeSessionRef.current;
    if (!session) return null;
    const videos = orderedVideosRef.current;
    const index = resolveDirectionalIndex(
      session,
      videos,
      direction === "next" ? "next" : "previous",
      options
    );
    return index >= 0 ? videos[index] || null : null;
  }, []);

  const sourceRemoved = useCallback(
    (target = activeSessionRef.current?.currentIdentity) => {
      const session = activeSessionRef.current;
      if (!session) return null;

      const targetIdentity =
        typeof target === "object"
          ? getFullscreenRecordIdentity(target)
          : target === session.currentRecord?.id
            ? session.currentIdentity
            : target;
      if (targetIdentity !== session.currentIdentity) {
        return session.currentRecord;
      }

      const fallbackIndex = resolveSourceRemovalFallbackIndex(
        session,
        orderedVideosRef.current
      );
      if (fallbackIndex >= 0) return activateIndex(fallbackIndex);
      close();
      return null;
    },
    [activateIndex, close]
  );

  // Ownership loss is reflected in the returned model during render and the
  // stale state is discarded before paint. App integration still releases the
  // player synchronously before changing this key.
  useLayoutEffect(() => {
    if (storedSession && !sameOwner(storedSession.ownerKey, collectionOwnerKey)) {
      activeSessionRef.current = null;
      setStoredSession(null);
    }
  }, [collectionOwnerKey, storedSession]);

  // Persist only the latest record and immediate navigation context. A
  // metadata-only replacement therefore updates the returned record without
  // changing the logical identity or session token.
  useLayoutEffect(() => {
    if (
      storedSession &&
      activeSession &&
      !refreshed.sourceRemoved &&
      sessionNeedsRefresh(storedSession, activeSession)
    ) {
      activeSessionRef.current = activeSession;
      setStoredSession(activeSession);
    }
  }, [activeSession, refreshed.sourceRemoved, storedSession]);

  // A retained record disappearing from a filtered array is intentional. A
  // record explicitly marked missing is different: advance to a valid captured
  // neighbor or close if none remains.
  useLayoutEffect(() => {
    if (activeSession && refreshed.sourceRemoved) {
      sourceRemoved(activeSession.currentIdentity);
    }
  }, [activeSession, refreshed.sourceRemoved, sourceRemoved]);

  const currentViewIndex = activeSession
    ? findIdentityIndex(orderedVideos, activeSession.currentIdentity)
    : -1;
  const isInCurrentView = currentViewIndex >= 0;
  const previousIndex = activeSession
    ? resolveDirectionalIndex(activeSession, orderedVideos, "previous")
    : -1;
  const nextIndex = activeSession
    ? resolveDirectionalIndex(activeSession, orderedVideos, "next")
    : -1;
  const canGoPrevious = previousIndex >= 0;
  const canGoNext = nextIndex >= 0;

  const navigate = useCallback(
    (direction, options) => {
      if (direction === "next") return next(options);
      if (direction === "previous" || direction === "prev") {
        return previous(options);
      }
      return null;
    },
    [next, previous]
  );

  return {
    isOpen: Boolean(activeSession),
    currentVideo: activeSession?.currentRecord ?? null,
    currentIdentity: activeSession?.currentIdentity ?? null,
    currentIndex: activeSession?.lastKnownIndex ?? -1,
    currentViewIndex,
    count: orderedVideos.length,
    isInCurrentView,
    previousId: activeSession?.previousId ?? null,
    nextId: activeSession?.nextId ?? null,
    canGoPrevious,
    canGoNext,
    isAtStart: Boolean(activeSession) && !canGoPrevious,
    isAtEnd: Boolean(activeSession) && !canGoNext,
    sessionToken: activeSession?.sessionToken ?? null,
    collectionOwnerKey: activeSession?.ownerKey ?? null,
    open,
    goTo,
    previous,
    next,
    peekNavigation,
    close,
    sourceRemoved,

    // Compatibility aliases for the existing App integration. These can be
    // removed once it consumes the explicit controller model above.
    fullScreenVideo: activeSession?.currentRecord ?? null,
    fullScreenIndex: activeSession?.lastKnownIndex ?? -1,
    fullScreenCount: orderedVideos.length,
    hasPrevious: canGoPrevious,
    hasNext: canGoNext,
    isCurrentInView: isInCurrentView,
    capturedPreviousId: activeSession?.previousId ?? null,
    capturedNextId: activeSession?.nextId ?? null,
    openFullScreen: open,
    goToFullScreen: goTo,
    closeFullScreen: close,
    navigateFullScreen: navigate,
    handleSourceRemoved: sourceRemoved,
  };
};
