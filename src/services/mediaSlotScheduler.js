const DEFAULT_LIMITS = Object.freeze({
  maxResident: 1,
  maxLoaders: 1,
  maxDecoders: 1,
  maxExternalDecoders: 1,
  maxAuxiliaryDecoders: 1,
});

const finiteLimit = (value, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.floor(number));
};

const normalizeId = (id) => {
  if (typeof id === "string" && id) return id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return null;
};

/**
 * Imperative media-slot authority.
 *
 * React state may mirror these sets, but admission and release are synchronous
 * and token-owned so a stale render or an old card generation cannot free a
 * newer card's resources.
 */
export function createMediaSlotScheduler(initialLimits = {}) {
  let scope = 1;
  let sequence = 0;
  let limits = {
    maxResident: finiteLimit(
      initialLimits.maxResident,
      DEFAULT_LIMITS.maxResident
    ),
    maxLoaders: finiteLimit(
      initialLimits.maxLoaders,
      DEFAULT_LIMITS.maxLoaders
    ),
    maxDecoders: finiteLimit(
      initialLimits.maxDecoders,
      DEFAULT_LIMITS.maxDecoders
    ),
    maxExternalDecoders: finiteLimit(
      initialLimits.maxExternalDecoders,
      DEFAULT_LIMITS.maxExternalDecoders
    ),
    maxAuxiliaryDecoders: finiteLimit(
      initialLimits.maxAuxiliaryDecoders,
      DEFAULT_LIMITS.maxAuxiliaryDecoders
    ),
  };

  const loadersById = new Map();
  const residentsById = new Map();
  const decodersById = new Map();
  const stoppingDecoderIds = new Set();
  const externalDecodersById = new Map();
  const auxiliaryDecodersById = new Map();
  const loaderWaiters = new Map();
  const blockedIds = new Set();
  let loaderPumpScheduled = false;

  const makeLease = (kind, id, ownerToken = null) =>
    Object.freeze({
      kind,
      id,
      scope,
      token: ++sequence,
      ...(ownerToken === null ? {} : { ownerToken }),
    });

  const isCurrentLoader = (lease) =>
    Boolean(
      lease &&
        lease.kind === "loader" &&
        lease.scope === scope &&
        loadersById.get(lease.id) === lease
    );

  const isCurrentResident = (lease) =>
    Boolean(
      lease &&
        lease.kind === "loader" &&
        lease.scope === scope &&
        residentsById.get(lease.id) === lease
    );

  const isCurrentDecoder = (lease) =>
    Boolean(
      lease &&
        lease.kind === "decoder" &&
        lease.scope === scope &&
        decodersById.get(lease.id) === lease
    );

  const isCurrentExternalDecoder = (lease) =>
    Boolean(
      lease &&
        lease.kind === "external-decoder" &&
        lease.scope === scope &&
        externalDecodersById.get(lease.id) === lease
    );

  const isCurrentAuxiliaryDecoder = (lease) =>
    Boolean(
      lease &&
        lease.kind === "auxiliary-decoder" &&
        lease.scope === scope &&
        auxiliaryDecodersById.get(lease.id) === lease
    );

  const releaseDecoderForId = (id, ownerToken = null) => {
    const decoder = decodersById.get(id);
    if (!decoder) return false;
    if (ownerToken !== null && decoder.ownerToken !== ownerToken) return false;
    decodersById.delete(id);
    stoppingDecoderIds.delete(id);
    return true;
  };

  const scheduleLoaderPump = () => {
    if (loaderPumpScheduled || loaderWaiters.size === 0) return;
    loaderPumpScheduled = true;
    const enqueue =
      typeof queueMicrotask === "function"
        ? queueMicrotask
        : (callback) => Promise.resolve().then(callback);
    enqueue(() => {
      loaderPumpScheduled = false;
      const waiters = Array.from(loaderWaiters.values()).sort(
        (left, right) =>
          right.priority - left.priority || left.lease.token - right.lease.token
      );

      for (const waiter of waiters) {
        if (!loaderWaiters.has(waiter.lease.token)) continue;
        if (waiter.lease.scope !== scope) {
          loaderWaiters.delete(waiter.lease.token);
          continue;
        }
        const lease = reserveLoader(waiter.id, waiter.options);
        if (!lease) continue;

        loaderWaiters.delete(waiter.lease.token);
        try {
          if (waiter.onGranted(lease) === false) failLoader(lease);
        } catch {
          failLoader(lease);
        }
      }
    });
  };

  const configure = (nextLimits = {}) => {
    limits = {
      maxResident: finiteLimit(nextLimits.maxResident, limits.maxResident),
      maxLoaders: finiteLimit(nextLimits.maxLoaders, limits.maxLoaders),
      maxDecoders: finiteLimit(nextLimits.maxDecoders, limits.maxDecoders),
      maxExternalDecoders: finiteLimit(
        nextLimits.maxExternalDecoders,
        limits.maxExternalDecoders
      ),
      maxAuxiliaryDecoders: finiteLimit(
        nextLimits.maxAuxiliaryDecoders,
        limits.maxAuxiliaryDecoders
      ),
    };
    scheduleLoaderPump();
    return { ...limits };
  };

  const canReserveLoader = (idValue, options = {}) => {
    const id = normalizeId(idValue);
    if (
      !id ||
      blockedIds.has(id) ||
      loadersById.has(id) ||
      limits.maxLoaders <= 0
    ) {
      return false;
    }
    if (loadersById.size >= limits.maxLoaders) return false;

    const existingResident = residentsById.get(id);
    if (existingResident) return false;

    // A loader owns its future resident slot from the moment it is admitted.
    // A caller must physically detach and release an old resident before it can
    // reserve a replacement, so authority never gets ahead of real cleanup.
    const projectedResidentUse = residentsById.size + loadersById.size;
    return projectedResidentUse < limits.maxResident;
  };

  const reserveLoader = (idValue, options = {}) => {
    const id = normalizeId(idValue);
    if (!canReserveLoader(id, options)) return null;

    const lease = makeLease("loader", id);
    loadersById.set(id, lease);
    return lease;
  };

  const queueLoader = (idValue, options = {}, onGranted) => {
    const id = normalizeId(idValue);
    if (!id || typeof onGranted !== "function") return null;

    const waiterLease = makeLease("loader-waiter", id);
    loaderWaiters.set(waiterLease.token, {
      id,
      lease: waiterLease,
      options: {},
      priority: finiteLimit(options.priority, 0),
      onGranted,
    });
    scheduleLoaderPump();
    return waiterLease;
  };

  const cancelQueuedLoader = (waiterLease) => {
    if (
      !waiterLease ||
      waiterLease.kind !== "loader-waiter" ||
      waiterLease.scope !== scope
    ) {
      return false;
    }
    return loaderWaiters.delete(waiterLease.token);
  };

  const blockIds = (ids = []) => {
    let changed = false;
    for (const value of ids || []) {
      const id = normalizeId(value);
      if (id && !blockedIds.has(id)) {
        blockedIds.add(id);
        changed = true;
      }
    }
    return changed;
  };

  const unblockIds = (ids = []) => {
    let changed = false;
    for (const value of ids || []) {
      const id = normalizeId(value);
      if (id && blockedIds.delete(id)) changed = true;
    }
    if (changed) scheduleLoaderPump();
    return changed;
  };

  const discardIds = (ids = []) => {
    const discarded = new Set(
      Array.from(ids || [], normalizeId).filter(Boolean)
    );
    if (!discarded.size) return false;
    let changed = false;
    for (const id of discarded) {
      if (releaseId(id)) changed = true;
      if (blockedIds.delete(id)) changed = true;
    }
    for (const [token, waiter] of loaderWaiters) {
      if (discarded.has(waiter.id)) {
        loaderWaiters.delete(token);
        changed = true;
      }
    }
    if (changed) scheduleLoaderPump();
    return changed;
  };

  const markLoaderReady = (lease) => {
    if (!isCurrentLoader(lease)) return null;
    loadersById.delete(lease.id);
    residentsById.set(lease.id, lease);
    scheduleLoaderPump();
    return lease;
  };

  const failLoader = (lease) => {
    if (!isCurrentLoader(lease)) return false;
    loadersById.delete(lease.id);
    scheduleLoaderPump();
    return true;
  };

  const releaseResident = (lease) => {
    if (!isCurrentResident(lease)) return false;
    releaseDecoderForId(lease.id, lease.token);
    residentsById.delete(lease.id);
    scheduleLoaderPump();
    return true;
  };

  const releaseMedia = (lease) => {
    if (isCurrentLoader(lease)) {
      loadersById.delete(lease.id);
      scheduleLoaderPump();
      return true;
    }
    return releaseResident(lease);
  };

  const releaseId = (idValue) => {
    const id = normalizeId(idValue);
    if (!id) return false;
    let changed = false;
    if (loadersById.delete(id)) changed = true;
    const resident = residentsById.get(id);
    if (resident) {
      releaseDecoderForId(id, resident.token);
      residentsById.delete(id);
      changed = true;
    } else if (releaseDecoderForId(id)) {
      changed = true;
    }
    if (changed) scheduleLoaderPump();
    return changed;
  };

  const reserveDecoder = (idValue) => {
    const id = normalizeId(idValue);
    if (!id || limits.maxDecoders <= 0) return null;
    const resident = residentsById.get(id);
    if (!resident) return null;

    const existing = decodersById.get(id);
    if (
      existing?.ownerToken === resident.token &&
      !stoppingDecoderIds.has(id)
    ) {
      return existing;
    }
    if (existing && stoppingDecoderIds.has(id)) return null;
    if (existing) decodersById.delete(id);
    if (decodersById.size >= limits.maxDecoders) return null;

    const lease = makeLease("decoder", id, resident.token);
    decodersById.set(id, lease);
    return lease;
  };

  const requestDecoderStop = (lease) => {
    if (!isCurrentDecoder(lease)) return false;
    stoppingDecoderIds.add(lease.id);
    return true;
  };

  const acknowledgeDecoderStopped = (lease) => {
    if (!isCurrentDecoder(lease)) return false;
    decodersById.delete(lease.id);
    stoppingDecoderIds.delete(lease.id);
    return true;
  };

  const releaseDecoder = (lease) => {
    if (isCurrentDecoder(lease)) {
      decodersById.delete(lease.id);
      stoppingDecoderIds.delete(lease.id);
      return true;
    }
    if (isCurrentExternalDecoder(lease)) {
      externalDecodersById.delete(lease.id);
      return true;
    }
    if (isCurrentAuxiliaryDecoder(lease)) {
      auxiliaryDecodersById.delete(lease.id);
      return true;
    }
    return false;
  };

  // Fullscreen has a dedicated single-owner lane, separate from the grid and
  // from bounded one-shot action media.
  const reserveExternalDecoder = (idValue) => {
    const id = normalizeId(idValue);
    if (!id || limits.maxExternalDecoders <= 0) return null;
    const existing = externalDecodersById.get(id);
    if (existing) return existing;
    if (externalDecodersById.size >= limits.maxExternalDecoders) return null;

    const lease = makeLease("external-decoder", id);
    externalDecodersById.set(id, lease);
    return lease;
  };

  const reserveAuxiliaryDecoder = (idValue) => {
    const id = normalizeId(idValue);
    if (!id || limits.maxAuxiliaryDecoders <= 0) return null;
    const existing = auxiliaryDecodersById.get(id);
    if (existing) return existing;
    if (auxiliaryDecodersById.size >= limits.maxAuxiliaryDecoders) return null;

    const lease = makeLease("auxiliary-decoder", id);
    auxiliaryDecodersById.set(id, lease);
    return lease;
  };

  const reconcileDecoders = (orderedIds = []) => {
    const desiredIds = [];
    const desiredSet = new Set();

    for (const value of orderedIds || []) {
      if (desiredIds.length >= limits.maxDecoders) break;
      const id = normalizeId(value);
      if (!id || desiredSet.has(id) || !residentsById.has(id)) continue;
      desiredSet.add(id);
      desiredIds.push(id);
    }

    for (const [id, lease] of decodersById) {
      const resident = residentsById.get(id);
      if (!desiredSet.has(id) || !resident || lease.ownerToken !== resident.token) {
        stoppingDecoderIds.add(id);
      }
    }

    for (const id of desiredIds) reserveDecoder(id);
    return new Set(
      Array.from(decodersById.keys()).filter(
        (id) => !stoppingDecoderIds.has(id) && desiredSet.has(id)
      )
    );
  };

  const reset = () => {
    scope += 1;
    loadersById.clear();
    residentsById.clear();
    decodersById.clear();
    stoppingDecoderIds.clear();
    externalDecodersById.clear();
    auxiliaryDecodersById.clear();
    loaderWaiters.clear();
    blockedIds.clear();
    return scope;
  };

  const getSnapshot = () => ({
    scope,
    limits: { ...limits },
    loadingIds: new Set(loadersById.keys()),
    queuedLoadingIds: new Set(
      Array.from(loaderWaiters.values(), (waiter) => waiter.id)
    ),
    blockedIds: new Set(blockedIds),
    residentIds: new Set(residentsById.keys()),
    decoderIds: new Set(
      Array.from(decodersById.keys()).filter(
        (id) => !stoppingDecoderIds.has(id)
      )
    ),
    stoppingDecoderIds: new Set(stoppingDecoderIds),
    externalDecoderIds: new Set(externalDecodersById.keys()),
    auxiliaryDecoderIds: new Set(auxiliaryDecodersById.keys()),
    loading: loadersById.size,
    queuedLoading: loaderWaiters.size,
    resident: residentsById.size,
    decoders: decodersById.size,
    stoppingDecoders: stoppingDecoderIds.size,
    externalDecoders: externalDecodersById.size,
    auxiliaryDecoders: auxiliaryDecodersById.size,
    totalDecoders:
      decodersById.size +
      externalDecodersById.size +
      auxiliaryDecodersById.size,
    reservedResident: residentsById.size + loadersById.size,
  });

  return Object.freeze({
    configure,
    canReserveLoader,
    reserveLoader,
    queueLoader,
    cancelQueuedLoader,
    blockIds,
    unblockIds,
    discardIds,
    markLoaderReady,
    failLoader,
    releaseMedia,
    releaseId,
    reserveDecoder,
    reserveExternalDecoder,
    reserveAuxiliaryDecoder,
    requestDecoderStop,
    acknowledgeDecoderStopped,
    releaseDecoder,
    reconcileDecoders,
    reset,
    getResidentLease: (id) => residentsById.get(normalizeId(id)) || null,
    getDecoderLease: (id) => decodersById.get(normalizeId(id)) || null,
    getExternalDecoderLease: (id) =>
      externalDecodersById.get(normalizeId(id)) || null,
    getAuxiliaryDecoderLease: (id) =>
      auxiliaryDecodersById.get(normalizeId(id)) || null,
    getSnapshot,
    isCurrentMediaLease: (lease) =>
      isCurrentLoader(lease) || isCurrentResident(lease),
  });
}

export default createMediaSlotScheduler;
