import type { Db } from '../db/db.js';
import type { Aircraft } from '../feed/types.js';

export interface SnapshotResult {
  deps: number;
  arrs: number;
}

/** Consecutive observations further apart than this never produce an event. */
export const MAX_EVENT_GAP_SEC = 300;

/** Aircraft states not refreshed for this long are purged. */
export const STATE_TTL_SEC = 86_400;

/** Maximum age of an open DEP event eligible for late callsign/destination backfill. */
export const BACKFILL_DEP_WINDOW_SEC = 4 * 3600;

/** Maximum distance (nm) to match a touchdown with no feed destination to a seeded airport. */
const TOUCHDOWN_AIRPORT_MAX_NM = 8;
const EARTH_RADIUS_NM = 3440.065;

function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Persist one feed snapshot and derive actual departure/arrival events from
 * on-ground state transitions. Everything runs in a single transaction.
 */
export function applySnapshot(db: Db, aircraft: Aircraft[], nowSec: number): SnapshotResult {
  const selectPrev = db.prepare<
    [string],
    {
      on_ground: number;
      flt: string | null;
      airline: string | null;
      orig: string | null;
      dest: string | null;
      ts: number;
    }
  >('SELECT on_ground, flt, airline, orig, dest, ts FROM aircraft_state WHERE hex = ?');
  const upsertState = db.prepare(`
    INSERT INTO aircraft_state (
      hex, reg, type, flt, airline, lat, lon, alt_ft, gs_kt, hdg,
      on_ground, orig, dest, ts, updated_at
    ) VALUES (
      @hex, @reg, @type, @flt, @airline, @lat, @lon, @altFt, @gsKt, @hdg,
      @onGround, @orig, @dest, @ts, @updatedAt
    )
    ON CONFLICT(hex) DO UPDATE SET
      reg = excluded.reg,
      type = excluded.type,
      flt = excluded.flt,
      airline = excluded.airline,
      lat = excluded.lat,
      lon = excluded.lon,
      alt_ft = excluded.alt_ft,
      gs_kt = excluded.gs_kt,
      hdg = excluded.hdg,
      on_ground = excluded.on_ground,
      orig = excluded.orig,
      dest = excluded.dest,
      ts = excluded.ts,
      updated_at = excluded.updated_at
  `);

  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO events (hex, reg, flt, airline, kind, airport, dest, ts)
    VALUES (@hex, @reg, @flt, @airline, @kind, @airport, @dest, @ts)
  `);

  const airportExists = db.prepare<[string], { present: number }>(
    'SELECT 1 AS present FROM airports WHERE iata = ?',
  );

  const seededAirports = db
    .prepare<[], { iata: string; lat: number; lon: number }>(
      'SELECT iata, lat, lon FROM airports WHERE lat IS NOT NULL AND lon IS NOT NULL',
    )
    .all();

  function nearestSeededAirport(lat: number, lon: number): string | null {
    let bestIata: string | null = null;
    let bestNm = TOUCHDOWN_AIRPORT_MAX_NM;
    for (const ap of seededAirports) {
      const nm = haversineNm(lat, lon, ap.lat, ap.lon);
      if (nm <= bestNm) {
        bestNm = nm;
        bestIata = ap.iata;
      }
    }
    return bestIata;
  }

  const backfillOpenDep = db.prepare(`
    UPDATE events
    SET
      flt = COALESCE(flt, @flt),
      airline = COALESCE(airline, @airline),
      dest = CASE
        WHEN dest IS NULL AND @dest IS NOT NULL AND @dest != airport THEN @dest
        ELSE dest
      END
    WHERE id = (
      SELECT id FROM events
      WHERE hex = @hex
        AND kind = 'DEP'
        AND ts >= @sinceTs
        AND ts <= @untilTs
        AND (flt IS NULL OR dest IS NULL OR airline IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM events AS arr
          WHERE arr.hex = @hex AND arr.kind = 'ARR' AND arr.ts > events.ts AND arr.ts <= @untilTs
        )
      ORDER BY ts DESC
      LIMIT 1
    )
  `);

  const hasOpenDep = db.prepare<[string, number, number], { id: number }>(`
    SELECT id FROM events
    WHERE hex = ? AND kind = 'DEP' AND ts >= ? AND ts <= ?
    ORDER BY ts DESC LIMIT 1
  `);

  const pruneStates = db.prepare<[number]>('DELETE FROM aircraft_state WHERE updated_at < ?');
  const run = db.transaction((snapshot: Aircraft[]): SnapshotResult => {
    let deps = 0;
    let arrs = 0;

    for (const cur of snapshot) {
      const prev = selectPrev.get(cur.hex);

      upsertState.run({
        hex: cur.hex,
        reg: cur.reg,
        type: cur.type,
        flt: cur.flt,
        airline: cur.airline,
        lat: cur.lat,
        lon: cur.lon,
        altFt: cur.altFt,
        gsKt: cur.gsKt,
        hdg: cur.hdg,
        onGround: cur.onGround ? 1 : 0,
        orig: cur.orig,
        dest: cur.dest,
        ts: cur.ts,
        updatedAt: nowSec,
      });

      if (
        !cur.onGround &&
        (cur.flt !== null || cur.dest !== null || cur.airline !== null)
      ) {
        const validDest =
          cur.dest !== null && airportExists.get(cur.dest) !== undefined ? cur.dest : null;
        backfillOpenDep.run({
          hex: cur.hex,
          flt: cur.flt,
          airline: cur.airline,
          dest: validDest,
          sinceTs: cur.ts - BACKFILL_DEP_WINDOW_SEC,
          untilTs: cur.ts,
        });
      }

      if (prev === undefined || cur.ts - prev.ts > MAX_EVENT_GAP_SEC) {
        continue;
      }

      if (prev.on_ground === 1 && !cur.onGround) {
        const depOrigin = cur.orig ?? prev.orig;
        if (depOrigin !== null && airportExists.get(depOrigin) !== undefined) {
          const depDest = cur.dest ?? prev.dest;
          const validDest =
            depDest !== null && airportExists.get(depDest) !== undefined ? depDest : null;
          deps += insertEvent.run({
            hex: cur.hex,
            reg: cur.reg,
            flt: cur.flt ?? prev.flt,
            airline: cur.airline ?? prev.airline,
            kind: 'DEP',
            airport: depOrigin,
            dest: validDest,
            ts: cur.ts,
          }).changes;
        }
        continue;
      }

      if (prev.on_ground === 0 && cur.onGround) {
        const explicitDest = cur.dest ?? prev.dest;
        let arrAirport: string | null = null;
        if (explicitDest !== null) {
          if (airportExists.get(explicitDest) !== undefined) {
            arrAirport = explicitDest;
          }
        } else if (
          hasOpenDep.get(cur.hex, cur.ts - BACKFILL_DEP_WINDOW_SEC, cur.ts) !== undefined
        ) {
          arrAirport = nearestSeededAirport(cur.lat, cur.lon);
        }

        if (arrAirport !== null) {
          const arrFlt = cur.flt ?? prev.flt;
          const arrAirline = cur.airline ?? prev.airline;
          backfillOpenDep.run({
            hex: cur.hex,
            flt: arrFlt,
            airline: arrAirline,
            dest: arrAirport,
            sinceTs: cur.ts - BACKFILL_DEP_WINDOW_SEC,
            untilTs: cur.ts,
          });
          arrs += insertEvent.run({
            hex: cur.hex,
            reg: cur.reg,
            flt: arrFlt,
            airline: arrAirline,
            kind: 'ARR',
            airport: arrAirport,
            dest: null,
            ts: cur.ts,
          }).changes;
        }
      }
    }

    pruneStates.run(nowSec - STATE_TTL_SEC);

    return { deps, arrs };
  });

  return run(aircraft);
}
