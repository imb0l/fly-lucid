import { describe, expect, it } from 'vitest';

import { openDb, type Db } from '../src/db/db.js';
import {
  estimateTightForecast,
  forecast,
  floorToReady,
  minuteOfDayWat,
  percentileNearestRank,
  SAFE_BY_DELTA_MIN,
  scoreWindow,
  todayWat,
  weekdayGroup,
} from '../src/model/forecast.js';

function watsMidnightUtc(dateWat: string): number {
  const [year, month, day] = dateWat.split('-').map(Number);
  // Midnight WAT in UTC, i.e. 23:00 UTC on the previous calendar day.
  return Date.UTC(year!, month! - 1, day!) / 1000 - 3600;
}

describe('score window and percentiles', () => {
  it('matches the plan score example exactly', () => {
    const samples = [835, 850, 880, 905, 1150]; // 13:55, 14:10, 14:40, 15:05, 19:10
    expect(scoreWindow(samples, 840)).toBeCloseTo(0.6, 10);
    expect(percentileNearestRank(samples, 0.1)).toBe(835);
    expect(percentileNearestRank(samples, 0.5)).toBe(880);
    expect(percentileNearestRank(samples, 0.9)).toBe(1150);
  });

  it('floors samples to the inbound aircraft readiness time', () => {
    const samples = [835, 850, 880, 905, 1150];

    const readyAt1500 = floorToReady(samples, 900).sort((a, b) => a - b);
    expect(readyAt1500).toEqual([900, 900, 900, 905, 1150]);
    expect(scoreWindow(readyAt1500, 840)).toBeCloseTo(0.6, 10);
    expect(percentileNearestRank(readyAt1500, 0.5)).toBe(900);

    const readyAt1520 = floorToReady(samples, 920).sort((a, b) => a - b);
    expect(readyAt1520).toEqual([920, 920, 920, 920, 1150]);
    expect(scoreWindow(readyAt1520, 840)).toBe(0);
  });

  it('does not wrap the score window across midnight', () => {
    // at = 10 means the window is [0, 70], never [1410, 1439] ∪ [0, 70].
    expect(scoreWindow([1430], 10)).toBe(0);
    expect(scoreWindow([60], 10)).toBe(1);
    expect(scoreWindow([1430], 1430)).toBe(1);
    // Upper bound is clipped at 1439.
    expect(scoreWindow([1439], 1430)).toBe(1);
  });

  it('uses nearest rank ceil(p*n)-1', () => {
    const sorted = [10, 20, 30, 40];
    expect(percentileNearestRank(sorted, 0.1)).toBe(10); // ceil(0.4)-1 = 0
    expect(percentileNearestRank(sorted, 0.25)).toBe(10); // ceil(1)-1 = 0
    expect(percentileNearestRank(sorted, 0.5)).toBe(20); // ceil(2)-1 = 1
    expect(percentileNearestRank(sorted, 0.75)).toBe(30); // ceil(3)-1 = 2
    expect(percentileNearestRank(sorted, 1)).toBe(40); // ceil(4)-1 = 3
    expect(percentileNearestRank([7], 0.9)).toBe(7);
    expect(() => percentileNearestRank([], 0.5)).toThrow(RangeError);
    expect(() => percentileNearestRank(sorted, 0)).toThrow(RangeError);
  });
});

describe('WAT calendar helpers', () => {
  it('converts epoch seconds to WAT minute-of-day', () => {
    // 2026-03-02T13:40:00Z is 14:40 WAT.
    const ts = Date.UTC(2026, 2, 2, 13, 40) / 1000;
    expect(minuteOfDayWat(ts)).toBe(14 * 60 + 40);
    expect(minuteOfDayWat(0)).toBe(60); // 1970-01-01 01:00 WAT
    expect(todayWat(ts)).toBe('2026-03-02');
  });

  it('groups Mon-Fri as weekday and Sat-Sun as weekend', () => {
    expect(weekdayGroup('2026-03-02')).toBe('weekday'); // Monday
    expect(weekdayGroup('2026-03-06')).toBe('weekday'); // Friday
    expect(weekdayGroup('2026-03-07')).toBe('weekend'); // Saturday
    expect(weekdayGroup('2026-03-08')).toBe('weekend'); // Sunday
  });
});

