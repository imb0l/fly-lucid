import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { AIRLINES } from '../data/airlines.js';
import type { Db } from '../db/db.js';
import {
  FEED_STALE_SEC,
  LOOKBACK_DAYS,
  MAX_DAYS_AHEAD,
  forecast,
  minuteOfDayWat,
  todayWat,
  watDateStr,
  weekdayGroup,
  type TailInfo,
} from '../model/forecast.js';
import {
  createQueries,
  type AirportSummary,
  type HealthResponse,
  type LiveAircraft,
} from './queries.js';

/** `/api/live` is served from memory for this long. */
const LIVE_CACHE_MS = 5_000;
const DAY_SEC = 86_400;

const iataSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z]{3}$/.test(value));

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export interface BuildAppOptions {
  /** Static site root; defaults to `<repo>/web/dist`. */
  webDist?: string;
  /** Clock in UTC epoch seconds; injected by tests. */
  now?: () => number;
  logger?: boolean;
}

export interface SearchCandidate {
  flightNo: string;
  airline: string | null;
  airlineName: string | null;
  bookingUrl: string | null;
  score: number;
  n: number;
  p10: string;
  p50: string;
  p90: string;
  tail: TailInfo;
}

export interface SearchResponse {
  origin: string;
  dest: string;
  date: string;
  at: string;
  generatedAt: string;
  dataAsOf: string | null;
  feedStale: boolean;
  candidates: SearchCandidate[];
  insufficient: { flightNo: string; n: number }[];
}

export interface FlightSamplesResponse {
  flt: string;
  origin: string;
  dest: string;
  samples: { dateWat: string; timeWat: string; weekday: boolean }[];
}

interface InvalidAirport {
  error: 'invalid_airport';
  field: 'origin' | 'dest';
}

interface InvalidDate {
  error: 'invalid_date';
}

interface InvalidTime {
  error: 'invalid_time';
}

/** `HH:MM` in WAT for a minute-of-day value. */
function formatWatTime(minutesOfDay: number): string {
  const hours = Math.floor(minutesOfDay / 60);
  const minutes = minutesOfDay % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

/** Day number (days since the Unix epoch) for a valid `YYYY-MM-DD`, else `null`. */
function watDateToDayNumber(dateWat: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateWat);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcMs = Date.UTC(year, month - 1, day);
  const roundTrip = new Date(utcMs);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(utcMs / (DAY_SEC * 1000));
}

