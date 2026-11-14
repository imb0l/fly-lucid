import type { Db } from '../db/db.js';

/** Observed departure history used for every forecast. */
export const LOOKBACK_DAYS = 28;
/** Minimum departures required before a flight is forecastable. */
export const MIN_SAMPLES = 5;
/** Score window starts this many minutes before the requested time. */
export const WINDOW_BEFORE_MIN = 30;
/** Score window ends this many minutes after the requested time. */
export const WINDOW_AFTER_MIN = 60;
/** Turnaround used when an airline has too little observed ground time. */
export const DEFAULT_TURNAROUND_MIN = 45;
/** Lower bound for the inbound aircraft's speed when estimating its ETA. */
export const MIN_GROUND_SPEED_KT = 150;
/** A feed older than this makes live tail adjustment unsafe. */
export const FEED_STALE_SEC = 180;
/** Search dates further ahead than this are not supported. */
export const MAX_DAYS_AHEAD = 60;

/** Maximum number of ranked candidates returned by `forecast`. */
const MAX_CANDIDATES = 10;
/** Aircraft states must be at least this fresh to drive tail adjustment. */
const STATE_FRESH_SEC = 120;
/** Exponential recency half-life (in days) for weighting observed departures. */
export const RECENCY_HALF_LIFE_DAYS = 1.8;
/** Minimum and maximum half-widths (minutes) for the tightened [p10, p90] window. */
const MIN_HALF_WINDOW_MIN = 12;
const MAX_HALF_LOW_MIN = 26;
const MAX_HALF_HIGH_MIN = 30;
/** Typical domestic cruise ground speed (knots) when estimating outstation transit. */
const CRUISE_SPEED_KT = 340;
/** Seconds in a day. */
const DAY_SEC = 86_400;
/** Africa/Lagos (WAT) is a fixed UTC+1 offset. */
const WAT_OFFSET_SEC = 3600;
/** Earth radius in nautical miles. */
const EARTH_RADIUS_NM = 3440.065;
export type TailStatus = 'inbound' | 'inbound_other_day' | 'not_inbound' | 'unknown';

export interface TailInfo {
  reg: string | null;
  status: TailStatus;
  adjusted: boolean;
}

export interface ForecastCandidate {
  flightNo: string;
  airline: string | null;
  score: number;
  n: number;
  p10: number;
  p50: number;
  p90: number;
  tail: TailInfo;
}

export interface InsufficientFlight {
  flightNo: string;
  n: number;
}

export interface ForecastResult {
  candidates: ForecastCandidate[];
  insufficient: InsufficientFlight[];
}

export interface ForecastInput {
  origin: string;
  dest: string;
  /** WAT calendar date, `YYYY-MM-DD`. */
  dateWat: string;
  /** Requested departure minute-of-day WAT, 0..1439. */
  atMin: number;
  nowSec: number;
  /** True when the live feed is older than `FEED_STALE_SEC`. */
  feedStale: boolean;
}

/** Format a timestamp as a WAT calendar date, `YYYY-MM-DD`. */
export function watDateStr(ts: number): string {
  const d = new Date((Math.floor(ts) + WAT_OFFSET_SEC) * 1000);
  const year = d.getUTCFullYear().toString().padStart(4, '0');
  const month = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Minute of the WAT day (0..1439) for a UTC epoch-seconds timestamp. */
export function minuteOfDayWat(ts: number): number {
  const secondsOfDay =
    (((Math.floor(ts) + WAT_OFFSET_SEC) % DAY_SEC) + DAY_SEC) % DAY_SEC;
  return Math.floor(secondsOfDay / 60);
}

/** The WAT calendar date of "now", `YYYY-MM-DD`. */
export function todayWat(nowSec: number): string {
  return watDateStr(nowSec);
}

/** Mon–Fri is `weekday`, Sat–Sun is `weekend`, judged by the WAT date. */
export function weekdayGroup(dateStrWat: string): 'weekday' | 'weekend' {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStrWat);
  if (match === null) {
    throw new Error(`invalid WAT date: ${dateStrWat}`);
  }
  const day = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  ).getUTCDay();
  return day === 0 || day === 6 ? 'weekend' : 'weekday';
}

/**
 * Nearest-rank percentile over an ascending array. The index is
 * `ceil(p × n) − 1`, clamped to the array bounds. `p` must be in (0, 1].
 */