describe('forecast on a seeded database', () => {
  const TODAY = '2026-03-02'; // Monday, WAT
  const NOW_SEC = Date.UTC(2026, 2, 2, 12, 0) / 1000; // 13:00 WAT
  const FLIGHT = 'P47443';
  const AIRLINE = 'APO';

  function seededDb(): { db: Db; groupCount: number } {
    const db = openDb(':memory:');
    const insertAirport = db.prepare(
      'INSERT INTO airports (iata, icao, name, lat, lon) VALUES (?, ?, ?, ?, ?)',
    );
    insertAirport.run('LOS', 'DNMM', 'Murtala Muhammed International', 6.5774, 3.3212);
    insertAirport.run('ABV', 'DNAA', 'Nnamdi Azikiwe International', 9.0068, 7.2632);

    const insertDep = db.prepare(`
      INSERT INTO events (hex, reg, flt, airline, kind, airport, dest, ts)
      VALUES (@hex, @reg, @flt, @airline, 'DEP', @airport, @dest, @ts)
    `);

    const base = watsMidnightUtc(TODAY);
    let groupCount = 0;

    // 28 consecutive WAT days ending today: 14:40 every day, 19:10 on the
    // first six days (today backwards).
    for (let daysBack = 0; daysBack < 28; daysBack += 1) {
      const midnight = base - daysBack * 86_400;
      const dayTs = new Date((midnight + 3600) * 1000);
      const dateWat = [
        dayTs.getUTCFullYear().toString().padStart(4, '0'),
        (dayTs.getUTCMonth() + 1).toString().padStart(2, '0'),
        dayTs.getUTCDate().toString().padStart(2, '0'),
      ].join('-');
      const isWeekday = weekdayGroup(dateWat) === 'weekday';

      const afternoon = midnight + 14 * 3600 + 40 * 60;
      insertDep.run({
        hex: `HEX${daysBack}`,
        reg: `5N-T${daysBack}`,
        flt: FLIGHT,
        airline: AIRLINE,
        airport: 'LOS',
        dest: 'ABV',
        ts: afternoon,
      });
      // Events after NOW_SEC are not yet observed; forecast() must exclude them.
      if (isWeekday && afternoon < NOW_SEC) {
        groupCount += 1;
      }

      if (daysBack < 6) {
        insertDep.run({
          hex: `HEX${daysBack}`,
          reg: `5N-T${daysBack}`,
          flt: FLIGHT,
          airline: AIRLINE,
          airport: 'LOS',
          dest: 'ABV',
          ts: midnight + 19 * 3600 + 10 * 60,
        });
        if (isWeekday && midnight + 19 * 3600 + 10 * 60 < NOW_SEC) {
          groupCount += 1;
        }
      }
    }

    // Too little history: must show up in `insufficient`, never in candidates.
    for (let daysBack = 0; daysBack < 3; daysBack += 1) {
      insertDep.run({
        hex: `OTHER${daysBack}`,
        reg: `5N-O${daysBack}`,
        flt: 'P47111',
        airline: AIRLINE,
        airport: 'LOS',
        dest: 'ABV',
        ts: base - daysBack * 86_400 + 10 * 3600,
      });
    }

    return { db, groupCount };
  }

  it('forecasts the seeded weekday flight at 14:00', () => {
    const { db, groupCount } = seededDb();
    const result = forecast(db, {
      origin: 'LOS',
      dest: 'ABV',
      dateWat: TODAY,
      atMin: 14 * 60,
      nowSec: NOW_SEC,
      feedStale: true,
    });

    expect(result.insufficient).toEqual([{ flightNo: 'P47111', n: 3 }]);
    expect(result.candidates).toHaveLength(1);

    const candidate = result.candidates[0]!;
    expect(candidate.flightNo).toBe(FLIGHT);
    expect(candidate.n).toBe(19);
    expect(candidate.n).toBeGreaterThanOrEqual(5);
    // Recency-weighted + MAD-Winsorized tight forecast anchors on the 14:40 slot
    // and trims the 19:10 outliers so the [p10, p90] window stays tight (< 60
    // minutes wide instead of the 270-minute 14:40..19:10 span). The tail is
    // unadjusted, so the observed-only prior reads yesterday's 19:10 departure
    // as a +270 residual and applies the 45-minute cap: 14:40 + 45 = 15:25.
    expect(candidate.p50).toBe(15 * 60 + 25);
    expect(candidate.p90 - candidate.p10).toBeLessThanOrEqual(56);
    expect(candidate.score).toBeGreaterThan(0.5);
    expect(candidate.score).toBeLessThanOrEqual(1);
    // Same-day search with a stale feed never adjusts and reports unknown.
    // Today's DEPs are after NOW_SEC, so the latest observed DEP is yesterday's.
    expect(candidate.tail).toEqual({ reg: '5N-T1', status: 'unknown', adjusted: false });
  });

  it('subtracts the late-third delta from p10 for safeBy', () => {
    const { db } = seededDb();
    const result = forecast(db, {
      origin: 'LOS',
      dest: 'ABV',
      dateWat: TODAY,
      atMin: 14 * 60,
      nowSec: NOW_SEC,
      feedStale: true,
    });

    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0]!;
    // 14:40+ WAT is in the late third of the day, so the delta is 58 minutes.
    expect(candidate.p50).toBeGreaterThanOrEqual(845);
    expect(candidate.safeBy).toBe(candidate.p10 - SAFE_BY_DELTA_MIN[2]);
    expect(candidate.safeBy).toBeLessThanOrEqual(candidate.p10);
    for (const entry of result.candidates) {
      expect(entry.safeBy).toBeGreaterThanOrEqual(0);
      expect(entry.safeBy).toBeLessThanOrEqual(1439);
    }
  });

  it('tightens the interval and tracks recent regime shifts via estimateTightForecast', () => {
    const base = watsMidnightUtc(TODAY);
    // P47214 real 6-day series (older ~14:25, recent 2 days ~15:31 & 15:57, plus one 17:02 spike)
    const timestamps = [
      base - 1 * 86_400 + (15 * 60 + 31) * 60,
      base - 2 * 86_400 + (15 * 60 + 57) * 60,
      base - 3 * 86_400 + (17 * 60 + 2) * 60,
      base - 5 * 86_400 + (15 * 60 + 6) * 60,
      base - 6 * 86_400 + (14 * 60 + 29) * 60,
      base - 7 * 86_400 + (14 * 60 + 21) * 60,
    ];
    const stats = estimateTightForecast(timestamps, null, 14 * 60);
    // Tracks the recent regime shift (~15:25..15:40) and clamps the 161m raw
    // span to the calibrated 114m ceiling (52m below, 62m above).
    expect(stats.p50).toBeGreaterThanOrEqual(15 * 60 + 20);
    expect(stats.p50).toBeLessThanOrEqual(15 * 60 + 45);
    expect(stats.p90 - stats.p10).toBeLessThanOrEqual(114);
    expect(stats.p50 - stats.p10).toBeLessThanOrEqual(52);
    expect(stats.p90 - stats.p50).toBeLessThanOrEqual(62);
  });

  it('keeps the window narrow when a flight departs at a stable time', () => {
    const base = watsMidnightUtc(TODAY);
    const timestamps = [1, 2, 3, 4, 5, 6].map(
      (daysBack) => base - daysBack * 86_400 + (15 * 60 + 30) * 60,
    );
    const stats = estimateTightForecast(timestamps, null, 14 * 60);
    expect(stats.p50).toBe(15 * 60 + 30);
    // Zero spread keeps the minimum half-window instead of the 114m ceiling.
    expect(stats.p90 - stats.p10).toBeLessThanOrEqual(24);
  });

  it('uses the events_lookup index for the departure sample query', () => {
    const { db } = seededDb();
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT ts FROM events WHERE kind='DEP' AND airport = :origin AND dest = :dest AND flt = :flt AND ts >= :since",
      )
      .all({ origin: 'LOS', dest: 'ABV', flt: FLIGHT, since: 0 }) as Array<{
      detail: string;
    }>;
    const details = plan.map((row) => row.detail).join('\n');
    expect(details).toContain('events_lookup');
  });

  it('anchors split schedule slots on the slot nearest the query time', () => {
    const base = watsMidnightUtc(TODAY);
    // Four older 12:45 departures plus the two newest at 17:50: more than the
    // 90-minute slot gap apart, so they form distinct schedule slots.
    const timestamps = [10, 8, 6, 4].map(
      (daysBack) => base - daysBack * 86_400 + (12 * 60 + 45) * 60,
    );
    timestamps.push(
      base - 2 * 86_400 + (17 * 60 + 50) * 60,
      base - 1 * 86_400 + (17 * 60 + 50) * 60,
    );

    // Querying the evening slot must not average in the old 12:45 regime.
    const evening = estimateTightForecast(timestamps, null, 17 * 60 + 45);
    expect(evening.p50).toBeGreaterThanOrEqual(17 * 60 + 40);
    expect(evening.p50).toBeLessThanOrEqual(18 * 60);

    const midday = estimateTightForecast(timestamps, null, 12 * 60 + 30);
    expect(midday.p50).toBeGreaterThanOrEqual(12 * 60 + 35);
    expect(midday.p50).toBeLessThanOrEqual(13 * 60);
  });

  it('picks the all-day schedule slot before preferring weekday observations', () => {
    // QI522 on 2026-11-26 17:45 WAT: the 17:50 slot had one weekday and one
    // weekend observation while the older 12:45 slot had many weekdays. The
    // weekday filter must not shrink the 17:50 slot to a singleton and hand the
    // forecast to the midday cluster.
    const db = openDb(':memory:');
    const insertAirport = db.prepare(
      'INSERT INTO airports (iata, icao, name, lat, lon) VALUES (?, ?, ?, ?, ?)',
    );
    insertAirport.run('LOS', 'DNMM', 'Murtala Muhammed International', 6.5774, 3.3212);
    insertAirport.run('ABV', 'DNAA', 'Nnamdi Azikiwe International', 9.0068, 7.2632);
    const insertDep = db.prepare(`
      INSERT INTO events (hex, reg, flt, airline, kind, airport, dest, ts)
      VALUES (@hex, @reg, @flt, @airline, 'DEP', @airport, @dest, @ts)
    `);
    const base = watsMidnightUtc(TODAY);
    const dep = (daysBack: number, minute: number): void => {
      insertDep.run({
        hex: `QI${daysBack}-${minute}`,
        reg: `5N-Q${daysBack}`,
        flt: 'QI522',
        airline: AIRLINE,
        airport: 'LOS',
        dest: 'ABV',
        ts: base - daysBack * 86_400 + minute * 60,
      });
    };

    // Seven weekday departures at 12:45, the newest of them more recent than
    // the evening observation so the old code's newest-cluster fallback lands
    // on midday.
    for (const daysBack of [3, 4, 5, 6, 7, 14, 21]) {
      dep(daysBack, 12 * 60 + 45);
    }
    // One weekday (Mon 16 Feb) and one weekend (Sun 1 Mar) departure at 17:50.
    dep(14, 17 * 60 + 50);
    dep(1, 17 * 60 + 50);

    const result = forecast(db, {
      origin: 'LOS',
      dest: 'ABV',
      dateWat: TODAY,
      atMin: 17 * 60 + 45,
      nowSec: NOW_SEC,
      feedStale: true,
    });

    expect(result.insufficient).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0]!;
    expect(candidate.flightNo).toBe('QI522');
    // n now reports the two observations actually used for the evening slot.
    expect(candidate.n).toBe(2);
    // The evening slot wins: p50 near 17:50, never the 12:45 midday cluster.
    expect(candidate.p50).toBeGreaterThanOrEqual(17 * 60 + 40);
    expect(candidate.p50).toBeLessThanOrEqual(18 * 60);
  });
});