function parseIata(value: unknown): string | null {
  const parsed = iataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function resolveWebDist(explicit: string | undefined): string {
  if (explicit !== undefined) {
    return path.resolve(explicit);
  }
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(dir, '../../../web/dist');
}

/**
 * Build the HTTP API without listening, so tests can use `app.inject`.
 * Every route is read-only; the poller owns all writes.
 */
export function buildApp(db: Db, options: BuildAppOptions = {}): FastifyInstance {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const queries = createQueries(db);
  const app = Fastify({ logger: options.logger ?? false });

  const webDist = resolveWebDist(options.webDist ?? process.env.WEB_DIST);
  const staticRoot =
    fs.existsSync(path.join(webDist, 'index.html')) ? webDist : null;

  let liveCache: { expiresAtMs: number; body: LiveAircraft[] } | null = null;

  app.get('/api/health', (_request, reply) => {
    const health: HealthResponse = queries.health(now());
    return reply.send(health);
  });

  app.get('/api/live', (_request, reply) => {
    const nowSec = now();
    const nowMs = nowSec * 1000;
    if (liveCache === null || liveCache.expiresAtMs <= nowMs) {
      liveCache = {
        expiresAtMs: nowMs + LIVE_CACHE_MS,
        body: queries.liveAircraft(nowSec),
      };
    }
    return reply.header('cache-control', 'no-store').send(liveCache.body);
  });

  app.get('/api/airports', (_request, reply) => {
    const airports: AirportSummary[] = queries.airports();
    return reply.send(airports);
  });

  app.get('/api/search', (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const nowSec = now();

    const origin = parseIata(query.origin);
    if (origin === null || queries.airportName(origin) === null) {
      const body: InvalidAirport = { error: 'invalid_airport', field: 'origin' };
      return reply.code(400).send(body);
    }

    const dest = parseIata(query.dest);
    if (dest === null || queries.airportName(dest) === null) {
      const body: InvalidAirport = { error: 'invalid_airport', field: 'dest' };
      return reply.code(400).send(body);
    }

    if (origin === dest) {
      const body: InvalidAirport = { error: 'invalid_airport', field: 'dest' };
      return reply.code(400).send(body);
    }

    const dateParsed = dateSchema.safeParse(query.date);
    if (!dateParsed.success) {
      const body: InvalidDate = { error: 'invalid_date' };
      return reply.code(400).send(body);
    }
    const dateWat = dateParsed.data;
    const dayNumber = watDateToDayNumber(dateWat);
    const todayNumber = watDateToDayNumber(todayWat(nowSec));
    if (
      dayNumber === null ||
      todayNumber === null ||
      dayNumber < todayNumber ||
      dayNumber > todayNumber + MAX_DAYS_AHEAD
    ) {
      const body: InvalidDate = { error: 'invalid_date' };
      return reply.code(400).send(body);
    }

    const atParsed = timeSchema.safeParse(query.at);
    if (!atParsed.success) {
      const body: InvalidTime = { error: 'invalid_time' };
      return reply.code(400).send(body);
    }
    const at = atParsed.data;
    const atMin = Number(at.slice(0, 2)) * 60 + Number(at.slice(3, 5));

    const lastPollOkTs = queries.latestPollOkTs();
    const feedStale =
      lastPollOkTs === null || nowSec - lastPollOkTs > FEED_STALE_SEC;

    const result = forecast(db, {
      origin,
      dest,
      dateWat,
      atMin,
      nowSec,
      feedStale,
    });

    const body: SearchResponse = {
      origin,
      dest,
      date: dateWat,
      at,
      generatedAt: new Date(nowSec * 1000).toISOString(),
      dataAsOf:
        lastPollOkTs === null
          ? null
          : new Date(lastPollOkTs * 1000).toISOString(),
      feedStale,
      candidates: result.candidates.map((candidate) => {
        const airline = candidate.airline;
        const info = airline === null ? undefined : AIRLINES[airline];
        return {
          flightNo: candidate.flightNo,
          airline,
          airlineName: info?.name ?? null,
          bookingUrl: info?.bookingUrl ?? null,
          score: Math.round(candidate.score * 100) / 100,
          n: candidate.n,
          p10: formatWatTime(candidate.p10),
          p50: formatWatTime(candidate.p50),
          p90: formatWatTime(candidate.p90),
          tail: {
            reg: candidate.tail.reg,
            status: candidate.tail.status,
            adjusted: candidate.tail.adjusted,
          },
        };
      }),
      insufficient: result.insufficient.map((entry) => ({
        flightNo: entry.flightNo,
        n: entry.n,
      })),
    };

    return reply.send(body);
  });

  app.get<{ Params: { flt: string } }>('/api/flights/:flt', (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const nowSec = now();

    const origin = parseIata(query.origin);
    if (origin === null || queries.airportName(origin) === null) {
      const body: InvalidAirport = { error: 'invalid_airport', field: 'origin' };
      return reply.code(400).send(body);
    }

    const dest = parseIata(query.dest);
    if (dest === null || queries.airportName(dest) === null) {
      const body: InvalidAirport = { error: 'invalid_airport', field: 'dest' };
      return reply.code(400).send(body);
    }

    const flt = request.params.flt.trim();
    const sinceTs = nowSec - LOOKBACK_DAYS * DAY_SEC;
    const samples = queries
      .departureSamples(flt, origin, dest, sinceTs)
      .map((ts) => {
        const dateWat = watDateStr(ts);
        return {
          dateWat,
          timeWat: formatWatTime(minuteOfDayWat(ts)),
          weekday: weekdayGroup(dateWat) === 'weekday',
        };
      });

    const body: FlightSamplesResponse = { flt, origin, dest, samples };
    return reply.send(body);
  });

  if (staticRoot !== null) {
    app.register(fastifyStatic, { root: staticRoot, prefix: '/' });
  }

  app.setNotFoundHandler((request, reply) => {
    const url = request.raw.url ?? '';
    if (url === '/api' || url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (staticRoot === null) {
      return reply
        .code(404)
        .send({ error: 'not_found', message: 'web build not found' });
    }
    return reply.sendFile('index.html');
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    request.log.error({ err: error }, 'api error');
    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: 'bad_request' });
    }
    return reply.code(500).send({ error: 'internal_error' });
  });

  return app;
}
