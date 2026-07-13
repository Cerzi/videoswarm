const DEFAULT_LIMITS = Object.freeze({
  maxResident: 1,
  maxLoaders: 1,
  maxDecoders: 1,
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
  };

  const loadersById = new Map();
  const residentsById = new Map();
  const decodersById = new Map();

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

  const releaseDecoderForId = (id, ownerToken = null) => {
    const decoder = decodersById.get(id);
    if (!decoder) return false;
    if (ownerToken !== null && decoder.ownerToken !== ownerToken) return false;
    decodersById.delete(id);
    return true;
  };

  const configure = (nextLimits = {}) => {
    limits = {
      maxResident: finiteLimit(nextLimits.maxResident, limits.maxResident),
      maxLoaders: finiteLimit(nextLimits.maxLoaders, limits.maxLoaders),
      maxDecoders: finiteLimit(nextLimits.maxDecoders, limits.maxDecoders),
    };
    return { ...limits };
  };

  const canReserveLoader = (idValue, options = {}) => {
    const id = normalizeId(idValue);
    if (!id || loadersById.has(id) || limits.maxLoaders <= 0) return false;
    if (loadersById.size >= limits.maxLoaders) return false;

    const existingResident = residentsById.get(id);
    const replaceResident = Boolean(options.replaceResident);
    if (existingResident && !replaceResident) return false;

    // A loader owns its future resident slot from the moment it is admitted.
    // Replacing a resident is capacity-neutral; every other load must fit the
    // resident cap before any asynchronous DOM/media work begins.
    const projectedResidentUse =
      residentsById.size + loadersById.size -
      (existingResident && replaceResident ? 1 : 0);
    return projectedResidentUse < limits.maxResident;
  };

  const reserveLoader = (idValue, options = {}) => {
    const id = normalizeId(idValue);
    if (!canReserveLoader(id, options)) return null;

    const existingResident = residentsById.get(id);
    if (existingResident && options.replaceResident) {
      releaseDecoderForId(id, existingResident.token);
      residentsById.delete(id);
    }

    const lease = makeLease("loader", id);
    loadersById.set(id, lease);
    return lease;
  };

  const markLoaderReady = (lease) => {
    if (!isCurrentLoader(lease)) return null;
    loadersById.delete(lease.id);
    residentsById.set(lease.id, lease);
    return lease;
  };

  const failLoader = (lease) => {
    if (!isCurrentLoader(lease)) return false;
    loadersById.delete(lease.id);
    return true;
  };

  const releaseResident = (lease) => {
    if (!isCurrentResident(lease)) return false;
    releaseDecoderForId(lease.id, lease.token);
    residentsById.delete(lease.id);
    return true;
  };

  const releaseMedia = (lease) => {
    if (isCurrentLoader(lease)) {
      loadersById.delete(lease.id);
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
    return changed;
  };

  const reserveDecoder = (idValue) => {
    const id = normalizeId(idValue);
    if (!id || limits.maxDecoders <= 0) return null;
    const resident = residentsById.get(id);
    if (!resident) return null;

    const existing = decodersById.get(id);
    if (existing?.ownerToken === resident.token) return existing;
    if (existing) decodersById.delete(id);
    if (decodersById.size >= limits.maxDecoders) return null;

    const lease = makeLease("decoder", id, resident.token);
    decodersById.set(id, lease);
    return lease;
  };

  const releaseDecoder = (lease) => {
    if (!isCurrentDecoder(lease)) return false;
    decodersById.delete(lease.id);
    return true;
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
        decodersById.delete(id);
      }
    }

    for (const id of desiredIds) reserveDecoder(id);
    return new Set(decodersById.keys());
  };

  const retainIds = (activeIds = []) => {
    const active = new Set(
      Array.from(activeIds || [], normalizeId).filter(Boolean)
    );
    for (const id of Array.from(loadersById.keys())) {
      if (!active.has(id)) releaseId(id);
    }
    for (const id of Array.from(residentsById.keys())) {
      if (!active.has(id)) releaseId(id);
    }
  };

  const reset = () => {
    scope += 1;
    loadersById.clear();
    residentsById.clear();
    decodersById.clear();
    return scope;
  };

  const getSnapshot = () => ({
    scope,
    limits: { ...limits },
    loadingIds: new Set(loadersById.keys()),
    residentIds: new Set(residentsById.keys()),
    decoderIds: new Set(decodersById.keys()),
    loading: loadersById.size,
    resident: residentsById.size,
    decoders: decodersById.size,
    reservedResident: residentsById.size + loadersById.size,
  });

  return Object.freeze({
    configure,
    canReserveLoader,
    reserveLoader,
    markLoaderReady,
    failLoader,
    releaseMedia,
    releaseId,
    reserveDecoder,
    releaseDecoder,
    reconcileDecoders,
    retainIds,
    reset,
    getResidentLease: (id) => residentsById.get(normalizeId(id)) || null,
    getDecoderLease: (id) => decodersById.get(normalizeId(id)) || null,
    getSnapshot,
  });
}

export default createMediaSlotScheduler;