export function percentileNearestRank(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) {
    throw new RangeError('percentileNearestRank requires a non-empty array');
  }
  if (!(p > 0 && p <= 1)) {
    throw new RangeError(`percentile must be in (0, 1], got ${p}`);
  }
  const index = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil(p * sortedAsc.length) - 1),
  );
  const value = sortedAsc[index];
  if (value === undefined) {
    throw new RangeError('percentile index out of bounds');
  }
  return value;
}

/**
 * Fraction of samples inside `[at − 30, at + 60]` minutes-of-day. The window
 * is clipped to `[0, 1439]` and never wraps around midnight.
 */
export function scoreWindow(samples: number[], at: number): number {
  if (samples.length === 0) {
    return 0;
  }
  const lower = Math.max(0, at - WINDOW_BEFORE_MIN);
  const upper = Math.min(1439, at + WINDOW_AFTER_MIN);
  let hits = 0;
  for (const sample of samples) {
    if (sample >= lower && sample <= upper) {
      hits += 1;
    }
  }
  return hits / samples.length;
}

/** Clamp every sample to be no earlier than the aircraft is ready. */
export function floorToReady(samples: number[], readyMin: number): number[] {
  return samples.map((sample) => Math.max(sample, readyMin));
}

/** Great-circle distance in nautical miles. */
export function haversineNm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

interface DepSampleRow {
  ts: number;
}

/**
 * Departure timestamps for one flight number on one route since `sinceTs`.
 * SQL filters kind/airport/dest/flt/time; the optional weekday group is
 * filtered in JS from the WAT date of each timestamp.
 */
export function depSamples(
  db: Db,
  originCode: string,
  destCode: string,
  flt: string,
  sinceTs: number,
  group: 'weekday' | 'weekend' | null,
): number[] {
  const rows = db
    .prepare<
      { origin: string; dest: string; flt: string; since: number },
      DepSampleRow
    >(
      "SELECT ts FROM events WHERE kind='DEP' AND airport = :origin AND dest = :dest AND flt = :flt AND ts >= :since",
    )
    .all({ origin: originCode, dest: destCode, flt, since: sinceTs });

  const samples: number[] = [];
  for (const row of rows) {
    if (group !== null && weekdayGroup(watDateStr(row.ts)) !== group) {
      continue;
    }
    samples.push(row.ts);
  }
  return samples;
}

/** Distinct flight numbers with at least one DEP on the route since `sinceTs`. */
export function routeFlights(
  db: Db,
  origin: string,
  dest: string,
  sinceTs: number,
): string[] {
  const rows = db
    .prepare<{ origin: string; dest: string; since: number }, { flt: string }>(
      "SELECT DISTINCT flt FROM events WHERE kind='DEP' AND airport = :origin AND dest = :dest AND flt IS NOT NULL AND ts >= :since ORDER BY flt ASC",
    )
    .all({ origin, dest, since: sinceTs });
  return rows.map((row) => row.flt);
}

interface TurnaroundRow {
  hex: string;
  kind: 'ARR' | 'DEP';
  airline: string | null;
  ts: number;
}

/**
 * Median observed turnaround (minutes) for an airline at an airport: each ARR
 * is paired with the next DEP of the same tail at that airport, keeping gaps
 * between 10 and 720 minutes. Falls back to `DEFAULT_TURNAROUND_MIN` when
 * fewer than `MIN_SAMPLES` pairs exist.
 */
