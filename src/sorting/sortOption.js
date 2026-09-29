import { SortKey } from './sorting.js';

export function parseSortValue(value) {
  if (value === 'random') {
    return { sortKey: SortKey.RANDOM, sortDir: 'asc' };
  }
  const [key, dir] = value.split('-');
  const sortKey = key === 'created'
    ? SortKey.CREATED
    : key === 'resolution'
      ? SortKey.RESOLUTION
      : SortKey.NAME;
  const sortDir = dir === 'desc' ? 'desc' : 'asc';
  return { sortKey, sortDir };
}

const SORT_LABELS = {
  [SortKey.NAME]: 'Name',
  [SortKey.CREATED]: 'Created',
  [SortKey.RESOLUTION]: 'Resolution',
  [SortKey.RANDOM]: 'Random',
};

// The status line's description of the current sort.
export function describeSort(sortKey, sortDir, groupByFolders) {
  const label = SORT_LABELS[sortKey] || SORT_LABELS[SortKey.NAME];
  const arrow = sortKey === SortKey.RANDOM ? '' : sortDir === 'desc' ? ' ↓' : ' ↑';
  const base = `Sorted by ${label}${arrow}`;
  return groupByFolders ? `${base} • Grouped by folders` : base;
}

export function formatSortValue(sortKey, sortDir) {
  if (sortKey === SortKey.RANDOM) return 'random';
  return `${sortKey}-${sortDir}`;
}
