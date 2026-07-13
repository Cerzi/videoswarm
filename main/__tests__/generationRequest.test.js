import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  GENERATION_REQUEST_TOKEN_MAX_BYTES,
  normalizeGenerationRequestToken,
  createGenerationRequestIdentity,
} = require('../generation-request');

describe('generation metadata request identity', () => {
  it('accepts bounded opaque tokens and rejects malformed values', () => {
    expect(normalizeGenerationRequestToken('selection:42-abc')).toBe(
      'selection:42-abc'
    );
    expect(normalizeGenerationRequestToken(undefined)).toBeNull();
    expect(() => normalizeGenerationRequestToken(undefined, { required: true }))
      .toThrowError(expect.objectContaining({
        code: 'INVALID_GENERATION_REQUEST_TOKEN',
      }));
    expect(() => normalizeGenerationRequestToken(' padded ')).toThrowError(
      expect.objectContaining({ code: 'INVALID_GENERATION_REQUEST_TOKEN' })
    );
    expect(() => normalizeGenerationRequestToken('bad\nvalue')).toThrowError(
      expect.objectContaining({ code: 'INVALID_GENERATION_REQUEST_TOKEN' })
    );
    expect(() => normalizeGenerationRequestToken(
      'x'.repeat(GENERATION_REQUEST_TOKEN_MAX_BYTES + 1)
    )).toThrowError(expect.objectContaining({
      code: 'INVALID_GENERATION_REQUEST_TOKEN',
    }));
  });

  it('keeps explicit request owners isolated while preserving legacy scope', () => {
    const base = {
      profileId: 'profile-a',
      generation: 7,
      webContentsId: 12,
    };
    expect(createGenerationRequestIdentity(base)).toEqual({
      ownerId: 'profile-a:7:wc:12',
      scopeId: 'profile-a:7',
    });

    const first = createGenerationRequestIdentity({
      ...base,
      requestToken: 'selection-1',
    });
    const second = createGenerationRequestIdentity({
      ...base,
      requestToken: 'selection-2',
    });
    expect(first.ownerId).toBe(first.scopeId);
    expect(first.ownerId).not.toBe(second.ownerId);
    expect(first.ownerId).toContain('profile-a:7:wc:12');
  });
});
