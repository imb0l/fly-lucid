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

/**
 * Persist one feed snapshot and derive actual departure/arrival events from
 * on-ground state transitions. Everything runs in a single transaction.
 */
export function applySnapshot(db: Db, aircraft: Aircraft[], nowSec: number): SnapshotResult {
  const selectPrev = db.prepare<
    [string],
    { on_ground: number; orig: string | null; dest: string | null; ts: number }
  >('SELECT on_ground, orig, dest, ts FROM aircraft_state WHERE hex = ?');

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

      if (prev === undefined || cur.ts - prev.ts > MAX_EVENT_GAP_SEC) {
        continue;
      }

      if (prev.on_ground === 1 && !cur.onGround && cur.orig !== null) {
        if (airportExists.get(cur.orig) !== undefined) {
          deps += insertEvent.run({
            hex: cur.hex,
            reg: cur.reg,
            flt: cur.flt,
            airline: cur.airline,
            kind: 'DEP',
            airport: cur.orig,
            dest: cur.dest,
            ts: cur.ts,
          }).changes;
        }
        continue;
      }

      if (prev.on_ground === 0 && cur.onGround && cur.dest !== null) {
        if (airportExists.get(cur.dest) !== undefined) {
          arrs += insertEvent.run({
            hex: cur.hex,
            reg: cur.reg,
            flt: cur.flt,
            airline: cur.airline,
            kind: 'ARR',
            airport: cur.dest,
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
