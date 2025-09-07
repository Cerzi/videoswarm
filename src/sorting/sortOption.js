import { SortKey } from './sorting.js';

export function parseSortValue(value) {
  if (value === 'random') {
    return { sortKey: SortKey.RANDOM, sortDir: 'asc' };
  }
  const [key, dir] = value.split('-');
  const sortKey = key === 'created' ? SortKey.CREATED : SortKey.NAME;
  const sortDir = dir === 'desc' ? 'desc' : 'asc';
  return { sortKey, sortDir };
}

export function formatSortValue(sortKey, sortDir) {
  if (sortKey === SortKey.RANDOM) return 'random';
  return `${sortKey}-${sortDir}`;
}
