export const WATCH_KEY = 'fly.watch.v1';

export interface WatchItem {
  origin: string;
  dest: string;
  date: string;
  at: string;
  flightNo: string;
}

function isWatchItem(value: unknown): value is WatchItem {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.origin === 'string' &&
    typeof v.dest === 'string' &&
    typeof v.date === 'string' &&
    typeof v.at === 'string' &&
    typeof v.flightNo === 'string'
  );
}

export function watchKey(item: WatchItem): string {
  return [item.origin, item.dest, item.date, item.at, item.flightNo].join('|');
}

export function loadWatchlist(): WatchItem[] {
  try {
    const raw = window.localStorage.getItem(WATCH_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isWatchItem);
  } catch {
    return [];
  }
}

function persist(items: WatchItem[]): WatchItem[] {
  try {
    window.localStorage.setItem(WATCH_KEY, JSON.stringify(items));
  } catch {
    /* storage disabled or full: the caller still gets the in-memory list */
  }
  return items;
}

export function addWatchItem(item: WatchItem): WatchItem[] {
  const items = loadWatchlist();
  const key = watchKey(item);
  if (items.some((existing) => watchKey(existing) === key)) return items;
  return persist([...items, item]);
}

export function removeWatchItem(item: WatchItem): WatchItem[] {
  const key = watchKey(item);
  return persist(loadWatchlist().filter((existing) => watchKey(existing) !== key));
}
