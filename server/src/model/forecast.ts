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
export const RECENCY_HALF_LIFE_DAYS = 6.0;
/**
 * Minutes to subtract from p10 for `safeBy`, by the predicted third of day
 * (`p50`): early, midday, then evening. Calibrated to ~5% of observed
 * departures leaving before `safeBy`.
 */
export const SAFE_BY_DELTA_MIN: readonly [number, number, number] = [3, 13, 58];
/**
 * Share of the latest observed departure's residual (against the forecast p50)
 * carried into the [p10, p90] band, and the cap on that upward shift. Both are
 * pre-registered from the 25/26 Nov T-60 replay and must not be tuned.
 */
const LATEST_RESIDUAL_SLOPE = 0.25;
const LATEST_RESIDUAL_CAP_MIN = 45;
/** Half-width floor and caps (minutes) for the [p10, p90] likely-takeoff window. */
const MIN_HALF_WINDOW_MIN = 12;
const MAX_HALF_LOW_MIN = 52;
const MAX_HALF_HIGH_MIN = 62;
/** MAD multipliers calibrated to ~80% interval coverage on observed departures. */
const HALF_LOW_MAD_MULT = 2.4;
const HALF_HIGH_MAD_MULT = 3.0;
/** Typical domestic cruise ground speed (knots) when estimating outstation transit. */
const CRUISE_SPEED_KT = 340;
/** Share of an inbound arrival's lateness carried into the departure samples (fit on 8-17 Nov). */
const HISTORY_TAIL_SLOPE = 0.5;
/** Oldest arrival still treated as the aircraft's inbound leg. */
const HISTORY_TAIL_MAX_SEC = 12 * 3600;
/** Minimum gap (minutes) between sorted departure minutes that splits distinct schedule slots. */
const SLOT_CLUSTER_GAP_MIN = 90;
/** Seconds in a day. */
const DAY_SEC = 86_400;
/** Africa/Lagos (WAT) is a fixed UTC+1 offset. */
const WAT_OFFSET_SEC = 3600;
/** Earth radius in nautical miles. */
const EARTH_RADIUS_NM = 3440.065;
export type TailStatus = 'inbound' | 'inbound_other_day' | 'landed_inbound' | 'not_inbound' | 'unknown';

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
  safeBy: number;
  baseP50: number;
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
  untilTs: number,
  group: 'weekday' | 'weekend' | null,
): number[] {
  const rows = db
    .prepare<
      { origin: string; dest: string; flt: string; since: number; until: number },
      DepSampleRow
    >(
      "SELECT ts FROM events WHERE kind='DEP' AND airport = :origin AND dest = :dest AND flt = :flt AND ts >= :since AND ts < :until",
    )
    .all({ origin: originCode, dest: destCode, flt, since: sinceTs, until: untilTs });

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
  untilTs: number,
): string[] {
  const rows = db
    .prepare<{ origin: string; dest: string; since: number; until: number }, { flt: string }>(
      "SELECT DISTINCT flt FROM events WHERE kind='DEP' AND airport = :origin AND dest = :dest AND flt IS NOT NULL AND ts >= :since AND ts < :until ORDER BY flt ASC",
    )
    .all({ origin, dest, since: sinceTs, until: untilTs });
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
  untilTs: number,
): number {
  const rows = db
    .prepare<{ airport: string; since: number; until: number }, TurnaroundRow>(
      "SELECT hex, kind, airline, ts FROM events WHERE airport = :airport AND kind IN ('ARR','DEP') AND ts >= :since AND ts < :until ORDER BY hex ASC, ts ASC, id ASC",
    )
    .all({ airport, since: sinceTs, until: untilTs });

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
  flt: string | null;
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
  untilTs: number,
): LatestDepRow | undefined {
  return db
    .prepare<
      { origin: string; dest: string; flt: string; since: number; until: number },
      LatestDepRow
    >(
      "SELECT reg, airline FROM events WHERE kind='DEP' AND airport = :origin AND dest = :dest AND flt = :flt AND ts >= :since AND ts < :until ORDER BY ts DESC LIMIT 1",
    )
    .get({ origin, dest, flt, since: sinceTs, until: untilTs });
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
 *
 * The schedule slot is always chosen from every provided day first. Then, when
 * `preferredGroup` is set, observations of that weekday group inside the slot
 * are preferred, but only if they alone reach `MIN_SAMPLES`; a sparse group
 * must never erase the only evidence for a valid slot.
 */
export function estimateTightForecast(
  timestamps: readonly number[],
  readyFloorMin: number | null,
  atMin: number,
  preferredGroup: 'weekday' | 'weekend' | null = null,
): { p10: number; p50: number; p90: number; score: number; n: number } {
  const byNewest = [...timestamps].sort((left, right) => right - left);
  const newestTs = byNewest[0] ?? 0;

  const rawItems: WeightedDepSample[] = byNewest.map((ts) => {
    const rawMin = minuteOfDayWat(ts);
    const min = readyFloorMin === null ? rawMin : Math.max(rawMin, readyFloorMin);
    const ageDays = Math.max(0, (newestTs - ts) / DAY_SEC);
    const w = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
    return { ts, min, clampedMin: min, w };
  });

  const byMinAsc = [...rawItems].sort((left, right) => left.min - right.min);
  const clusters: WeightedDepSample[][] = [];
  for (const item of byMinAsc) {
    const current = clusters[clusters.length - 1];
    const prev = current?.[current.length - 1];
    if (current === undefined || prev === undefined || item.min - prev.min > SLOT_CLUSTER_GAP_MIN) {
      clusters.push([item]);
    } else {
      current.push(item);
    }
  }

  let activeItems: WeightedDepSample[] = rawItems;
  if (clusters.length > 1) {
    const nearSlot = clusters
      .filter((c) => {
        const med = c[Math.floor((c.length - 1) * 0.5)]!.min;
        return (
          (c.length >= 2 || (c.includes(rawItems[0]!) && Math.abs(med - atMin) <= 60)) &&
          Math.abs(med - atMin) <= SLOT_CLUSTER_GAP_MIN &&
          clusters.some(
            (other) =>
              other !== c &&
              Math.abs(other[Math.floor((other.length - 1) * 0.5)]!.min - atMin) > 120,
          )
        );
      })
      .sort(
        (a, b) =>
          Math.abs(a[Math.floor((a.length - 1) * 0.5)]!.min - atMin) -
          Math.abs(b[Math.floor((b.length - 1) * 0.5)]!.min - atMin),
      )[0];
    if (nearSlot !== undefined) {
      activeItems = [...nearSlot].sort((left, right) => right.ts - left.ts);
    } else if (rawItems.length >= 2) {
      const newestCluster = clusters.find(
        (c) => c.length >= 2 && c.includes(rawItems[0]!) && c.includes(rawItems[1]!),
      );
      if (newestCluster !== undefined) {
        activeItems = [...newestCluster].sort((left, right) => right.ts - left.ts);
      }
    }
  }

  // Prefer weekday/weekend observations inside the already-selected slot, but
  // only when that subgroup alone is large enough to estimate from.
  if (preferredGroup !== null) {
    const preferredItems = activeItems.filter(
      (item) => weekdayGroup(watDateStr(item.ts)) === preferredGroup,
    );
    if (preferredItems.length >= MIN_SAMPLES) {
      activeItems = preferredItems;
    }
  }

  const sortedRawMins = activeItems.map((item) => item.min).sort((left, right) => left - right);
  const sampleMed = sortedRawMins[Math.floor((sortedRawMins.length - 1) * 0.5)]!;
  const absDevs = sortedRawMins
    .map((min) => Math.abs(min - sampleMed))
    .sort((left, right) => left - right);
  const mad = Math.max(8, absDevs[Math.floor((absDevs.length - 1) * 0.5)]!);
  const trimBand = Math.max(18, Math.min(50, Math.round(1.5 * mad)));

  const trimmed: WeightedDepSample[] = activeItems.map((item) => ({
    ...item,
    clampedMin: Math.max(sampleMed - trimBand, Math.min(sampleMed + trimBand, item.min)),
  }));

  const allTrimmed: WeightedDepSample[] = rawItems.map((item) => ({
    ...item,
    clampedMin: Math.max(sampleMed - trimBand, Math.min(sampleMed + trimBand, item.min)),
  }));
  const totalW = trimmed.reduce((sum, item) => sum + item.w, 0);
  const allTotalW = allTrimmed.reduce((sum, item) => sum + item.w, 0);
  const wMean =
    totalW > 0
      ? trimmed.reduce((sum, item) => sum + item.clampedMin * item.w, 0) / totalW
      : sampleMed;
  const wMed = weightedQuantile(trimmed, 'clampedMin', 0.48);
  let baseP50 = Math.round(0.5 * wMed + 0.5 * wMean);

  // Two-day consecutive same-sign regime gate: shift p50 only when both of the
  // two most recent observations deviate in the same direction from baseP50.
  if (trimmed.length >= 3) {
    const d0 = trimmed[0]!.clampedMin - baseP50;
    const d1 = trimmed[1]!.clampedMin - baseP50;
    if (d0 * d1 > 0 && Math.min(Math.abs(d0), Math.abs(d1)) >= 8) {
      const consistentShift = Math.sign(d0) * Math.min(Math.abs(d0), Math.abs(d1));
      baseP50 += Math.round(0.45 * consistentShift);
    }
  }

  const flooredP50 = readyFloorMin === null ? baseP50 : Math.max(baseP50, readyFloorMin);
  const p50 = Math.max(0, Math.min(1439, flooredP50));

  const q20 = weightedQuantile(trimmed, 'clampedMin', 0.2);
  const q80 = weightedQuantile(trimmed, 'clampedMin', 0.8);
  const coreSpread = Math.max(0, q80 - q20);
  const halfLow =
    coreSpread === 0
      ? readyFloorMin === null
        ? MIN_HALF_WINDOW_MIN
        : 30
      : Math.max(
          MIN_HALF_WINDOW_MIN,
          Math.min(MAX_HALF_LOW_MIN, Math.round(HALF_LOW_MAD_MULT * mad)),
        );
  const halfHigh =
    coreSpread === 0
      ? readyFloorMin === null
        ? MIN_HALF_WINDOW_MIN
        : 30
      : Math.max(
          MIN_HALF_WINDOW_MIN,
          Math.min(MAX_HALF_HIGH_MIN, Math.round(HALF_HIGH_MAD_MULT * mad)),
        );

  // Identical history is not zero uncertainty. Keep the minimum 12 min band.
  // A readiness floor comes from incomplete tail/event data and can itself be
  // wrong after a missed departure, so a collapsed floor-derived sample gets a
  // ±30 min epistemic band; p10 may precede the inferred floor rather than
  // treating that floor as a guaranteed physical bound.
  const rawP10 = Math.max(0, p50 - halfLow);
  const p10 =
    readyFloorMin === null || coreSpread === 0
      ? rawP10
      : Math.max(rawP10, readyFloorMin);
  const p90 = Math.min(1439, Math.max(p50, p50 + halfHigh));
  const lower = Math.max(0, atMin - WINDOW_BEFORE_MIN);
  const upper = Math.min(1439, atMin + WINDOW_AFTER_MIN);
  const hitW = allTrimmed.reduce(
    (sum, item) => sum + (item.clampedMin >= lower && item.clampedMin <= upper ? item.w : 0),
    0,
  );
  const score = allTotalW > 0 ? hitW / allTotalW : 0;
  return { p10, p50, p90, score, n: activeItems.length };
}

/**
 * Same-day inbound tail adjustment. Returns the tail block plus an optional
 * earliest readiness minute-of-day when the assigned aircraft is inbound or
 * still at an outstation airport.
 *
 * `blocked` marks a rejected or unresolved assignment: the caller must not
 * fall back to the history tail link for it.
 */
function adjustForInboundTail(
  db: Db,
  input: ForecastInput,
  flightNo: string,
  dep: LatestDepRow | undefined,
  latestAirline: string | null,
  sinceTs: number,
  samples: number[],
): {
  tail: TailInfo;
  samples: number[];
  readyFloorMin: number | null;
  blocked: boolean;
} {
  const priorReg = dep?.reg ?? null;
  const unknownTail = (reg: string | null): TailInfo => ({
    reg,
    status: 'unknown',
    adjusted: false,
  });

  // The live tail only informs same-day searches with a fresh feed.
  if (input.dateWat !== todayWat(input.nowSec) || input.feedStale || priorReg === null) {
    return { tail: unknownTail(priorReg), samples, readyFloorMin: null, blocked: false };
  }

  // Guard 1: a fresh state row keyed by this flight number is stronger
  // evidence than the latest departure history, which can carry yesterday's
  // tail across a same-day swap. Use it only when it names exactly one reg.
  // Both ingest time and the aircraft's own observation `ts` must be fresh:
  // the feed can refresh `updated_at` while reporting a position hours old.
  const freshCutoff = input.nowSec - STATE_FRESH_SEC;
  const freshFlightRegs = db
    .prepare<{ fresh: number; flt: string }, { reg: string }>(
      `SELECT DISTINCT reg FROM aircraft_state
        WHERE updated_at >= :fresh AND ts >= :fresh
          AND reg IS NOT NULL AND flt IS NOT NULL
          AND upper(trim(flt)) = upper(trim(:flt))`,
    )
    .all({ fresh: freshCutoff, flt: flightNo })
    .map((row) => row.reg);
  const distinctRegs = [...new Set(freshFlightRegs)];
  if (distinctRegs.length > 1) {
    // Ambiguous swap: keep the prior reg but never floor on it.
    return { tail: unknownTail(priorReg), samples, readyFloorMin: null, blocked: true };
  }
  const reg = distinctRegs[0] ?? priorReg;

  // Guard 2: the resolved tail needs fresh, unambiguous live evidence. Every
  // fresh hex for the reg is read, not just the newest, because one swapped
  // registration can leave two rows reporting different flight numbers.
  const freshStates = db
    .prepare<{ reg: string; fresh: number }, StateRow>(
      `SELECT lat, lon, gs_kt, on_ground, dest, flt FROM aircraft_state
        WHERE reg = :reg AND updated_at >= :fresh AND ts >= :fresh
        ORDER BY updated_at DESC, ts DESC`,
    )
    .all({ reg, fresh: freshCutoff });
  const state = freshStates[0];
  if (state === undefined) {
    // Missing or stale state cannot rule out a same-day tail swap, so neither
    // the live floor nor the history tail link may use this reg.
    return { tail: unknownTail(reg), samples, readyFloorMin: null, blocked: true };
  }
  // A null flight number says nothing about which flight this aircraft flies;
  // it is unverified evidence, not permission to floor the prior tail.
  if (state.flt === null) {
    return { tail: unknownTail(reg), samples, readyFloorMin: null, blocked: true };
  }
  const stateFlts = new Set<string>();
  for (const row of freshStates) {
    if (row.flt !== null) {
      stateFlts.add(row.flt.trim().toUpperCase());
    }
  }
  if (stateFlts.size > 1) {
    // Two fresh hexes disagree about this registration's flight: unresolved.
    return { tail: unknownTail(reg), samples, readyFloorMin: null, blocked: true };
  }
  // The freshest state must be flying this flight number, which proves the
  // prior-day assignment is stale.
  if (state.flt.trim().toUpperCase() !== flightNo.trim().toUpperCase()) {
    return { tail: unknownTail(reg), samples, readyFloorMin: null, blocked: true };
  }

  const airport = db
    .prepare<{ iata: string }, AirportRow>(
      'SELECT lat, lon FROM airports WHERE iata = :iata',
    )
    .get({ iata: input.origin });
  if (airport === undefined || airport.lat === null || airport.lon === null) {
    return {
      tail: { reg, status: 'not_inbound', adjusted: false },
      samples,
      readyFloorMin: null,
      blocked: false,
    };
  }

  const distNm = haversineNm(state.lat, state.lon, airport.lat, airport.lon);
  const turnaroundMin =
    latestAirline === null
      ? DEFAULT_TURNAROUND_MIN
      : turnaroundMedianMin(db, input.origin, latestAirline, sinceTs, input.nowSec);
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
      return {
        tail: { reg, status: 'inbound_other_day', adjusted: false },
        samples,
        readyFloorMin: null,
        blocked: false,
      };
    }
    const readyMin = minuteOfDayWat(readyTs);
    return {
      tail: { reg, status: 'inbound', adjusted: true },
      samples: floorToReady(samples, readyMin),
      readyFloorMin: readyMin,
      blocked: false,
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
        blocked: false,
      };
    }
  }

  return {
    tail: { reg, status: 'not_inbound', adjusted: false },
    samples,
    readyFloorMin: null,
    blocked: false,
  };
}

