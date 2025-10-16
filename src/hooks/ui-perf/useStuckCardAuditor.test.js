import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useStuckCardAuditor from './useStuckCardAuditor';

describe('useStuckCardAuditor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds candidates when triggerAudit runs', () => {
    const getCandidates = vi.fn(() => ['a', 'b']);
    const { result } = renderHook(() =>
      useStuckCardAuditor({
        getCandidates,
        loadedIds: new Set(),
        loadingIds: new Set(),
        throttleMs: 0,
      })
    );

    act(() => {
      const added = result.current.triggerAudit({ force: true });
      expect(added).toBe(true);
    });

    expect(result.current.forcedMap.get('a')).toBe(1);
    expect(result.current.forcedMap.get('b')).toBe(1);
  });

  it('throttles repeated audits unless forced', () => {
    const getCandidates = vi.fn(() => ['x']);
    const { result } = renderHook(() =>
      useStuckCardAuditor({
        getCandidates,
        loadedIds: new Set(),
        loadingIds: new Set(),
        throttleMs: 500,
      })
    );

    act(() => {
      result.current.triggerAudit({ force: true });
    });
    expect(result.current.forcedMap.get('x')).toBe(1);

    act(() => {
      const added = result.current.triggerAudit();
      expect(added).toBe(false);
    });
    expect(result.current.forcedMap.get('x')).toBe(1);

    vi.advanceTimersByTime(600);

    act(() => {
      const added = result.current.triggerAudit();
      expect(added).toBe(true);
    });
    expect(result.current.forcedMap.get('x')).toBe(2);
  });

  it('prunes entries once they are loading or loaded', () => {
    const getCandidates = vi.fn(() => ['z']);
    const { result, rerender } = renderHook(
      (props) => useStuckCardAuditor(props),
      {
        initialProps: {
          getCandidates,
          loadedIds: new Set(),
          loadingIds: new Set(),
          throttleMs: 0,
        },
      }
    );

    act(() => {
      result.current.triggerAudit({ force: true });
    });
    expect(result.current.forcedMap.get('z')).toBe(1);

    rerender({
      getCandidates,
      loadedIds: new Set(['z']),
      loadingIds: new Set(),
      throttleMs: 0,
    });

    expect(result.current.forcedMap.has('z')).toBe(false);

    act(() => {
      result.current.triggerAudit({ force: true });
    });
    expect(result.current.forcedMap.get('z')).toBeUndefined();

    rerender({
      getCandidates,
      loadedIds: new Set(),
      loadingIds: new Set(['z']),
      throttleMs: 0,
    });

    expect(result.current.forcedMap.has('z')).toBe(false);
  });
});