describe('history tail link on a seeded database', () => {
  const TODAY = '2026-03-02'; // Monday, WAT
  const NOW_SEC = Date.UTC(2026, 2, 2, 12, 0) / 1000; // 13:00 WAT
  const FLIGHT = 'P47443';
  const INBOUND = 'P47900';
  const TAIL = '5N-OLD';
  const QUERY = {
    origin: 'LOS',
    dest: 'ABV',
    dateWat: TODAY,
    atMin: 14 * 60,
    nowSec: NOW_SEC,
    feedStale: false,
  };

  /**
   * Ten prior days: FLIGHT departs LOS 14:40 with TAIL, INBOUND arrives LOS
   * 10:00 on another tail. When `todayArrivalMin` is set, the inbound
   * aircraft lands today on TAIL at that minute-of-day WAT.
   */
  function linkedDb(todayArrivalMin: number | null): Db {
    const db = openDb(':memory:');
    const insertAirport = db.prepare(
      'INSERT INTO airports (iata, icao, name, lat, lon) VALUES (?, ?, ?, ?, ?)',
    );
    insertAirport.run('LOS', 'DNMM', 'Murtala Muhammed International', 6.5774, 3.3212);
    insertAirport.run('ABV', 'DNAA', 'Nnamdi Azikiwe International', 9.0068, 7.2632);

    const insertEvent = db.prepare(`
      INSERT INTO events (hex, reg, flt, airline, kind, airport, dest, ts)
      VALUES (@hex, @reg, @flt, @airline, @kind, @airport, @dest, @ts)
    `);
    const base = watsMidnightUtc(TODAY);
    for (let daysBack = 1; daysBack <= 10; daysBack += 1) {
      const midnight = base - daysBack * 86_400;
      insertEvent.run({
        hex: `OLD${daysBack}`,
        reg: TAIL,
        flt: FLIGHT,
        airline: 'APO',
        kind: 'DEP',
        airport: 'LOS',
        dest: 'ABV',
        ts: midnight + 14 * 3600 + 40 * 60,
      });
      insertEvent.run({
        hex: `PREV${daysBack}`,
        reg: '5N-PREV',
        flt: INBOUND,
        airline: 'APO',
        kind: 'ARR',
        airport: 'LOS',
        dest: null,
        ts: midnight + 10 * 3600,
      });
    }
    if (todayArrivalMin !== null) {
      insertEvent.run({
        hex: 'TODAYIN',
        reg: TAIL,
        flt: INBOUND,
        airline: 'APO',
        kind: 'ARR',
        airport: 'LOS',
        dest: null,
        ts: base + todayArrivalMin * 60,
      });
    }
    return db;
  }

  /**
   * A fresh live state for TAIL already back at LOS on the target flight. The
   * guard requires fresh, self-consistent live evidence before the tail may
   * drive either a live floor or the history link.
   */
  function insertOriginState(db: Db, nowSec: number): void {
    db.prepare(`
      INSERT INTO aircraft_state (hex, reg, flt, lat, lon, on_ground, ts, updated_at)
      VALUES ('FRESHTAIL', @reg, @flt, 6.5774, 3.3212, 1, @ts, @updatedAt)
    `).run({ reg: TAIL, flt: FLIGHT, ts: nowSec - 60, updatedAt: nowSec - 30 });
  }

  it('shifts departure samples by half the inbound lateness when the aircraft has landed', () => {
    const baselineDb = linkedDb(null);
    insertOriginState(baselineDb, NOW_SEC);
    const baseline = forecast(baselineDb, QUERY).candidates[0]!;
    // Inbound lands 11:00 WAT against a 10:00 median: 60 min late, slope 0.5 -> +30 min.
    const linkedDbFresh = linkedDb(11 * 60);
    insertOriginState(linkedDbFresh, NOW_SEC);
    const linked = forecast(linkedDbFresh, QUERY).candidates[0]!;

    expect(baseline.tail).toEqual({ reg: TAIL, status: 'not_inbound', adjusted: false });
    expect(linked.tail).toEqual({ reg: TAIL, status: 'landed_inbound', adjusted: true });
    expect(linked.p50 - baseline.p50).toBe(30);
  });

  it('does not link when the aircraft departed again after landing', () => {
    const db = linkedDb(11 * 60);
    insertOriginState(db, NOW_SEC);
    db.prepare(`
      INSERT INTO events (hex, reg, flt, airline, kind, airport, dest, ts)
      VALUES ('TODAYOUT', @reg, @flt, 'APO', 'DEP', 'LOS', 'ABV', @ts)
    `).run({
      reg: TAIL,
      flt: 'P47800',
      ts: watsMidnightUtc(TODAY) + 12 * 3600 + 30 * 60,
    });
    const candidate = forecast(db, QUERY).candidates.find((c) => c.flightNo === FLIGHT)!;
    expect(candidate.tail).toEqual({ reg: TAIL, status: 'not_inbound', adjusted: false });
    // The 11:00 inbound would have shifted the 14:40 band by +30.
    expect(candidate.p50).toBe(14 * 60 + 40);
  });

  it('floors an ad-hoc inbound arrival at the physical turnaround time', () => {
    const db = linkedDb(null);
    const base = watsMidnightUtc(TODAY);
    const arrivalSec = base + (14 * 60 + 20) * 60;
    const queryNow = arrivalSec + 10 * 60;
    insertOriginState(db, queryNow);
    // Ad-hoc inbound flight number with no prior arrivals at LOS: there is no
    // lateness history, but the aircraft has physically landed at 14:20.
    db.prepare(`
      INSERT INTO events (hex, reg, flt, airline, kind, airport, dest, ts)
      VALUES ('TODAYADHOC', @reg, 'P47999', 'APO', 'ARR', 'LOS', NULL, @ts)
    `).run({ reg: TAIL, ts: arrivalSec });

    // The arrival must already be observed for the tail link to apply.
    const candidate = forecast(db, { ...QUERY, nowSec: queryNow }).candidates[0]!;

    expect(candidate.flightNo).toBe(FLIGHT);
    expect(candidate.tail).toEqual({ reg: TAIL, status: 'landed_inbound', adjusted: true });
    // 14:20 + the 45-minute turnaround floor = 15:05, later than the 14:40
    // historical departures. The floor is uncertain, so a collapsed sample
    // spread must retain a ±30 min epistemic band rather than p10=p50=p90.
    expect(candidate.p50).toBeGreaterThanOrEqual(15 * 60 + 5);
    expect(candidate.p10).toBe(candidate.p50 - 30);
    expect(candidate.p90).toBe(candidate.p50 + 30);
    expect(candidate.p50).toBeGreaterThan(14 * 60 + 40);
  });

  it('does not invent an outstation readiness floor when aircraft_state is stale', () => {
    const db = linkedDb(null);
    const base = watsMidnightUtc(TODAY);
    db.prepare(`
      INSERT INTO aircraft_state (hex, reg, lat, lon, on_ground, ts, updated_at)
      VALUES ('STALETAIL', @reg, 9.0068, 7.2632, 1, @ts, @updatedAt)
    `).run({ reg: TAIL, ts: NOW_SEC - 900, updatedAt: NOW_SEC - 600 });
    db.prepare(`
      INSERT INTO events (hex, reg, flt, airline, kind, airport, dest, ts)
      VALUES ('TODAYABV', @reg, 'P47988', 'APO', 'ARR', 'ABV', NULL, @ts)
    `).run({ reg: TAIL, ts: base + 12 * 3600 + 30 * 60 });

    const candidate = forecast(db, QUERY).candidates[0]!;
    expect(candidate.flightNo).toBe(FLIGHT);
    expect(candidate.tail).toEqual({ reg: TAIL, status: 'unknown', adjusted: false });
    expect(candidate.p50).toBe(14 * 60 + 40);
  });
});

