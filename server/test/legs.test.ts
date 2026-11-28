import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { openDb, type Db } from '../src/db/db.js';
import { parseSnapshot } from '../src/feed/fr24.js';
import type { Aircraft } from '../src/feed/types.js';
import { applySnapshot } from '../src/ingest/legs.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8')) as unknown;
}

function makeDb(): Db {
  const db = openDb(':memory:');
  const insertAirport = db.prepare(
    'INSERT INTO airports (iata, icao, name, lat, lon) VALUES (?, ?, ?, ?, ?)',
  );
  insertAirport.run('LOS', 'DNMM', 'Murtala Muhammed International', 6.5774, 3.3212);
  insertAirport.run('ABV', 'DNAA', 'Nnamdi Azikiwe International', 9.0068, 7.2632);
  return db;
}

const BASE_AIRCRAFT: Aircraft = {
  hex: 'TEST01',
  reg: '5N-TEST',
  type: 'B738',
  flt: 'P47443',
  airline: 'APO',
  lat: 6.5774,
  lon: 3.3212,
  altFt: 0,
  gsKt: 0,
  hdg: 0,
  onGround: true,
  orig: 'LOS',
  dest: 'ABV',
  ts: 1000,
};

function observe(overrides: Partial<Aircraft>): Aircraft {
  return { ...BASE_AIRCRAFT, ...overrides };
}

interface EventRow {
  hex: string;
  kind: string;
  airport: string;
  dest: string | null;
  ts: number;
  flt: string | null;
}

function eventRows(db: Db): EventRow[] {
  return db
    .prepare<[], EventRow>('SELECT hex, kind, airport, dest, ts, flt FROM events ORDER BY ts, kind')
    .all();
}

