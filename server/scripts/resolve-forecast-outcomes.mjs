// Resolve point-in-time forecast_log rows for one target day against the
// departures the poller actually observed.
//
// Each unscored forecast is paired one-to-one with the nearest DEP event on
// flt|origin|dest within [-6h, +12h] of the forecast target_ts, and only when
// the actual is at or after issued_at - 6h (a departure before the query could
// not have been the outcome of that query). `event_max_id` is a point-in-time
// cutoff for backtests, not an upper bound on actuals, so it is not used here.
// Forecasts with no observed departure stay unscored: a missing event is
// missing data, never an invented cancellation.
//
// Usage: node server/scripts/resolve-forecast-outcomes.mjs <YYYY-MM-DD> [dbPath]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DAY_SEC = 86_400;
/** Africa/Lagos (WAT) is a fixed UTC+1 offset. */
const WAT_OFFSET_SEC = 3600;
/** How far before target_ts an observed departure may still be the actual. */
const BEFORE_SEC = 6 * 3600;
/** How far after target_ts an observed departure may still be the actual. */
const AFTER_SEC = 12 * 3600;

const day = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) {
  console.error('usage: node server/scripts/resolve-forecast-outcomes.mjs <YYYY-MM-DD> [dbPath]');
  process.exit(2);
}

const [year, month, date] = day.split('-').map(Number);
const midnightUtcMs = Date.UTC(year, month - 1, date);
if (new Date(midnightUtcMs).getUTCDate() !== date) {
  console.error(`${day} is not a real date`);
  process.exit(2);
}
const dayStart = midnightUtcMs / 1000 - WAT_OFFSET_SEC; // 00:00 WAT

const dbPath = path.resolve(
  process.argv[3] ?? process.env.FLY_DB ?? path.join(ROOT, 'server/data/fly.db'),
);
if (!fs.existsSync(dbPath)) {
  console.error(`database not found: ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('busy_timeout = 5000');
db.exec(fs.readFileSync(path.join(ROOT, 'server/src/db/schema.sql'), 'utf8'));

const forecasts = db
  .prepare(
    `SELECT f.id, f.issued_at, f.target_ts, f.flt, f.origin, f.dest,
            f.p10, f.p50, f.p90, f.safe_by
       FROM forecast_log f
      WHERE f.target_date = ?
        AND NOT EXISTS (SELECT 1 FROM forecast_outcome o WHERE o.forecast_id = f.id)
      ORDER BY f.id`,
  )
  .all(day);

const events = db
  .prepare(
    `SELECT id, flt, airport, dest, ts
       FROM events
      WHERE kind = 'DEP' AND flt IS NOT NULL AND dest IS NOT NULL
        AND ts >= ? AND ts <= ?
      ORDER BY ts, id`,
  )
  .all(dayStart - BEFORE_SEC, dayStart + DAY_SEC + AFTER_SEC);

const byRoute = new Map();
for (const event of events) {
  const key = `${event.flt}|${event.airport}|${event.dest}`;
  const bucket = byRoute.get(key);
  if (bucket === undefined) {
    byRoute.set(key, [event]);
  } else {
    bucket.push(event);
  }
}

/** Every admissible (forecast, actual) pair, nearest first. */
const pairs = [];
for (const forecast of forecasts) {
  const bucket = byRoute.get(`${forecast.flt}|${forecast.origin}|${forecast.dest}`);
  if (bucket === undefined) continue;
  for (const event of bucket) {
    if (event.ts < forecast.target_ts - BEFORE_SEC) continue;
    if (event.ts > forecast.target_ts + AFTER_SEC) continue;
    if (event.ts < forecast.issued_at - BEFORE_SEC) continue;
    pairs.push({ forecast, event, delta: Math.abs(event.ts - forecast.target_ts) });
  }
}
pairs.sort(
  (a, b) => a.delta - b.delta || a.forecast.id - b.forecast.id || a.event.id - b.event.id,
);

// Greedy nearest-first assignment keeps the match one-to-one on both sides.
const scoredForecast = new Set();
const usedEvent = new Set();
const matches = [];
for (const pair of pairs) {
  if (scoredForecast.has(pair.forecast.id) || usedEvent.has(pair.event.id)) continue;
  scoredForecast.add(pair.forecast.id);
  usedEvent.add(pair.event.id);
  matches.push(pair);
}

const insertOutcome = db.prepare(
  `INSERT OR REPLACE INTO forecast_outcome (
     forecast_id, actual_ts, actual_min, residual_min, in_interval, early,
     outcome, matched_by, scored_at
   ) VALUES (?, ?, ?, ?, ?, ?, 'matched', ?, ?)`,
);

const scoredAt = Math.floor(Date.now() / 1000);
const writeOutcomes = db.transaction((rows) => {
  for (const { forecast, event } of rows) {
    // Minutes since 00:00 WAT of the target day, so late-evening departures
    // that slip past midnight stay comparable with p50 instead of wrapping.
    const actualMin = Math.round((event.ts - dayStart) / 60);
    const residualMin = forecast.p50 === null ? null : actualMin - forecast.p50;
    const inInterval =
      forecast.p10 === null || forecast.p90 === null
        ? null
        : actualMin >= forecast.p10 && actualMin <= forecast.p90
          ? 1
          : 0;
    const early =
      forecast.safe_by === null
        ? null
        : event.ts < dayStart + forecast.safe_by * 60
          ? 1
          : 0;
    insertOutcome.run(
      forecast.id,
      event.ts,
      actualMin,
      residualMin,
      inInterval,
      early,
      `dep:${event.id}`,
      scoredAt,
    );
  }
});

writeOutcomes(matches);
db.close();

const unscored = forecasts.length - matches.length;
const residuals = matches
  .map(({ forecast, event }) =>
    forecast.p50 === null ? null : Math.round((event.ts - dayStart) / 60) - forecast.p50,
  )
  .filter((value) => value !== null);
const mae =
  residuals.length === 0
    ? 'n/a'
    : (residuals.reduce((sum, value) => sum + Math.abs(value), 0) / residuals.length).toFixed(1);

console.log(`resolved ${day}: ${matches.length} matched, ${unscored} still unscored (MAE ${mae} min)`);