export function turnaroundMedianMin(
  db: Db,
  airport: string,
  airline: string,
  sinceTs: number,
): number {
  const rows = db
    .prepare<{ airport: string; since: number }, TurnaroundRow>(
      "SELECT hex, kind, airline, ts FROM events WHERE airport = :airport AND kind IN ('ARR','DEP') AND ts >= :since ORDER BY hex ASC, ts ASC, id ASC",
    )
    .all({ airport, since: sinceTs });

  const arrivals = new Map<string, TurnaroundRow[]>();
  const departures = new Map<string, TurnaroundRow[]>();
  for (const row of rows) {
    const bucket = row.kind === 'ARR' ? arrivals : departures;
    const list = bucket.get(row.hex);
    if (list === undefined) {
      bucket.set(row.hex, [row]);
    } else {
      list.push(row);
    }
  }

  const gaps: number[] = [];
  for (const [hex, arrs] of arrivals) {
    const deps = departures.get(hex);
    if (deps === undefined) {
      continue;
    }
    let depIndex = 0;
    for (const arr of arrs) {
      while (depIndex < deps.length) {
        const candidate = deps[depIndex];
        if (candidate !== undefined && candidate.ts > arr.ts) {
          break;
        }
        depIndex += 1;
      }
      const dep = deps[depIndex];
      if (dep === undefined) {
        break;
      }
      const gapMin = (dep.ts - arr.ts) / 60;
      if (gapMin < 10 || gapMin > 720) {
        continue;
      }
      if ((dep.airline ?? arr.airline) !== airline) {
        continue;
      }
      gaps.push(gapMin);
    }
  }

  if (gaps.length < MIN_SAMPLES) {
    return DEFAULT_TURNAROUND_MIN;
  }
  gaps.sort((left, right) => left - right);
  const middle = Math.floor(gaps.length / 2);
  if (gaps.length % 2 === 1) {
    return gaps[middle] ?? DEFAULT_TURNAROUND_MIN;
  }
  const lower = gaps[middle - 1];
  const upper = gaps[middle];
  if (lower === undefined || upper === undefined) {
    return DEFAULT_TURNAROUND_MIN;
  }
  return (lower + upper) / 2;
}

interface LatestDepRow {
  reg: string | null;
  airline: string | null;
}

interface StateRow {
  lat: number;
  lon: number;
  gs_kt: number | null;
  on_ground: number;
  dest: string | null;
  updated_at: number;
}

interface AirportRow {
  lat: number | null;
  lon: number | null;
}

function latestDeparture(
  db: Db,
  origin: string,
  dest: string,
  flt: string,
  sinceTs: number,
): LatestDepRow | undefined {
  return db
    .prepare<
      { origin: string; dest: string; flt: string; since: number },
      LatestDepRow
    >(
      "SELECT reg, airline FROM events WHERE kind='DEP' AND airport = :origin AND dest = :dest AND flt = :flt AND ts >= :since ORDER BY ts DESC LIMIT 1",
    )
    .get({ origin, dest, flt, since: sinceTs });
}

export interface WeightedDepSample {
  ts: number;
  min: number;
  clampedMin: number;
  w: number;
}

function weightedQuantile(
  items: readonly WeightedDepSample[],
  key: 'min' | 'clampedMin',
  q: number,
): number {
  if (items.length === 0) {
    throw new RangeError('weightedQuantile requires a non-empty array');
  }
  const sorted = [...items].sort((left, right) => left[key] - right[key]);
  const totalW = sorted.reduce((sum, item) => sum + item.w, 0);
  if (totalW <= 0) {
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]![key];
  }
  const target = q * totalW;
  let acc = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const cur = sorted[i]!;
    const prev = acc;
    acc += cur.w;
    if (acc >= target) {
      if (i === 0) {
        return cur[key];
      }
      const prevItem = sorted[i - 1]!;
      const frac = cur.w > 0 ? (target - prev) / cur.w : 0;
      return Math.round(prevItem[key] + frac * (cur[key] - prevItem[key]));
    }
  }
  return sorted[sorted.length - 1]![key];
}

/**
 * Build recency-weighted, MAD-Winsorized departure samples and compute a
 * momentum-adjusted p50 plus a tight [p10, p90] likely takeoff interval.
 */
