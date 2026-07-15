import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  REVIEW_CHECKPOINT_DIRECTORY_LIMIT,
  normalizeCheckpointAnchorId,
  normalizeCheckpointDirectory,
  normalizeCheckpointFingerprint,
  normalizeCheckpointScope,
  normalizeCheckpointView,
} = require('../review-checkpoint');

describe('review checkpoint wire validation', () => {
  it('normalizes portable directories and rejects absolute or escaping values', () => {
    expect(normalizeCheckpointDirectory('.\\batch//nested/')).toBe('batch/nested');
    expect(() => normalizeCheckpointDirectory('../outside')).toThrowError(
      expect.objectContaining({ code: 'INVALID_REVIEW_CHECKPOINT_DIRECTORY' })
    );
    expect(() => normalizeCheckpointDirectory('C:\\outside')).toThrowError(
      expect.objectContaining({ code: 'INVALID_REVIEW_CHECKPOINT_DIRECTORY' })
    );
    expect(() => normalizeCheckpointDirectory('/outside')).toThrowError(
      expect.objectContaining({ code: 'INVALID_REVIEW_CHECKPOINT_DIRECTORY' })
    );
    expect(() => normalizeCheckpointDirectory('bad\0path')).toThrowError(
      expect.objectContaining({ code: 'INVALID_REVIEW_CHECKPOINT_DIRECTORY' })
    );
    expect(() => normalizeCheckpointDirectory(
      'x'.repeat(REVIEW_CHECKPOINT_DIRECTORY_LIMIT + 1)
    )).toThrowError(expect.objectContaining({
      code: 'INVALID_REVIEW_CHECKPOINT_DIRECTORY',
    }));
  });

  it('normalizes the saved-view allowlist without transient or unknown fields', () => {
    const { normalized } = normalizeCheckpointView({
      version: 1,
      filters: {
        includeTags: [' zeta ', 'Alpha', 'alpha', 'beta'],
        excludeTags: ['IGNORE'],
        minRating: 5,
        exactRating: 2,
        reviewFilter: 'PICK',
      },
      sort: {
        key: 'created',
        dir: 'desc',
        groupByFolders: false,
        randomSeed: 42,
      },
      zoom: 999,
      scope: { mode: 'current-folder' },
    });

    expect(normalized).toEqual({
      version: 1,
      filters: {
        includeTags: ['Alpha', 'beta', 'zeta'],
        excludeTags: ['IGNORE'],
        minRating: null,
        exactRating: 2,
        reviewFilter: 'pick',
      },
      sort: {
        key: 'created',
        dir: 'desc',
        groupByFolders: false,
        randomSeed: null,
      },
    });
    expect(normalized).not.toHaveProperty('scope');
    expect(normalized).not.toHaveProperty('zoom');
  });

  it('requires and clamps deterministic random seeds', () => {
    const randomView = {
      version: 1,
      filters: {},
      sort: { key: 'random', randomSeed: Number.NEGATIVE_INFINITY },
    };
    expect(() => normalizeCheckpointView(randomView)).toThrowError(
      expect.objectContaining({ code: 'INVALID_REVIEW_CHECKPOINT_VIEW' })
    );
    expect(normalizeCheckpointView({
      ...randomView,
      sort: { key: 'random', randomSeed: Number.MAX_VALUE },
    }).normalized.sort.randomSeed).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('validates scope and anchor identities', () => {
    expect(normalizeCheckpointScope('current-subtree')).toBe('current-subtree');
    expect(() => normalizeCheckpointScope('invalid')).toThrowError(
      expect.objectContaining({ code: 'INVALID_REVIEW_CHECKPOINT_SCOPE' })
    );
    expect(normalizeCheckpointAnchorId('42')).toBe(42);
    expect(normalizeCheckpointFingerprint(' fingerprint ')).toBe('fingerprint');
    expect(() => normalizeCheckpointAnchorId(0)).toThrowError(
      expect.objectContaining({ code: 'INVALID_REVIEW_CHECKPOINT_ANCHOR' })
    );
    expect(() => normalizeCheckpointFingerprint('x'.repeat(513))).toThrowError(
      expect.objectContaining({ code: 'INVALID_REVIEW_CHECKPOINT_ANCHOR' })
    );
  });
});
