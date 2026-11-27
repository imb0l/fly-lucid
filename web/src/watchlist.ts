export const WATCH_KEY = 'fly.watch.v1';

export interface WatchItem {
  origin: string;
  dest: string;
  date: string;
  at: string;
  flightNo: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AT_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const SAVE_FAILED = 'Changes could not be saved — browser storage is blocked or full.';
const READ_FAILED = 'The saved watchlist could not be read — browser storage is unavailable.';

let lastStorageError: string | null = null;

/**
 * Non-null when the most recent watchlist read or write could not reach
 * localStorage. Mutating helpers still return the in-memory list so the page
 * keeps working; callers should surface this so users know changes are lost.
 */
export function getWatchlistStorageError(): string | null {
  return lastStorageError;
}

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isWatchItem(value: unknown): value is WatchItem {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    isNonEmpty(v.origin) &&
    isNonEmpty(v.dest) &&
    isNonEmpty(v.date) &&
    isNonEmpty(v.at) &&
    isNonEmpty(v.flightNo) &&
    isRealDate(v.date.trim()) &&
    AT_RE.test(v.at.trim())
  );
}

export function watchKey(item: WatchItem): string {
  return JSON.stringify([
    item.origin.trim().toUpperCase(),
    item.dest.trim().toUpperCase(),
    item.date.trim(),
    item.at.trim(),
    item.flightNo.trim().toUpperCase(),
  ]);
}

function normalize(item: WatchItem): WatchItem {
  return {
    origin: item.origin.trim().toUpperCase(),
    dest: item.dest.trim().toUpperCase(),
    date: item.date.trim(),
    at: item.at.trim(),
    flightNo: item.flightNo.trim().toUpperCase(),
  };
}

function clean(items: unknown[]): WatchItem[] {
  const seen = new Set<string>();
  const out: WatchItem[] = [];
  for (const item of items) {
    if (!isWatchItem(item)) continue;
    const normalized = normalize(item);
    const key = watchKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

/** Returns true when the list reached localStorage. */
function persist(items: WatchItem[]): boolean {
  try {
    window.localStorage.setItem(WATCH_KEY, JSON.stringify(items));
    lastStorageError = null;
    return true;
  } catch {
    lastStorageError = SAVE_FAILED;
    return false;
  }
}

/** Reads and normalizes stored items without writing back. */
function readItems(): WatchItem[] {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(WATCH_KEY);
  } catch {
    lastStorageError = READ_FAILED;
    return [];
  }
  lastStorageError = null;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? clean(parsed) : [];
  } catch {
    return [];
  }
}

export function loadWatchlist(): WatchItem[] {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(WATCH_KEY);
  } catch {
    lastStorageError = READ_FAILED;
    return [];
  }
  lastStorageError = null;
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (persist([])) lastStorageError = 'The saved watchlist was unreadable, so it was reset.';
    return [];
  }

  const items = Array.isArray(parsed) ? clean(parsed) : [];
  // Heal the stored copy once when entries were invalid, unnormalized or duplicated.
  if (JSON.stringify(items) !== raw) persist(items);
  return items;
}

/** Replaces the stored list after validation; returns the stored items. */
export function replaceWatchlist(items: WatchItem[]): WatchItem[] {
  const valid = clean(items);
  persist(valid);
  return valid;
}

export function removePastWatchItems(items: WatchItem[], today: string): WatchItem[] {
  return replaceWatchlist(items.filter((item) => item.date >= today));
}

export function addWatchItem(item: WatchItem): WatchItem[] {
  const items = readItems();
  // Never overwrite a list we could not read back.
  if (lastStorageError === READ_FAILED) return items;
  if (!isWatchItem(item)) return items;
  const normalized = normalize(item);
  const key = watchKey(normalized);
  if (items.some((existing) => watchKey(existing) === key)) return items;
  const next = [...items, normalized];
  persist(next);
  return next;
}

export function removeWatchItem(item: WatchItem): WatchItem[] {
  const key = watchKey(normalize(item));
  const items = readItems();
  // Never overwrite a list we could not read back.
  if (lastStorageError === READ_FAILED) return items;
  const next = items.filter((existing) => watchKey(existing) !== key);
  persist(next);
  return next;
}