describe('applySnapshot transitions', () => {
  it('derives exactly one DEP and one ARR from the documented observation sequence', () => {
    const db = makeDb();
    const counts: Array<{ deps: number; arrs: number }> = [];

    // 1000 gnd=1, 1030 gnd=1 look like a parked aircraft.
    counts.push(applySnapshot(db, [observe({ ts: 1000 })], 1000));
    counts.push(applySnapshot(db, [observe({ ts: 1030 })], 1030));
    // 1060 airborne -> departure at LOS.
    counts.push(applySnapshot(db, [observe({ ts: 1060, onGround: false, altFt: 2000, gsKt: 180 })], 1060));
    // 1090 still airborne -> no event.
    counts.push(applySnapshot(db, [observe({ ts: 1090, onGround: false, altFt: 12000, gsKt: 420 })], 1090));
    // 1120 on ground at ABV -> arrival.
    counts.push(applySnapshot(db, [observe({ ts: 1120, onGround: true, altFt: 0, gsKt: 0, orig: 'LOS', dest: 'ABV' })], 1120));
    // 1500 airborne again, but 1500 - 1120 > 300 -> no departure.
    counts.push(applySnapshot(db, [observe({ ts: 1500, onGround: false, orig: 'ABV', dest: 'LOS' })], 1500));

    expect(counts.map((c) => c.deps)).toEqual([0, 0, 1, 0, 0, 0]);
    expect(counts.map((c) => c.arrs)).toEqual([0, 0, 0, 0, 1, 0]);

    const events = eventRows(db);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      hex: 'TEST01',
      kind: 'DEP',
      airport: 'LOS',
      dest: 'ABV',
      ts: 1060,
      flt: 'P47443',
    });
    expect(events[1]).toMatchObject({
      hex: 'TEST01',
      kind: 'ARR',
      airport: 'ABV',
      dest: null,
      ts: 1120,
      flt: 'P47443',
    });
  });

  it('suppresses duplicate events through the UNIQUE(hex, kind, ts) constraint', () => {
    const db = makeDb();
    applySnapshot(db, [observe({ ts: 1000 })], 1000);
    applySnapshot(db, [observe({ ts: 1030 })], 1030);
    const takeoff = observe({ ts: 1060, onGround: false, altFt: 2000, gsKt: 180 });

    expect(applySnapshot(db, [takeoff], 1060).deps).toBe(1);
    // Replay the same observation against the previous stored state.
    db.prepare("UPDATE aircraft_state SET on_ground = 1, ts = 1030 WHERE hex = 'TEST01'").run();

    expect(applySnapshot(db, [takeoff], 1060).deps).toBe(0);
    expect(eventRows(db)).toHaveLength(1);
  });

  it('ignores events at airports missing from the airports table', () => {
    const db = makeDb();
    applySnapshot(db, [observe({ ts: 2000, orig: 'KAN' })], 2000);
    const counts = applySnapshot(db, [observe({ ts: 2030, orig: 'KAN', onGround: false })], 2030);

    expect(counts).toEqual({ deps: 0, arrs: 0 });
    expect(eventRows(db)).toHaveLength(0);
  });

  it('recovers a null takeoff origin from the nearest seeded airport within 8 nm', () => {
    const db = makeDb();
    applySnapshot(
      db,
      [observe({ ts: 3000, orig: null, dest: 'ABV', lat: 6.595, lon: 3.34 })],
      3000,
    );

    const counts = applySnapshot(
      db,
      [
        observe({
          ts: 3030,
          orig: null,
          dest: 'ABV',
          lat: 6.595,
          lon: 3.34,
          onGround: false,
          altFt: 1500,
          gsKt: 160,
        }),
      ],
      3030,
    );

    expect(counts).toEqual({ deps: 1, arrs: 0 });
    expect(eventRows(db)).toEqual([
      { hex: 'TEST01', kind: 'DEP', airport: 'LOS', dest: 'ABV', ts: 3030, flt: 'P47443' },
    ]);
  });

  it('does not invent a takeoff origin when no seeded airport is within 8 nm', () => {
    const db = makeDb();
    applySnapshot(db, [observe({ ts: 4000, orig: null, lat: 0, lon: 0 })], 4000);

    const counts = applySnapshot(
      db,
      [observe({ ts: 4030, orig: null, lat: 0, lon: 0, onGround: false, altFt: 900, gsKt: 140 })],
      4030,
    );

    expect(counts).toEqual({ deps: 0, arrs: 0 });
    expect(eventRows(db)).toHaveLength(0);
  });

  it('upserts aircraft_state and prunes rows older than a day', () => {
    const db = makeDb();
    applySnapshot(db, [observe({ ts: 5000, onGround: false, flt: null })], 5000);
    expect(db.prepare('SELECT count(*) AS n FROM aircraft_state').get()).toEqual({ n: 1 });

    applySnapshot(db, [observe({ ts: 5010, onGround: false, flt: 'P47443' })], 5010);
    expect(db.prepare('SELECT flt, on_ground, ts, updated_at FROM aircraft_state').get()).toEqual({
      flt: 'P47443',
      on_ground: 0,
      ts: 5010,
      updated_at: 5010,
    });

    applySnapshot(db, [], 5010 + 86_401);
    expect(db.prepare('SELECT count(*) AS n FROM aircraft_state').get()).toEqual({ n: 0 });
  });

  it('backfills a null DEP destination on touchdown when the feed omits destination in flight (UY433 pattern)', () => {
    const db = makeDb();
    // Parked at LOS with no destination in feed.
    applySnapshot(db, [observe({ ts: 1000, flt: 'UY433', orig: 'LOS', dest: null })], 1000);
    // Takeoff at LOS with dest still null.
    applySnapshot(
      db,
      [observe({ ts: 1060, flt: 'UY433', orig: 'LOS', dest: null, onGround: false, altFt: 2600, gsKt: 180 })],
      1060,
    );
    expect(eventRows(db)).toEqual([
      { hex: 'TEST01', kind: 'DEP', airport: 'LOS', dest: null, ts: 1060, flt: 'UY433' },
    ]);

    // Touchdown at ABV coordinates (9.0068, 7.2632) with dest still null in feed.
    const res = applySnapshot(
      db,
      [
        observe({
          ts: 1300,
          flt: 'UY433',
          orig: 'LOS',
          dest: null,
          onGround: true,
          lat: 9.0068,
          lon: 7.2632,
          altFt: 0,
          gsKt: 0,
        }),
      ],
      1300,
    );
    expect(res).toEqual({ deps: 0, arrs: 1 });
    expect(eventRows(db)).toEqual([
      { hex: 'TEST01', kind: 'DEP', airport: 'LOS', dest: 'ABV', ts: 1060, flt: 'UY433' },
      { hex: 'TEST01', kind: 'ARR', airport: 'ABV', dest: null, ts: 1300, flt: 'UY433' },
    ]);
  });

  it('backfills a null DEP flight number and destination when they appear on a later airborne frame', () => {
    const db = makeDb();
    applySnapshot(db, [observe({ ts: 1000, flt: null, orig: 'LOS', dest: null })], 1000);
    applySnapshot(
      db,
      [observe({ ts: 1030, flt: null, orig: 'LOS', dest: null, onGround: false, altFt: 1500, gsKt: 165 })],
      1030,
    );
    expect(eventRows(db)[0]).toMatchObject({ kind: 'DEP', airport: 'LOS', dest: null, flt: null });

    applySnapshot(
      db,
      [observe({ ts: 1090, flt: 'P47443', orig: 'LOS', dest: 'ABV', onGround: false, altFt: 6500, gsKt: 260 })],
      1090,
    );
    expect(eventRows(db)).toEqual([
      { hex: 'TEST01', kind: 'DEP', airport: 'LOS', dest: 'ABV', ts: 1030, flt: 'P47443' },
    ]);
  });
});