export function estimateTightForecast(
  timestamps: readonly number[],
  readyFloorMin: number | null,
  atMin: number,
): { p10: number; p50: number; p90: number; score: number } {
  const byNewest = [...timestamps].sort((left, right) => right - left);
  const newestTs = byNewest[0] ?? 0;

  const rawItems: WeightedDepSample[] = byNewest.map((ts) => {
    const rawMin = minuteOfDayWat(ts);
    const min = readyFloorMin === null ? rawMin : Math.max(rawMin, readyFloorMin);
    const ageDays = Math.max(0, (newestTs - ts) / DAY_SEC);
    const w = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
    return { ts, min, clampedMin: min, w };
  });

  const recMed = weightedQuantile(rawItems, 'min', 0.5);
  const devItems: WeightedDepSample[] = rawItems.map((item) => ({
    ...item,
    min: Math.abs(item.min - recMed),
  }));
  const recMad = Math.max(10, weightedQuantile(devItems, 'min', 0.5));
  const trimBand = Math.max(22, Math.min(50, Math.round(2.0 * recMad)));

  const trimmed: WeightedDepSample[] = rawItems.map((item) => ({
    ...item,
    clampedMin: Math.max(recMed - trimBand, Math.min(recMed + trimBand, item.min)),
  }));

  const coreMed = weightedQuantile(trimmed, 'clampedMin', 0.5);

  let recentMean = coreMed;
  let olderMean = coreMed;
  if (trimmed.length >= 4) {
    const first = trimmed[0]!;
    const second = trimmed[1]!;
    const recentW = first.w + second.w;
    recentMean =
      recentW > 0
        ? (first.clampedMin * first.w + second.clampedMin * second.w) / recentW
        : coreMed;
    const older = trimmed.slice(2);
    const olderW = older.reduce((sum, item) => sum + item.w, 0);
    olderMean =
      olderW > 0
        ? older.reduce((sum, item) => sum + item.clampedMin * item.w, 0) / olderW
        : coreMed;
  }

  const momentum = Math.max(-28, Math.min(32, Math.round(0.35 * (recentMean - olderMean))));
  const baseP50 = Math.round(0.65 * recentMean + 0.35 * coreMed + 0.25 * momentum);
  const flooredP50 = readyFloorMin === null ? baseP50 : Math.max(baseP50, readyFloorMin);
  const p50 = Math.max(0, Math.min(1439, flooredP50));

  const q20 = weightedQuantile(trimmed, 'clampedMin', 0.2);
  const q80 = weightedQuantile(trimmed, 'clampedMin', 0.8);
  const coreSpread = Math.max(0, q80 - q20);
  const halfLow =
    coreSpread === 0
      ? 0
      : Math.max(MIN_HALF_WINDOW_MIN, Math.min(MAX_HALF_LOW_MIN, Math.round(coreSpread * 0.45)));
  const halfHigh =
    coreSpread === 0
      ? 0
      : Math.max(MIN_HALF_WINDOW_MIN, Math.min(MAX_HALF_HIGH_MIN, Math.round(coreSpread * 0.55)));

  const rawP10 = Math.max(0, p50 - halfLow);
  const p10 = readyFloorMin === null ? rawP10 : Math.max(rawP10, readyFloorMin);
  const p90 = Math.min(1439, Math.max(p50, p50 + halfHigh));

  const lower = Math.max(0, atMin - WINDOW_BEFORE_MIN);
  const upper = Math.min(1439, atMin + WINDOW_AFTER_MIN);
  const totalW = trimmed.reduce((sum, item) => sum + item.w, 0);
  const hitW = trimmed.reduce(
    (sum, item) => sum + (item.clampedMin >= lower && item.clampedMin <= upper ? item.w : 0),
    0,
  );
  const score = totalW > 0 ? hitW / totalW : 0;

  return { p10, p50, p90, score };
}

/**
 * Same-day inbound tail adjustment. Returns the tail block plus an optional
 * earliest readiness minute-of-day when the assigned aircraft is inbound or
 * still at an outstation airport.
 */
