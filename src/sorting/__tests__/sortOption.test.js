import { describe, it, expect } from 'vitest';
import { SortKey } from '../sorting.js';
import { describeSort, parseSortValue, formatSortValue } from '../sortOption.js';

describe('sort option helpers', () => {
  const cases = [
    { value: 'name-asc', key: SortKey.NAME, dir: 'asc' },
    { value: 'name-desc', key: SortKey.NAME, dir: 'desc' },
    { value: 'created-asc', key: SortKey.CREATED, dir: 'asc' },
    { value: 'created-desc', key: SortKey.CREATED, dir: 'desc' },
    { value: 'rating-asc', key: SortKey.RATING, dir: 'asc' },
    { value: 'rating-desc', key: SortKey.RATING, dir: 'desc' },
    { value: 'random', key: SortKey.RANDOM, dir: 'asc' },
  ];

  cases.forEach(({ value, key, dir }) => {
    it(`parses ${value}`, () => {
      expect(parseSortValue(value)).toEqual({ sortKey: key, sortDir: dir });
    });

    it(`formats ${value}`, () => {
      expect(formatSortValue(key, dir)).toBe(value);
    });
  });
});

describe('describeSort', () => {
  it('names every sort key, so none reads as undefined', () => {
    for (const key of Object.values(SortKey)) {
      expect(describeSort(key, 'asc', false)).not.toMatch(/undefined/);
    }
    expect(describeSort(SortKey.RESOLUTION, 'desc', false)).toBe('Sorted by Resolution ↓');
    expect(describeSort(SortKey.RATING, 'desc', false)).toBe('Sorted by Rating ↓');
    expect(describeSort(SortKey.RANDOM, 'desc', true)).toBe('Sorted by Random • Grouped by folders');
    expect(describeSort(SortKey.NAME, 'asc', true)).toBe('Sorted by Name ↑ • Grouped by folders');
  });
});