describe('observed-only latest residual prior', () => {
  const TODAY = '2026-03-02'; // Monday, WAT
  const NOW_SEC = Date.UTC(2026, 2, 2, 15, 30) / 1000; // 16:30 WAT
  const FLIGHT = 'P47500';
  const AIRLINE = 'APO';

  /**
   * Eight earlier weekday departures at `baseMin`, plus the newest observation
   * on the preceding Sunday (1 Mar) at `latestWeekendMin`. The Sunday departure
   * is outside the Mon-Fri group, so only the all-day sample set can see it.
   */
  function residualDb(baseMin: number, latestWeekendMin: number): Db {
    const db = openDb(':memory:');
    const insertAirport = db.prepare(
      'INSERT INTO airports (iata, icao, name, lat, lon) VALUES (?, ?, ?, ?, ?)',
    );
    insertAirport.run('LOS', 'DNMM', 'Murtala Muhammed International', 6.5774, 3.3212);
    insertAirport.run('ABV', 'DNAA', 'Nnamdi Azikiwe International', 9.0068, 7.2632);
    const insertDep = db.prepare(`
      INSERT INTO events (hex, reg, flt, airline, kind, airport, dest, ts)
      VALUES (@hex, @reg, @flt, @airline, 'DEP', @airport, @dest, @ts)
    `);
    const base = watsMidnightUtc(TODAY);
    const dep = (daysBack: number, minute: number, hex: string): void => {
      insertDep.run({
        hex,
        reg: '5N-R1',
        flt: FLIGHT,
        airline: AIRLINE,
        airport: 'LOS',
        dest: 'ABV',
        ts: base - daysBack * 86_400 + minute * 60,
      });
    };
    for (const daysBack of [3, 4, 5, 6, 7, 10, 11, 12]) {
      dep(daysBack, baseMin, `WD${daysBack}`);
    }
    dep(1, latestWeekendMin, 'SUNDAY');
    return db;
  }

  function topCandidate(db: Db, atMin: number) {
    const result = forecast(db, {
      origin: 'LOS',
      dest: 'ABV',
      dateWat: TODAY,
      atMin,
      nowSec: NOW_SEC,
      feedStale: true,
    });
    expect(result.candidates).toHaveLength(1);
    return result.candidates[0]!;
  }

  it('shifts the band by a quarter of the latest observed residual', () => {
    // Sunday 11:20 against a 10:00 band: +80 residual, 25% = +20.
    const candidate = topCandidate(residualDb(10 * 60, 11 * 60 + 20), 10 * 60);

    // The weekend observation never reaches `n`, but it does drive the shift.
    expect(candidate.n).toBe(8);
    expect(candidate.tail).toEqual({ reg: '5N-R1', status: 'unknown', adjusted: false });
    expect(candidate.p10).toBe(10 * 60 + 8);
    expect(candidate.p50).toBe(10 * 60 + 20);
    expect(candidate.p90).toBe(10 * 60 + 32);
    // The shifted p10 is 608; the pre-shift safeBy floor is 587.
    expect(candidate.safeBy).toBe(10 * 60 - 5);
  });

  it('caps the shift at 45 minutes', () => {
    // Sunday 13:20 against a 10:00 band: +200 residual, 25% = 50, capped to 45.
    const candidate = topCandidate(residualDb(10 * 60, 13 * 60 + 20), 10 * 60);

    expect(candidate.p10).toBe(10 * 60 + 33);
    expect(candidate.p50).toBe(10 * 60 + 45);
    expect(candidate.p90).toBe(10 * 60 + 57);
    expect(candidate.safeBy).toBe(10 * 60 + 20);
  });

  it('does not shift on a negative latest residual', () => {
    // Sunday 09:30 before a 10:00 band: -30 residual, floored at 0.
    const candidate = topCandidate(residualDb(10 * 60, 9 * 60 + 30), 10 * 60);

    expect(candidate.p10).toBe(10 * 60 - 12);
    expect(candidate.p50).toBe(10 * 60);
    expect(candidate.p90).toBe(10 * 60 + 12);
    expect(candidate.safeBy).toBe(10 * 60 - 25);
  });

  it('never moves safeBy earlier when the shift crosses a p50 tier boundary', () => {
    // 13:50 band with a Sunday 15:00 departure: +70 residual, 25% = +17.5 -> +18.
    const candidate = topCandidate(residualDb(13 * 60 + 50, 15 * 60), 13 * 60 + 50);

    expect(candidate.p50).toBe(13 * 60 + 50 + 18); // 848: the late tier (58)
    expect(candidate.p10).toBe(13 * 60 + 56);
    // Pre-shift safeBy was 818 - 13 = 805; the same +18 shift preserves the
    // pre-shift safety tier instead of re-tiering to the less-conservative 58.
    expect(candidate.safeBy).toBe(13 * 60 + 43);
  });

  it('does not wrap an earlier daily slot into a positive residual', () => {
    // Eight 21:00 departures plus the newest observation from the 07:00 slot.
    // The 14-hour gap is another slot, not a 6-hour delay of the 21:00 flight.
    const candidate = topCandidate(residualDb(21 * 60, 7 * 60), 21 * 60);

    expect(candidate.p10).toBe(21 * 60 - 12);
    expect(candidate.p50).toBe(21 * 60);
    expect(candidate.p90).toBe(21 * 60 + 12);
    expect(candidate.safeBy).toBe(21 * 60 - 70);
  });
});

