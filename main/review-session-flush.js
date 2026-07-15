const { randomUUID } = require('crypto');

const REVIEW_SESSION_FLUSH_TIMEOUT_MS = 750;
const REVIEW_SESSION_FLUSH_REQUEST_CHANNEL = 'review-sessions:flush-requested';
const REVIEW_SESSION_FLUSH_ACK_CHANNEL = 'review-sessions:flush-ack';

function defaultOwnerIsActive(owner) {
  return Boolean(owner) && !owner.isDestroyed?.();
}

function createReviewSessionFlushCoordinator({
  createRequestId = randomUUID,
  sendRequest,
  isOwnerActive = defaultOwnerIsActive,
  timeoutMs = REVIEW_SESSION_FLUSH_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof createRequestId !== 'function') {
    throw new TypeError('Review-session flush coordinator requires an id factory');
  }
  if (typeof sendRequest !== 'function') {
    throw new TypeError('Review-session flush coordinator requires sendRequest');
  }
  if (typeof isOwnerActive !== 'function') {
    throw new TypeError('Review-session flush coordinator requires isOwnerActive');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError('Review-session flush timeout must be non-negative');
  }

  let pending = null;
  let closed = false;

  function settle(entry, outcome) {
    if (!entry || pending !== entry) return false;
    pending = null;
    if (entry.timeoutId !== null) clearTimer(entry.timeoutId);
    entry.resolve(Object.freeze({
      requested: true,
      acknowledged: false,
      ...outcome,
    }));
    return true;
  }

  function unavailable(reason) {
    return Promise.resolve(Object.freeze({
      requested: false,
      acknowledged: false,
      reason,
    }));
  }

  function request(owner) {
    if (closed) return unavailable('closed');
    if (!isOwnerActive(owner)) return unavailable('owner-unavailable');
    if (pending) {
      return pending.owner === owner
        ? pending.promise
        : unavailable('busy');
    }

    let requestId;
    try {
      requestId = createRequestId();
    } catch {
      return unavailable('request-id-failed');
    }
    if (typeof requestId !== 'string' || !requestId || requestId.length > 256) {
      return unavailable('invalid-request-id');
    }

    let resolveRequest;
    const promise = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    const entry = {
      owner,
      requestId,
      promise,
      resolve: resolveRequest,
      timeoutId: null,
    };
    pending = entry;
    entry.timeoutId = setTimer(() => {
      settle(entry, { reason: 'timeout' });
    }, timeoutMs);

    try {
      sendRequest(
        owner,
        REVIEW_SESSION_FLUSH_REQUEST_CHANNEL,
        Object.freeze({ requestId })
      );
    } catch (error) {
      settle(entry, { reason: 'send-failed', error });
    }
    return promise;
  }

  function acknowledge(owner, requestId) {
    const entry = pending;
    if (
      !entry ||
      entry.owner !== owner ||
      entry.requestId !== requestId ||
      !isOwnerActive(owner)
    ) {
      return false;
    }
    return settle(entry, { acknowledged: true, reason: 'acknowledged' });
  }

  function isPendingOwner(owner) {
    return Boolean(
      !closed &&
      pending &&
      pending.owner === owner &&
      isOwnerActive(owner)
    );
  }

  function cancelOwner(owner) {
    if (!pending || pending.owner !== owner) return false;
    return settle(pending, { reason: 'owner-cancelled' });
  }

  function close() {
    if (closed) return false;
    closed = true;
    if (pending) settle(pending, { reason: 'closed' });
    return true;
  }

  function getSnapshot() {
    return Object.freeze({
      closed,
      pending: Boolean(pending),
      owner: pending?.owner || null,
    });
  }

  return {
    acknowledge,
    cancelOwner,
    close,
    getSnapshot,
    isPendingOwner,
    request,
  };
}

module.exports = {
  REVIEW_SESSION_FLUSH_ACK_CHANNEL,
  REVIEW_SESSION_FLUSH_REQUEST_CHANNEL,
  REVIEW_SESSION_FLUSH_TIMEOUT_MS,
  createReviewSessionFlushCoordinator,
};
