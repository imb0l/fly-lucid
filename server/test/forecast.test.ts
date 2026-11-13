import { describe, expect, it } from 'vitest';

import { openDb, type Db } from '../src/db/db.js';
import {
  forecast,
  floorToReady,
  minuteOfDayWat,
  percentileNearestRank,
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
      if (isWeekday) {
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
        if (isWeekday) {
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
    expect(candidate.n).toBe(groupCount);
    expect(candidate.n).toBe(24);
    expect(candidate.n).toBeGreaterThanOrEqual(5);
    // Weekday group: every 14:40 inside [13:30, 15:00], every 19:10 outside.
    expect(candidate.score).toBeCloseTo(20 / 24, 10);
    expect(candidate.p50).toBe(14 * 60 + 40);
    expect(candidate.p10).toBe(14 * 60 + 40);
    // The four 19:10 weekday samples push p90 (index 21 of 24) to 19:10.
    expect(candidate.p90).toBe(19 * 60 + 10);
    expect(candidate.score).toBeGreaterThanOrEqual(0);
    expect(candidate.score).toBeLessThanOrEqual(1);
    // Same-day search with a stale feed never adjusts and reports unknown.
    expect(candidate.tail).toEqual({ reg: '5N-T0', status: 'unknown', adjusted: false });

    // Cross-check against the seeded rows, applying the window rule directly.
    const rows = db
      .prepare(
        `SELECT ts FROM events WHERE kind = 'DEP' AND airport = 'LOS' AND dest = 'ABV' AND flt = ?`,
      )
      .all(FLIGHT) as Array<{ ts: number }>;
    let hits = 0;
    let groupSize = 0;
    for (const row of rows) {
      const minute = minuteOfDayWat(row.ts);
      const dateWs = new Date((row.ts + 3600) * 1000);
      const dateWat = [
        dateWs.getUTCFullYear().toString().padStart(4, '0'),
        (dateWs.getUTCMonth() + 1).toString().padStart(2, '0'),
        dateWs.getUTCDate().toString().padStart(2, '0'),
      ].join('-');
      if (weekdayGroup(dateWat) !== 'weekday') {
        continue;
      }
      groupSize += 1;
      if (minute >= 13 * 60 + 30 && minute <= 15 * 60) {
        hits += 1;
      }
    }
    expect(candidate.score).toBeCloseTo(hits / groupSize, 10);
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
});
