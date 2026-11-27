const WAT_OFFSET_SEC = 3600;

/** WAT is a fixed UTC+1 with no DST, so shifting the epoch and reading UTC is exact. */
function watIso(tsSec: number): string {
  return new Date((Math.floor(tsSec) + WAT_OFFSET_SEC) * 1000).toISOString();
}

/** 'HH:MM' or 'HH:MM:SS' in WAT. */
export function fmtWatClock(tsSec: number, withSeconds = true): string {
  const iso = watIso(tsSec);
  return withSeconds ? iso.slice(11, 19) : iso.slice(11, 16);
}

/** Today's WAT calendar date as YYYY-MM-DD. */
export function todayWat(): string {
  return new Date(Date.now() + WAT_OFFSET_SEC * 1000).toISOString().slice(0, 10);
}

export function addDaysWat(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Human label for a WAT calendar date, e.g. 'Fri 14 Nov 2026'. */
export function fmtWatDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Render an ISO timestamp in fixed WAT (UTC+1), e.g. '25 Nov, 14:06 WAT'.
 * A null or unparseable value becomes an em dash.
 */
export function fmtWatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const wat = new Date(ms + WAT_OFFSET_SEC * 1000);
  const month = MONTHS_SHORT[wat.getUTCMonth()];
  const hour = String(wat.getUTCHours()).padStart(2, '0');
  const minute = String(wat.getUTCMinutes()).padStart(2, '0');
  return `${wat.getUTCDate()} ${month}, ${hour}:${minute} WAT`;
}

/** The API may give minutes-of-day or an 'HH:MM' string; accept both. */
export function fmtMinutesOfDay(value: number | string | null | undefined): string {
  if (typeof value === 'string') return value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const total = ((Math.round(value) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function fmtPercent(score: number | null | undefined): string {
  if (typeof score !== 'number' || !Number.isFinite(score)) return '—';
  return `${Math.round(score * 100)}%`;
}
