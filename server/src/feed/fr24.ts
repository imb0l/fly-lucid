import type { Aircraft } from './types.js';

/**
 * Nigeria bounding box: bounds=north,west,south,east -> 14.0,4.0,2.5,15.0.
 * The public feed has no schedule data; every field below is an observed value.
 */
export const FEED_URL =
  'https://data-cloud.flightradar24.com/zones/fcgi/feed.js' +
  '?bounds=14.0,4.0,2.5,15.0' +
  '&faa=1&satellite=1&mlat=1&flarm=1&adsb=1&gnd=1&air=1&vehicles=0&estimated=1' +
  '&maxage=14400&gliders=0&stats=1';

export const FEED_TIMEOUT_MS = 10_000;
export const FEED_USER_AGENT = 'Mozilla/5.0';

export const BOUNDS = {
  minLat: 4.0,
  maxLat: 14.0,
  minLon: 2.5,
  maxLon: 15.0,
} as const;

export type FeedErrorKind = 'http' | 'challenge' | 'parse';

export class FeedError extends Error {
  readonly kind: FeedErrorKind;

  constructor(kind: FeedErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FeedError';
    this.kind = kind;
  }
}

/**
 * Parse the raw feed payload into Aircraft records.
 *
 * Index map (verified against the live feed):
 * 0 hex, 1 lat, 2 lon, 3 hdg, 4 alt_ft, 5 gs_kt, 8 type, 9 reg, 10 ts,
 * 11 orig, 12 dest, 13 flt, 14 gnd, 16 callsign, 18 airline.
 */
export function parseSnapshot(payload: unknown): Aircraft[] {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new FeedError('parse', 'feed payload is not an object');
  }

  const aircraft: Aircraft[] = [];

  for (const value of Object.values(payload as Record<string, unknown>)) {
    if (!Array.isArray(value) || value.length < 19) {
      continue;
    }
    const hex: unknown = value[0];
    const ts: unknown = value[10];
    if (typeof hex !== 'string' || hex.length === 0) {
      continue;
    }
    if (typeof ts !== 'number' || !Number.isInteger(ts)) {
      continue;
    }
    const lat: unknown = value[1];
    const lon: unknown = value[2];
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }
    if (lat < BOUNDS.minLat || lat > BOUNDS.maxLat || lon < BOUNDS.minLon || lon > BOUNDS.maxLon) {
      continue;
    }

    aircraft.push({
      hex,
      reg: typeof value[9] === 'string' && value[9].length > 0 ? value[9] : null,
      type: typeof value[8] === 'string' && value[8].length > 0 ? value[8] : null,
      flt: typeof value[13] === 'string' && value[13].length > 0 ? value[13] : null,
      airline: typeof value[18] === 'string' && value[18].length > 0 ? value[18] : null,
      lat,
      lon,
      altFt: typeof value[4] === 'number' && Number.isFinite(value[4]) ? Math.round(value[4]) : null,
      gsKt: typeof value[5] === 'number' && Number.isFinite(value[5]) ? Math.round(value[5]) : null,
      hdg: typeof value[3] === 'number' && Number.isFinite(value[3]) ? Math.round(value[3]) : null,
      onGround: value[14] === 1 || value[14] === true,
      orig: typeof value[11] === 'string' && value[11].length > 0 ? value[11] : null,
      dest: typeof value[12] === 'string' && value[12].length > 0 ? value[12] : null,
      ts,
    });
  }

  return aircraft;
}

export async function fetchSnapshot(url: string = FEED_URL, signal?: AbortSignal): Promise<Aircraft[]> {
  const timeout = AbortSignal.timeout(FEED_TIMEOUT_MS);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: combined,
      headers: { 'User-Agent': FEED_USER_AGENT, Accept: 'application/json' },
    });
  } catch (error) {
    if (signal?.aborted === true) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new FeedError('http', `feed request failed: ${reason}`, { cause: error });
  }

  if (!response.ok) {
    throw new FeedError('http', `feed returned HTTP ${response.status}`);
  }

  const body = await response.text();
  if (body.trimStart().startsWith('<')) {
    throw new FeedError('challenge', 'feed returned an HTML challenge page');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new FeedError('parse', 'feed returned invalid JSON', { cause: error });
  }

  return parseSnapshot(payload);
}