describe('applySnapshot replay of the saved fixtures', () => {
  it('replays both snapshots without errors and stores every aircraft once', () => {
    const snapshot1 = parseSnapshot(loadFixture('fr24-snapshot-1.json'));
    const snapshot2 = parseSnapshot(loadFixture('fr24-snapshot-2.json'));
    expect(snapshot1.length).toBeGreaterThan(0);
    expect(snapshot2.length).toBeGreaterThan(0);

    const db = openDb(':memory:');
    const insertAirport = db.prepare(
      'INSERT OR IGNORE INTO airports (iata, icao, name, lat, lon) VALUES (?, ?, ?, ?, ?)',
    );
    for (const code of new Set([...snapshot1, ...snapshot2].flatMap((a) => [a.orig, a.dest]))) {
      if (code === null) {
        continue;
      }
      const lat = code === 'LOS' ? 6.5774 : code === 'ABV' ? 9.0068 : null;
      const lon = code === 'LOS' ? 3.3212 : code === 'ABV' ? 7.2632 : null;
      insertAirport.run(code, null, code, lat, lon);
    }
    // Only LOS and ABV are fully seeded; other codes keep NULL coordinates.
    db.prepare("UPDATE airports SET icao = 'DNMM', name = 'Murtala Muhammed International' WHERE iata = 'LOS'").run();
    db.prepare("UPDATE airports SET icao = 'DNAA', name = 'Nnamdi Azikiwe International' WHERE iata = 'ABV'").run();

    const ts1 = Math.max(...snapshot1.map((a) => a.ts));
    const ts2 = Math.max(...snapshot2.map((a) => a.ts));
    const first = applySnapshot(db, snapshot1, ts1);
    const second = applySnapshot(db, snapshot2, ts2);

    const distinctHex = new Set([...snapshot1, ...snapshot2].map((a) => a.hex)).size;
    const stateCount = db.prepare<[], { n: number }>('SELECT count(*) AS n FROM aircraft_state').get();
    expect(stateCount).toEqual({ n: distinctHex });

    const events = eventRows(db);
    for (const event of events) {
      expect(event.flt).not.toBeNull();
      expect(event.airport).not.toBeNull();
      expect(event.ts).not.toBeNull();
    }
    expect(events.length).toBe(first.deps + first.arrs + second.deps + second.arrs);

    // Recorded for the plan's replay report.
    console.log(
      JSON.stringify({
        aircraft_state: stateCount?.n,
        deps: first.deps + second.deps,
        arrs: first.arrs + second.arrs,
        events: events.length,
      }),
    );
  });
});
