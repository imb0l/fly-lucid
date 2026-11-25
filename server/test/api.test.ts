import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/api/app.js';
import { AIRLINES } from '../src/data/airlines.js';
import { openDb, type Db } from '../src/db/db.js';

// 2026-05-13T12:00:00Z == 13:00 WAT, so "today WAT" is 2026-05-13 for every test.
const NOW_SEC = Date.UTC(2026, 4, 13, 12, 0, 0) / 1000;
const NO_WEB_DIST = path.join(os.tmpdir(), 'fly-lucid-api-test-missing-web-dist');

const LOS = { iata: 'LOS', icao: 'DNMM', name: 'Murtala Muhammed International Airport', lat: 6.5774, lon: 3.3212 };
const ABV = { iata: 'ABV', icao: 'DNAA', name: 'Nnamdi Azikiwe International Airport', lat: 9.00679, lon: 7.26317 };

function watTs(dateWat: string, minutesOfDay: number): number {
  const [year, month, day] = dateWat.split('-').map(Number);
  // Midnight WAT is 23:00 UTC on the previous calendar day.
  return Date.UTC(year!, month! - 1, day!) / 1000 - 3600 + minutesOfDay * 60;
}

function seedDb(): Db {
  const db = openDb(':memory:');
  const insertAirport = db.prepare(
    'INSERT INTO airports (iata, icao, name, lat, lon) VALUES (?, ?, ?, ?, ?)',
  );
  insertAirport.run(LOS.iata, LOS.icao, LOS.name, LOS.lat, LOS.lon);
  insertAirport.run(ABV.iata, ABV.icao, ABV.name, ABV.lat, ABV.lon);

  db.prepare('INSERT INTO poll_log (ts, ok, aircraft, error) VALUES (?, 1, ?, NULL)').run(
    NOW_SEC - 20,
    37,
  );

  const insertState = db.prepare(
    `INSERT INTO aircraft_state
       (hex, reg, type, flt, airline, lat, lon, alt_ft, gs_kt, hdg,
        on_ground, orig, dest, ts, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertState.run(
    'ABC123', '5N-FRESH', 'B738', 'P47123', 'APO', 9.2, 7.4, 30000, 420, 30,
    0, 'ABV', 'LOS', NOW_SEC - 15, NOW_SEC - 15,
  );
  // Older than the 120 s live window: must not appear in /api/live.
  insertState.run(
    'DEF456', '5N-STALE', 'AT72', null, 'APO', 6.6, 3.4, 0, 0, null,
    1, 'LOS', 'ABV', NOW_SEC - 600, NOW_SEC - 600,
  );

  return db;
}

const DEP_DATES = ['2026-05-12', '2026-05-11', '2026-05-08', '2026-05-07', '2026-05-06'];

/** 5 weekday departures for P47443 plus a starved flight P47001 with 2 samples. */
function seedDepartures(db: Db): void {
  const insertEvent = db.prepare(
    `INSERT INTO events (hex, reg, flt, airline, kind, airport, dest, ts)
     VALUES (?, ?, ?, ?, 'DEP', ?, ?, ?)`,
  );
  DEP_DATES.forEach((dateWat, index) => {
    insertEvent.run(
      `AA${index}`, index === 0 ? '5N-LATEST' : `5N-PAST${index}`, 'P47443', 'APO',
      'LOS', 'ABV', watTs(dateWat, 14 * 60 + 40),
    );
  });
  insertEvent.run('BB0', '5N-TWO0', 'P47001', 'APO', 'LOS', 'ABV', watTs('2026-05-12', 13 * 60));
  insertEvent.run('BB1', '5N-TWO1', 'P47001', 'APO', 'LOS', 'ABV', watTs('2026-05-09', 13 * 60));
}

function makeApp(db: Db) {
  return buildApp(db, { now: () => NOW_SEC, webDist: NO_WEB_DIST });
}

describe('GET /api/health', () => {
  it('reports the last poll, freshness and the live aircraft count', async () => {
    const app = makeApp(seedDb());
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      lastPollTs: NOW_SEC - 20,
      lastPollOk: true,
      feedStale: false,
      aircraftNow: 1,
    });
    await app.close();
  });

  it('reports feedStale when the last successful poll is older than 180 s', async () => {
    const db = seedDb();
    db.prepare('DELETE FROM poll_log').run();
    db.prepare('INSERT INTO poll_log (ts, ok, aircraft, error) VALUES (?, 1, ?, NULL)').run(
      NOW_SEC - 300,
      12,
    );

    const app = makeApp(db);
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.json()).toMatchObject({
      ok: false,
      lastPollTs: NOW_SEC - 300,
      lastPollOk: true,
      feedStale: true,
    });
    await app.close();
  });
});

describe('GET /api/live', () => {
  it('returns only fresh aircraft with boolean onGround', async () => {
    const app = makeApp(seedDb());
    const response = await app.inject({ method: 'GET', url: '/api/live' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>[];
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual({
      hex: 'ABC123',
      reg: '5N-FRESH',
      type: 'B738',
      flt: 'P47123',
      airline: 'APO',
      lat: 9.2,
      lon: 7.4,
      altFt: 30000,
      gsKt: 420,
      hdg: 30,
      onGround: false,
      orig: 'ABV',
      dest: 'LOS',
      ts: NOW_SEC - 15,
    });
    await app.close();
  });
});

describe('GET /api/airports', () => {
  it('lists airports sorted by IATA code', async () => {
    const app = makeApp(seedDb());
    const response = await app.inject({ method: 'GET', url: '/api/airports' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { iata: 'ABV', name: 'Nnamdi Azikiwe International Airport' },
      { iata: 'LOS', name: 'Murtala Muhammed International Airport' },
    ]);
    await app.close();
  });
});

describe('GET /api/search validation', () => {
  const invalid: [string, unknown][] = [
    [
      '/api/search?origin=XXX&dest=ABV&date=2026-05-14&at=14:00',
      { error: 'invalid_airport', field: 'origin' },
    ],
    [
      '/api/search?origin=LOS&dest=LOS&date=2026-05-14&at=14:00',
      { error: 'invalid_airport', field: 'dest' },
    ],
    [
      '/api/search?origin=LOS&dest=ABV&date=2026-05-12&at=14:00',
      { error: 'invalid_date' },
    ],
    [
      '/api/search?origin=LOS&dest=ABV&date=2026-07-13&at=14:00',
      { error: 'invalid_date' },
    ],
    [
      '/api/search?origin=LOS&dest=ABV&date=2026-05-14&at=25:00',
      { error: 'invalid_time' },
    ],
  ];

  for (const [url, expected] of invalid) {
    it(`rejects ${url}`, async () => {
      const app = makeApp(seedDb());
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(expected);
      await app.close();
    });
  }
});

describe('GET /api/search', () => {
  it('ranks a flight from its observed departures', async () => {
    const db = seedDb();
    seedDepartures(db);
    const app = makeApp(db);
    const response = await app.inject({
      method: 'GET',
      url: '/api/search?origin=LOS&dest=ABV&date=2026-05-14&at=14:00',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      candidates: Record<string, unknown>[];
      insufficient: unknown;
    };
    expect(body).toMatchObject({
      origin: 'LOS',
      dest: 'ABV',
      date: '2026-05-14',
      at: '14:00',
      generatedAt: new Date(NOW_SEC * 1000).toISOString(),
      dataAsOf: new Date((NOW_SEC - 20) * 1000).toISOString(),
      feedStale: false,
    });
    expect(body.candidates).toEqual([
      {
        flightNo: 'P47443',
        airline: 'APO',
        airlineName: AIRLINES.APO?.name ?? null,
        bookingUrl: AIRLINES.APO?.bookingUrl ?? null,
        // All five samples are at 14:40, inside the [13:30, 15:00] window.
        score: 1,
        n: 5,
        p10: '14:40',
        p50: '14:40',
        p90: '14:40',
        safeBy: '13:42',
        tail: { reg: '5N-LATEST', status: 'unknown', adjusted: false },
      },
    ]);
    expect(body.insufficient).toEqual([{ flightNo: 'P47001', n: 2 }]);
    await app.close();
  });

  it('accepts the last supported day (today + 60)', async () => {
    const app = makeApp(seedDb());
    const response = await app.inject({
      method: 'GET',
      url: '/api/search?origin=LOS&dest=ABV&date=2026-07-12&at=14:00',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ date: '2026-07-12', at: '14:00' });
    await app.close();
  });
});

describe('GET /api/flights/:flt', () => {
  it('lists the newest departures first', async () => {
    const db = seedDb();
    seedDepartures(db);
    const app = makeApp(db);
    const response = await app.inject({
      method: 'GET',
      url: '/api/flights/P47443?origin=LOS&dest=ABV',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      flt: 'P47443',
      origin: 'LOS',
      dest: 'ABV',
      samples: DEP_DATES.map((dateWat) => ({
        dateWat,
        timeWat: '14:40',
        weekday: true,
      })),
    });
    await app.close();
  });

  it('rejects an unknown origin', async () => {
    const app = makeApp(seedDb());
    const response = await app.inject({
      method: 'GET',
      url: '/api/flights/P47443?origin=XXX&dest=ABV',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_airport', field: 'origin' });
    await app.close();
  });

  it('accepts a flight lookup without origin or destination', async () => {
    const db = seedDb();
    seedDepartures(db);
    const app = makeApp(db);
    const response = await app.inject({
      method: 'GET',
      url: '/api/flights/P47443',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      flt: 'P47443',
      origin: null,
      dest: null,
      samples: DEP_DATES.map((dateWat) => ({
        dateWat,
        timeWat: '14:40',
        weekday: true,
      })),
    });
    await app.close();
  });
});

describe('static hosting', () => {
  it('serves the SPA shell and assets from web/dist', async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-lucid-web-dist-'));
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
    fs.mkdirSync(path.join(dist, 'assets'));
    fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log("hi")');

    const app = buildApp(seedDb(), { now: () => NOW_SEC, webDist: dist });
    const shell = await app.inject({ method: 'GET', url: '/find' });
    expect(shell.statusCode).toBe(200);
    expect(shell.body).toContain('id="root"');

    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe('console.log("hi")');

    await app.close();
    fs.rmSync(dist, { recursive: true, force: true });
  });

  it('answers JSON 404 for unknown API paths', async () => {
    const app = makeApp(seedDb());
    const response = await app.inject({ method: 'GET', url: '/api/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
    await app.close();
  });

  it('answers JSON 404 for web paths when web/dist is missing', async () => {
    const app = makeApp(seedDb());
    const response = await app.inject({ method: 'GET', url: '/find' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'not_found',
      message: 'web build not found',
    });
    await app.close();
  });
});