/** Arrival at the origin used to link a departure to its inbound leg. */
interface InboundArrRow {
  flt: string | null;
  ts: number;
}

/** Wrap a minute difference into -720..720 so after-midnight times compare correctly. */
function wrapMinutes(delta: number): number {
  let wrapped = delta;
  while (wrapped > 720) {
    wrapped -= 1440;
  }
  while (wrapped < -720) {
    wrapped += 1440;
  }
  return wrapped;
}

/** UTC epoch seconds of WAT midnight at the start of `dateWat`. */
function watDayStartSec(dateWat: string): number {
  const [year, month, day] = dateWat.split('-').map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day) / 1000 - WAT_OFFSET_SEC;
}

/**
 * History tail link for today's departures when the live aircraft state does
 * not apply. Finds the aircraft's latest arrival at the origin within 12 h that
 * it has not departed from, then shifts every sample by HISTORY_TAIL_SLOPE times
 * that inbound flight's arrival lateness against its own median arrival minute.
 * Returns null when the link does not apply.
 */
function landedInboundShift(
  db: Db,
  input: ForecastInput,
  reg: string | null,
  latestAirline: string | null,
  sinceTs: number,
  samples: number[],
  rawMinutesAsc: readonly number[],
): { timestamps: number[]; readyFloorMin: number | null; tail: TailInfo } | null {
  if (reg === null || input.feedStale || input.dateWat !== todayWat(input.nowSec)) {
    return null;
  }
  const inbound = db
    .prepare<
      { origin: string; reg: string; since: number; ref: number },
      InboundArrRow
    >(
      "SELECT flt, ts FROM events WHERE kind='ARR' AND airport = :origin AND reg = :reg AND ts >= :since AND ts < :ref ORDER BY ts DESC LIMIT 1",
    )
    .get({
      origin: input.origin,
      reg,
      since: input.nowSec - HISTORY_TAIL_MAX_SEC,
      ref: input.nowSec,
    });
  if (inbound === undefined) {
    return null;
  }
  const departedSince = db
    .prepare<
      { origin: string; reg: string; after: number; ref: number },
      { ts: number }
    >(
      "SELECT ts FROM events WHERE kind='DEP' AND airport = :origin AND reg = :reg AND ts > :after AND ts < :ref LIMIT 1",
    )
    .get({ origin: input.origin, reg, after: inbound.ts, ref: input.nowSec });
  if (departedSince !== undefined) {
    return null;
  }

  const turnaroundMin =
    latestAirline === null
      ? DEFAULT_TURNAROUND_MIN
      : turnaroundMedianMin(db, input.origin, latestAirline, sinceTs, input.nowSec);
  const readyTs = Math.floor(inbound.ts + turnaroundMin * 60);
  const readyFloorMin =
    watDateStr(readyTs) === input.dateWat ? minuteOfDayWat(readyTs) : null;

  if (inbound.flt !== null) {
    const priorArrivals = db
      .prepare<
        { origin: string; flt: string; since: number; before: number },
        { ts: number }
      >(
        "SELECT ts FROM events WHERE kind='ARR' AND airport = :origin AND flt = :flt AND ts >= :since AND ts < :before",
      )
      .all({
        origin: input.origin,
        flt: inbound.flt,
        since: sinceTs,
        before: watDayStartSec(input.dateWat),
      })
      .map((row) => minuteOfDayWat(row.ts))
      .sort((left, right) => left - right);
    if (priorArrivals.length >= MIN_SAMPLES) {
      const medianMin = priorArrivals[Math.floor(priorArrivals.length / 2)]!;
      const latenessMin = wrapMinutes(minuteOfDayWat(inbound.ts) - medianMin);
      const shiftSec = Math.round(HISTORY_TAIL_SLOPE * latenessMin * 60);
      return {
        timestamps: samples.map((ts) => ts + shiftSec),
        readyFloorMin,
        tail: { reg, status: 'landed_inbound', adjusted: true },
      };
    }
  }

  const unadjustedMed =
    rawMinutesAsc.length > 0
      ? rawMinutesAsc[Math.floor((rawMinutesAsc.length - 1) * 0.5)]!
      : 0;
  if (
    readyFloorMin !== null &&
    readyFloorMin > unadjustedMed &&
    readyTs >= input.nowSec - 15 * 60
  ) {
    return {
      timestamps: samples,
      readyFloorMin,
      tail: { reg, status: 'landed_inbound', adjusted: true },
    };
  }
  return null;
}