describe('fresh aircraft_state tail guard', () => {
  const TODAY = '2026-03-02'; // Monday, WAT
  const NOW_SEC = Date.UTC(2026, 2, 2, 12, 0) / 1000; // 13:00 WAT
  const FLIGHT = 'P47443';
  const PRIOR_TAIL = '5N-OLD';
  const INBOUND = 'P47900';
  const QUERY = {
    origin: 'LOS',
    dest: 'ABV',
    dateWat: TODAY,
    atMin: 14 * 60,
    nowSec: NOW_SEC,
    feedStale: false,
  };

  /**
   * Ten prior FLIGHT departures at 14:40 WAT on PRIOR_TAIL, plus ten prior
   * inbound arrivals at LOS and one today at 12:20 WAT. Without a guard the
   * landed-inbound link reads +140 minutes of inbound lateness, shifts every
   * sample by 70 minutes and marks the tail adjusted.
   */
  function guardDb(): Db {
    const db = openDb(':memory:');
    const insertAirport = db.prepare(
      'INSERT INTO airports (iata, icao, name, lat, lon) VALUES (?, ?, ?, ?, ?)',
    );
    insertAirport.run('LOS', 'DNMM', 'Murtala Muhammed International', 6.5774, 3.3212);
    insertAirport.run('ABV', 'DNAA', 'Nnamdi Azikiwe International', 9.0068, 7.2632);

    const insertEvent = db.prepare(`
      INSERT INTO events (hex, reg, flt, airline, kind, airport, dest, ts)
      VALUES (@hex, @reg, @flt, 'APO', @kind, @airport, @dest, @ts)
    `);
    const base = watsMidnightUtc(TODAY);
    for (let daysBack = 1; daysBack <= 10; daysBack += 1) {
      const midnight = base - daysBack * 86_400;
      insertEvent.run({
        hex: `OLD${daysBack}`,
        reg: PRIOR_TAIL,
        flt: FLIGHT,
        kind: 'DEP',
        airport: 'LOS',
        dest: 'ABV',
        ts: midnight + 14 * 3600 + 40 * 60,
      });
      insertEvent.run({
        hex: `PREV${daysBack}`,
        reg: PRIOR_TAIL,
        flt: INBOUND,
        kind: 'ARR',
        airport: 'LOS',
        dest: null,
        ts: midnight + 10 * 3600,
      });
    }
    insertEvent.run({
      hex: 'TODAYIN',
      reg: PRIOR_TAIL,
      flt: INBOUND,
      kind: 'ARR',
      airport: 'LOS',
      dest: null,
      ts: base + 12 * 3600 + 20 * 60,
    });
    return db;
  }

  /** A fresh (updated 30 s ago) state row: at ABV unless `atOrigin`. */
  function insertState(
    db: Db,
    hex: string,
    reg: string,
    flt: string | null,
    atOrigin = false,
  ): void {
    const coords = atOrigin ? { lat: 6.5774, lon: 3.3212 } : { lat: 9.0068, lon: 7.2632 };
    db.prepare(`
      INSERT INTO aircraft_state (hex, reg, flt, lat, lon, on_ground, ts, updated_at)
      VALUES (@hex, @reg, @flt, @lat, @lon, 1, @ts, @updatedAt)
    `).run({ hex, reg, flt, ...coords, ts: NOW_SEC - 60, updatedAt: NOW_SEC - 30 });
  }

  function onlyCandidate(db: Db) {
    const result = forecast(db, QUERY);
    expect(result.candidates).toHaveLength(1);
    return result.candidates[0]!;
  }

  it('uses the fresh same-flight reg instead of the prior-day departure reg', () => {
    const db = guardDb();
    insertState(db, 'SWAP', '5N-NEW', FLIGHT);

    const candidate = onlyCandidate(db);
    expect(candidate.flightNo).toBe(FLIGHT);
    expect(candidate.tail).toEqual({ reg: '5N-NEW', status: 'not_inbound', adjusted: true });
    // 5N-NEW is still at ABV: transit plus turnaround floors the 14:40 samples.
    expect(candidate.p50).toBeGreaterThanOrEqual(14 * 60 + 40);
  });

  it('rejects the prior reg when its fresh state carries another flight', () => {
    const db = guardDb();
    // At the origin, so the old code would fall through to the landed-inbound
    // link (+70 min) rather than a live floor; the guard must block both.
    insertState(db, 'STALEASSIGN', PRIOR_TAIL, 'P47800', true);

    const candidate = onlyCandidate(db);
    expect(candidate.flightNo).toBe(FLIGHT);
    expect(candidate.tail).toEqual({ reg: PRIOR_TAIL, status: 'unknown', adjusted: false });
    // No live floor and no landed-inbound +70 shift: the 14:40 band is untouched.
    expect(candidate.p50).toBe(14 * 60 + 40);
    expect(candidate.p10).toBe(14 * 60 + 28);
  });

  it('does not floor when several fresh regs claim the same flight number', () => {
    const db = guardDb();
    insertState(db, 'AMBIGA', '5N-A', FLIGHT);
    insertState(db, 'AMBIGB', '5N-B', FLIGHT);

    const candidate = onlyCandidate(db);
    expect(candidate.flightNo).toBe(FLIGHT);
    expect(candidate.tail).toEqual({ reg: PRIOR_TAIL, status: 'unknown', adjusted: false });
    expect(candidate.p50).toBe(14 * 60 + 40);
  });

  it('blocks a fresh prior-tail state with a null flight number', () => {
    const db = guardDb();
    insertState(db, 'NULLFLT', PRIOR_TAIL, null, true);

    const candidate = onlyCandidate(db);
    expect(candidate.tail).toEqual({ reg: PRIOR_TAIL, status: 'unknown', adjusted: false });
    expect(candidate.p50).toBe(14 * 60 + 40);
  });

  it('blocks the landed link when the prior-tail state is 129 seconds old', () => {
    const db = guardDb();
    db.prepare(`
      INSERT INTO aircraft_state (hex, reg, flt, lat, lon, on_ground, ts, updated_at)
      VALUES ('STALE129', @reg, @flt, 6.5774, 3.3212, 1, @ts, @updatedAt)
    `).run({ reg: PRIOR_TAIL, flt: FLIGHT, ts: NOW_SEC - 129, updatedAt: NOW_SEC - 129 });

    const candidate = onlyCandidate(db);
    expect(candidate.tail).toEqual({ reg: PRIOR_TAIL, status: 'unknown', adjusted: false });
    expect(candidate.p50).toBe(14 * 60 + 40);
  });

  it('blocks conflicting fresh states for the same registration', () => {
    const db = guardDb();
    insertState(db, 'CONFLICT-A', PRIOR_TAIL, FLIGHT, true);
    insertState(db, 'CONFLICT-B', PRIOR_TAIL, 'P47800', true);

    const candidate = onlyCandidate(db);
    expect(candidate.tail).toEqual({ reg: PRIOR_TAIL, status: 'unknown', adjusted: false });
    expect(candidate.p50).toBe(14 * 60 + 40);
  });

  it('blocks a freshly written row whose aircraft observation is stale', () => {
    const db = guardDb();
    db.prepare(`
      INSERT INTO aircraft_state (hex, reg, flt, lat, lon, on_ground, ts, updated_at)
      VALUES ('OLDTS', @reg, @flt, 9.0068, 7.2632, 1, @ts, @updatedAt)
    `).run({ reg: PRIOR_TAIL, flt: FLIGHT, ts: NOW_SEC - 300, updatedAt: NOW_SEC - 30 });

    const candidate = onlyCandidate(db);
    expect(candidate.tail).toEqual({ reg: PRIOR_TAIL, status: 'unknown', adjusted: false });
    expect(candidate.p50).toBe(14 * 60 + 40);
  });
});
