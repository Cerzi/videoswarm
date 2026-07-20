import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  REVIEW_SESSION_FLUSH_REQUEST_CHANNEL,
  REVIEW_SESSION_FLUSH_TIMEOUT_MS,
  createReviewSessionFlushCoordinator,
} = require('../review-session-flush');

function owner(id = 1) {
  return { id, isDestroyed: vi.fn(() => false) };
}

function fixture(options = {}) {
  let sequence = 0;
  const sendRequest = vi.fn();
  const coordinator = createReviewSessionFlushCoordinator({
    createRequestId: () => `token-${++sequence}`,
    sendRequest,
    ...options,
  });
  return { coordinator, sendRequest };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('review-session lifecycle flush coordinator', () => {
  it('sends a frozen one-use token and accepts only its live owner', async () => {
    const firstOwner = owner(1);
    const otherOwner = owner(2);
    const { coordinator, sendRequest } = fixture();
    const pending = coordinator.request(firstOwner);
    const [, channel, payload] = sendRequest.mock.calls[0];

    expect(channel).toBe(REVIEW_SESSION_FLUSH_REQUEST_CHANNEL);
    expect(payload).toEqual({ requestId: 'token-1' });
    expect(Object.isFrozen(payload)).toBe(true);
    expect(coordinator.acknowledge(otherOwner, payload.requestId)).toBe(false);
    expect(coordinator.acknowledge(firstOwner, 'wrong')).toBe(false);
    expect(coordinator.acknowledge(firstOwner, payload.requestId)).toBe(true);
    await expect(pending).resolves.toMatchObject({
      requested: true,
      acknowledged: true,
      reason: 'acknowledged',
    });
    expect(coordinator.acknowledge(firstOwner, payload.requestId)).toBe(false);
    expect(coordinator.getSnapshot()).toMatchObject({ pending: false });
  });

  it('times out at 750 ms and rejects a late acknowledgement', async () => {
    vi.useFakeTimers();
    const activeOwner = owner();
    const { coordinator, sendRequest } = fixture();
    const pending = coordinator.request(activeOwner);
    const token = sendRequest.mock.calls[0][2].requestId;

    await vi.advanceTimersByTimeAsync(REVIEW_SESSION_FLUSH_TIMEOUT_MS - 1);
    expect(coordinator.isPendingOwner(activeOwner)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({
      acknowledged: false,
      reason: 'timeout',
    });
    expect(coordinator.acknowledge(activeOwner, token)).toBe(false);
  });

  it('single-flights one owner and never replaces it with another owner', async () => {
    const firstOwner = owner(1);
    const secondOwner = owner(2);
    const { coordinator, sendRequest } = fixture();
    const first = coordinator.request(firstOwner);
    const duplicate = coordinator.request(firstOwner);
    const busy = coordinator.request(secondOwner);

    expect(duplicate).toBe(first);
    await expect(busy).resolves.toMatchObject({ requested: false, reason: 'busy' });
    expect(sendRequest).toHaveBeenCalledTimes(1);
    coordinator.acknowledge(firstOwner, 'token-1');
    await first;

    const next = coordinator.request(firstOwner);
    expect(sendRequest.mock.calls[1][2]).toEqual({ requestId: 'token-2' });
    coordinator.acknowledge(firstOwner, 'token-2');
    await next;
  });

  it('settles unavailable, destroyed, send-failed, cancelled, and closed owners', async () => {
    const destroyed = owner();
    destroyed.isDestroyed.mockReturnValue(true);
    const { coordinator } = fixture();
    await expect(coordinator.request(null)).resolves.toMatchObject({
      requested: false,
      reason: 'owner-unavailable',
    });
    await expect(coordinator.request(destroyed)).resolves.toMatchObject({
      requested: false,
      reason: 'owner-unavailable',
    });

    const idFailure = fixture({
      createRequestId: () => { throw new Error('entropy unavailable'); },
    });
    await expect(idFailure.coordinator.request(owner())).resolves.toMatchObject({
      requested: false,
      reason: 'request-id-failed',
    });

    const sendError = new Error('send failed');
    const failing = fixture({ sendRequest: () => { throw sendError; } });
    await expect(failing.coordinator.request(owner())).resolves.toMatchObject({
      requested: true,
      reason: 'send-failed',
      error: sendError,
    });

    const activeOwner = owner(3);
    const pending = coordinator.request(activeOwner);
    expect(coordinator.cancelOwner(activeOwner)).toBe(true);
    await expect(pending).resolves.toMatchObject({ reason: 'owner-cancelled' });
    expect(coordinator.close()).toBe(true);
    expect(coordinator.close()).toBe(false);
    await expect(coordinator.request(activeOwner)).resolves.toMatchObject({
      requested: false,
      reason: 'closed',
    });
  });
});