function adjustForInboundTail(
  db: Db,
  input: ForecastInput,
  dep: LatestDepRow | undefined,
  latestAirline: string | null,
  sinceTs: number,
  samples: number[],
): { tail: TailInfo; samples: number[]; readyFloorMin: number | null } {
  const reg = dep?.reg ?? null;
  const unchanged: TailInfo = { reg, status: 'unknown', adjusted: false };

  // The live tail only informs same-day searches with a fresh feed.
  if (input.dateWat !== todayWat(input.nowSec) || input.feedStale || reg === null) {
    return { tail: unchanged, samples, readyFloorMin: null };
  }

  const state = db
    .prepare<{ reg: string }, StateRow>(
      'SELECT lat, lon, gs_kt, on_ground, dest, updated_at FROM aircraft_state WHERE reg = :reg ORDER BY updated_at DESC LIMIT 1',
    )
    .get({ reg });
  if (state === undefined || state.updated_at < input.nowSec - STATE_FRESH_SEC) {
    return { tail: unchanged, samples, readyFloorMin: null };
  }

  const airport = db
    .prepare<{ iata: string }, AirportRow>(
      'SELECT lat, lon FROM airports WHERE iata = :iata',
    )
    .get({ iata: input.origin });
  if (airport === undefined || airport.lat === null || airport.lon === null) {
    return { tail: { reg, status: 'not_inbound', adjusted: false }, samples, readyFloorMin: null };
  }

  const distNm = haversineNm(state.lat, state.lon, airport.lat, airport.lon);
  const turnaroundMin =
    latestAirline === null
      ? DEFAULT_TURNAROUND_MIN
      : turnaroundMedianMin(db, input.origin, latestAirline, sinceTs);

  // Case 1: Airborne and headed to origin.
  if (
    state.on_ground === 0 &&
    state.dest === input.origin &&
    state.gs_kt !== null &&
    state.gs_kt > 0
  ) {
    const speedKt = Math.max(state.gs_kt, MIN_GROUND_SPEED_KT);
    const etaSec = input.nowSec + (distNm / speedKt) * 3600;
    const readyTs = Math.floor(etaSec + turnaroundMin * 60);
    if (watDateStr(readyTs) !== input.dateWat) {
      return { tail: { reg, status: 'inbound_other_day', adjusted: false }, samples, readyFloorMin: null };
    }
    const readyMin = minuteOfDayWat(readyTs);
    return {
      tail: { reg, status: 'inbound', adjusted: true },
      samples: floorToReady(samples, readyMin),
      readyFloorMin: readyMin,
    };
  }

  // Case 2: On the ground at an outstation airport (> 25 nm from origin):
  // must still fly to origin and complete a turnaround before departing.
  if (state.on_ground === 1 && distNm > 25) {
    const transitSec = (distNm / CRUISE_SPEED_KT) * 3600;
    const readyTs = Math.floor(input.nowSec + transitSec + turnaroundMin * 60);
    if (watDateStr(readyTs) === input.dateWat) {
      const readyMin = minuteOfDayWat(readyTs);
      return {
        tail: { reg, status: 'not_inbound', adjusted: true },
        samples: floorToReady(samples, readyMin),
        readyFloorMin: readyMin,
      };
    }
  }

  return { tail: { reg, status: 'not_inbound', adjusted: false }, samples, readyFloorMin: null };
}

/**
 * Rank the flight numbers on a route by the chance their observed actual
 * takeoff falls inside the window around `atMin`. Returns at most ten ranked
 * candidates plus every flight lacking enough history.
 */
export function forecast(db: Db, input: ForecastInput): ForecastResult {
  if (!Number.isInteger(input.atMin) || input.atMin < 0 || input.atMin > 1439) {
    throw new RangeError(`atMin must be 0..1439, got ${input.atMin}`);
  }

  const sinceTs = input.nowSec - LOOKBACK_DAYS * DAY_SEC;
  const group = weekdayGroup(input.dateWat);
  const flights = routeFlights(db, input.origin, input.dest, sinceTs);
  const candidates: ForecastCandidate[] = [];
  const insufficient: InsufficientFlight[] = [];

  for (const flightNo of flights) {
    let sampleTimestamps = depSamples(
      db,
      input.origin,
      input.dest,
      flightNo,
      sinceTs,
      group,
    );

    if (sampleTimestamps.length < MIN_SAMPLES) {
      sampleTimestamps = depSamples(
        db,
        input.origin,
        input.dest,
        flightNo,
        sinceTs,
        null,
      );
    }

    if (sampleTimestamps.length < MIN_SAMPLES) {
      insufficient.push({ flightNo, n: sampleTimestamps.length });
      continue;
    }

    const rawMinutes = sampleTimestamps.map(minuteOfDayWat).sort((left, right) => left - right);
    const dep = latestDeparture(db, input.origin, input.dest, flightNo, sinceTs);
    const latestAirline = dep?.airline ?? null;
    const adjusted = adjustForInboundTail(
      db,
      input,
      dep,
      latestAirline,
      sinceTs,
      rawMinutes,
    );
    const stats = estimateTightForecast(
      sampleTimestamps,
      adjusted.readyFloorMin,
      input.atMin,
    );

    candidates.push({
      flightNo,
      airline: latestAirline,
      score: stats.score,
      n: sampleTimestamps.length,
      p10: stats.p10,
      p50: stats.p50,
      p90: stats.p90,
      tail: adjusted.tail,
    });
  }

  candidates.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    const distance = Math.abs(left.p50 - input.atMin) - Math.abs(right.p50 - input.atMin);
    if (distance !== 0) {
      return distance;
    }
    return left.flightNo.localeCompare(right.flightNo);
  });

  insufficient.sort((left, right) => left.flightNo.localeCompare(right.flightNo));

  return { candidates: candidates.slice(0, MAX_CANDIDATES), insufficient };
}