/**
 * Minutes to subtract from p10 for `safeBy`, chosen by the predicted third of
 * day (`p50`).
 */
function safeByDeltaFor(p50: number): number {
  if (p50 < 585) {
    return SAFE_BY_DELTA_MIN[0];
  }
  if (p50 < 845) {
    return SAFE_BY_DELTA_MIN[1];
  }
  return SAFE_BY_DELTA_MIN[2];
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
  const flights = routeFlights(db, input.origin, input.dest, sinceTs, input.nowSec);
  const candidates: ForecastCandidate[] = [];
  const insufficient: InsufficientFlight[] = [];

  for (const flightNo of flights) {
    const preferredTimestamps = depSamples(
      db,
      input.origin,
      input.dest,
      flightNo,
      sinceTs,
      input.nowSec,
      group,
    );
    // Estimation always sees every day so the weekday filter cannot erase the
    // only evidence for the active schedule slot.
    const allTimestamps = depSamples(
      db,
      input.origin,
      input.dest,
      flightNo,
      sinceTs,
      input.nowSec,
      null,
    );

    if (allTimestamps.length < MIN_SAMPLES) {
      insufficient.push({ flightNo, n: allTimestamps.length });
      continue;
    }

    // `n` reports the preferred group when it has enough history, else all days.
    const selectedTimestamps =
      preferredTimestamps.length >= MIN_SAMPLES ? preferredTimestamps : allTimestamps;

    const rawMinutes = selectedTimestamps.map(minuteOfDayWat).sort((left, right) => left - right);
    const dep = latestDeparture(db, input.origin, input.dest, flightNo, sinceTs, input.nowSec);
    const latestAirline = dep?.airline ?? null;
    const adjusted = adjustForInboundTail(
      db,
      input,
      flightNo,
      dep,
      latestAirline,
      sinceTs,
      rawMinutes,
    );
    const landed =
      adjusted.tail.adjusted || adjusted.blocked
        ? null
        : landedInboundShift(
            db,
            input,
            adjusted.tail.reg,
            latestAirline,
            sinceTs,
            allTimestamps,
            rawMinutes,
          );
    const effectiveReadyFloorMin = adjusted.readyFloorMin ?? landed?.readyFloorMin ?? null;
    const stats = estimateTightForecast(
      landed?.timestamps ?? allTimestamps,
      effectiveReadyFloorMin,
      input.atMin,
      group,
    );
    const preShiftSafeBy = Math.max(
      0,
      Math.min(1439, stats.p10 - safeByDeltaFor(stats.p50)),
    );
    const finalTail = landed?.tail ?? adjusted.tail;

    let p10 = stats.p10;
    let p50 = stats.p50;
    let p90 = stats.p90;
    let safeBy = preShiftSafeBy;
    // Observed-only prior: when no tail link explains today, the latest
    // departure can show how late this flight is running. Do not wrap an
    // earlier daily slot across midnight into a large positive residual; only
    // same-day moves within ±12 h (or a true WAT-midnight crossing) count.
    if (finalTail.adjusted === false && selectedTimestamps.length >= MIN_SAMPLES) {
      let latestTs: number | null = null;
      for (const ts of allTimestamps) {
        if (ts < input.nowSec && (latestTs === null || ts > latestTs)) {
          latestTs = ts;
        }
      }
      if (latestTs !== null) {
        const latestMin = minuteOfDayWat(latestTs);
        let residual = latestMin - stats.p50;
        if (stats.p50 >= 1380 && latestMin <= 60) {
          residual += 1440;
        } else if (residual < -720 || residual > 720) {
          residual = 0;
        }
        const delta = Math.min(
          LATEST_RESIDUAL_CAP_MIN,
          Math.max(0, Math.round(LATEST_RESIDUAL_SLOPE * residual)),
        );
        if (delta > 0) {
          p10 = Math.max(0, Math.min(1439, p10 + delta));
          p50 = Math.max(0, Math.min(1439, p50 + delta));
          p90 = Math.max(0, Math.min(1439, p90 + delta));
          // Keep the pre-shift safety tier and move safeBy by the same delta.
          // Re-tiering after the shift would make safeBy less conservative.
          safeBy = Math.max(0, Math.min(1439, preShiftSafeBy + delta));
        }
      }
    }

    candidates.push({
      flightNo,
      airline: latestAirline,
      score: stats.score,
      n: stats.n,
      p10,
      p50,
      p90,
      safeBy,
      baseP50: stats.p50,
      tail: finalTail,
    });
  }

  candidates.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    const distance = Math.abs(left.baseP50 - input.atMin) - Math.abs(right.baseP50 - input.atMin);
    if (distance !== 0) {
      return distance;
    }
    return left.flightNo.localeCompare(right.flightNo);
  });

  insufficient.sort((left, right) => left.flightNo.localeCompare(right.flightNo));

  return { candidates: candidates.slice(0, MAX_CANDIDATES), insufficient };
}
