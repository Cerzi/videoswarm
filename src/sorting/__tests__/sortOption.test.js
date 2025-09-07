import { describe, it, expect } from 'vitest';
import { SortKey } from '../sorting.js';
import { parseSortValue, formatSortValue } from '../sortOption.js';

describe('sort option helpers', () => {
  const cases = [
    { value: 'name-asc', key: SortKey.NAME, dir: 'asc' },
    { value: 'name-desc', key: SortKey.NAME, dir: 'desc' },
    { value: 'created-asc', key: SortKey.CREATED, dir: 'asc' },
    { value: 'created-desc', key: SortKey.CREATED, dir: 'desc' },
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
