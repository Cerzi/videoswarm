import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { runProfileOwnedOperation } = require('../profile-owned-operation');

describe('profile-owned synchronous operations', () => {
  it('runs against the captured store and returns its profile generation', () => {
    const metadataStore = { name: 'profile-a-store' };
    const assertContextActive = vi.fn();
    const operation = vi.fn((store) => ({ value: store.name }));

    const result = runProfileOwnedOperation({
      captureContext: () => ({
        profileId: 'profile-a',
        generation: 7,
        metadataStore,
      }),
      assertContextActive,
      operation,
    });

    expect(result).toEqual({
      success: true,
      profileId: 'profile-a',
      generation: 7,
      value: 'profile-a-store',
    });
    expect(operation).toHaveBeenCalledWith(metadataStore, expect.any(Object));
    expect(assertContextActive).toHaveBeenCalledTimes(2);
  });

  it('does not invoke a mutation while profile configuration is invalidated', () => {
    const operation = vi.fn();
    const profileSwitchError = Object.assign(
      new Error('Profile configuration is changing'),
      { code: 'DIRECTORY_SCAN_CANCELLED' }
    );

    const result = runProfileOwnedOperation({
      captureContext: () => {
        throw profileSwitchError;
      },
      assertContextActive: vi.fn(),
      operation,
      getFallbackProfileId: () => 'profile-b',
      getFallbackGeneration: () => 8,
      defaultErrorCode: 'REVIEW_STATE_ERROR',
    });

    expect(operation).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      profileId: 'profile-b',
      generation: 8,
      code: 'DIRECTORY_SCAN_CANCELLED',
      error: 'Profile configuration is changing',
    });
  });

  it('discards a synchronous result invalidated immediately after the store call', () => {
    let active = true;
    const invalidated = Object.assign(new Error('Generation changed'), {
      code: 'DIRECTORY_SCAN_CANCELLED',
    });

    const result = runProfileOwnedOperation({
      captureContext: () => ({
        profileId: 'profile-a',
        generation: 7,
        metadataStore: { value: 42 },
      }),
      assertContextActive: () => {
        if (!active) throw invalidated;
      },
      operation: (store) => {
        active = false;
        return { value: store.value };
      },
    });

    expect(result).toMatchObject({
      success: false,
      profileId: 'profile-a',
      generation: 7,
      code: 'DIRECTORY_SCAN_CANCELLED',
    });
    expect(result).not.toHaveProperty('value');
  });
});
