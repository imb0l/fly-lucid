import type { Db } from '../db/db.js';
import { FEED_STALE_SEC } from '../model/forecast.js';

/** Aircraft states must be this fresh to be shown on the live map. */
export const LIVE_WINDOW_SEC = 120;

export interface HealthResponse {
  ok: boolean;
  lastPollTs: number | null;
  lastPollOk: boolean | null;
  lastPollOkTs: number | null;
  feedStale: boolean;
  aircraftNow: number;
}

export interface LiveAircraft {
  hex: string;
  reg: string | null;
  type: string | null;
  flt: string | null;
  airline: string | null;
  lat: number;
  lon: number;
  altFt: number | null;
  gsKt: number | null;
  hdg: number | null;
  onGround: boolean;
  orig: string | null;
  dest: string | null;
  ts: number;
}

export interface AirportSummary {
  iata: string;
  name: string;
}

interface PollRow {
  ts: number;
  ok: number;
}

interface SuccessRow {
  ts: number | null;
}

interface CountRow {
  n: number;
}

interface AircraftRow {
  hex: string;
  reg: string | null;
  type: string | null;
  flt: string | null;
  airline: string | null;
  lat: number;
  lon: number;
  alt_ft: number | null;
  gs_kt: number | null;
  hdg: number | null;
  on_ground: number;
  orig: string | null;
  dest: string | null;
  ts: number;
}

interface TimestampRow {
  ts: number;
}

export interface ApiQueries {
  health(nowSec: number): HealthResponse;
  liveAircraft(nowSec: number): LiveAircraft[];
  airports(): AirportSummary[];
  /** Airport display name, or `null` when the IATA code is not in `airports`. */
  airportName(iata: string): string | null;
  /** Timestamp of the most recent successful poll, or `null` when never polled. */
  latestPollOkTs(): number | null;
  /** Departure timestamps for a flight on a route, newest first. */
  departureSamples(flt: string, origin: string | null, dest: string | null, sinceTs: number): number[];
}

/**
 * Prepared statements shared by every API route. Statements belong to one
 * connection, so they are created once per `buildApp` call rather than lazily.
 */
export function createQueries(db: Db): ApiQueries {
  const lastPoll = db.prepare<[], PollRow>(
    'SELECT ts, ok FROM poll_log ORDER BY id DESC LIMIT 1',
  );
  const lastPollOk = db.prepare<[], SuccessRow>(
    'SELECT max(ts) AS ts FROM poll_log WHERE ok = 1',
  );
  const liveCount = db.prepare<[number, number], CountRow>(
    `SELECT count(*) AS n
       FROM aircraft_state
      WHERE updated_at >= ? AND ts >= ?`,
  );
  const liveRows = db.prepare<[number, number], AircraftRow>(
    `SELECT hex, reg, type, flt, airline, lat, lon, alt_ft, gs_kt, hdg,
            on_ground, orig, dest, ts
       FROM aircraft_state
      WHERE updated_at >= ? AND ts >= ?
      ORDER BY hex`,
  );
  const airportRows = db.prepare<[], AirportSummary>(
    'SELECT iata, name FROM airports ORDER BY iata',
  );
  const airportByName = db.prepare<[string], { name: string }>(
    'SELECT name FROM airports WHERE iata = ?',
  );
  const depRowsByOrigin = db.prepare<[string, string | null, string | null, string, number], TimestampRow>(
    `SELECT ts FROM events
      WHERE kind = 'DEP' AND airport = ? AND (? IS NULL OR dest = ?)
        AND flt = ? AND ts >= ?
      ORDER BY ts DESC`,
  );
  const depRowsAnyOrigin = db.prepare<[string | null, string | null, string, number], TimestampRow>(
    `SELECT ts FROM events
      WHERE kind = 'DEP' AND (? IS NULL OR dest = ?)
        AND flt = ? AND ts >= ?
      ORDER BY ts DESC`,
  );

  return {
    health(nowSec: number): HealthResponse {
      const poll = lastPoll.get();
      const lastSuccessfulTs = lastPollOk.get()?.ts ?? null;
      const feedStale =
        lastSuccessfulTs === null || nowSec - lastSuccessfulTs > FEED_STALE_SEC;
      const liveCutoff = nowSec - LIVE_WINDOW_SEC;
      const aircraftNow = liveCount.get(liveCutoff, liveCutoff)?.n ?? 0;
      const lastPollOkValue = poll === undefined ? null : poll.ok === 1;
      return {
        ok: lastPollOkValue === true && !feedStale,
        lastPollTs: poll?.ts ?? null,
        lastPollOk: lastPollOkValue,
        lastPollOkTs: lastSuccessfulTs,
        feedStale,
        aircraftNow,
      };
    },

    liveAircraft(nowSec: number): LiveAircraft[] {
      const liveCutoff = nowSec - LIVE_WINDOW_SEC;
      return liveRows.all(liveCutoff, liveCutoff).map((row) => ({
        hex: row.hex,
        reg: row.reg,
        type: row.type,
        flt: row.flt,
        airline: row.airline,
        lat: row.lat,
        lon: row.lon,
        altFt: row.alt_ft,
        gsKt: row.gs_kt,
        hdg: row.hdg,
        onGround: row.on_ground === 1,
        orig: row.orig,
        dest: row.dest,
        ts: row.ts,
      }));
    },

    airports(): AirportSummary[] {
      return airportRows.all();
    },

    airportName(iata: string): string | null {
      return airportByName.get(iata)?.name ?? null;
    },

    latestPollOkTs(): number | null {
      return lastPollOk.get()?.ts ?? null;
    },

    departureSamples(
      flt: string,
      origin: string | null,
      dest: string | null,
      sinceTs: number,
    ): number[] {
      const rows =
        origin !== null
          ? depRowsByOrigin.all(origin, dest, dest, flt, sinceTs)
          : depRowsAnyOrigin.all(dest, dest, flt, sinceTs);
      return rows.map((row) => row.ts);
    },
  };
}
