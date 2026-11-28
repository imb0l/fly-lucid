import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

function resolveSchemaPath(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const localPath = path.join(dir, 'schema.sql');
  if (fs.existsSync(localPath)) {
    return localPath;
  }
  const srcPath = path.resolve(dir, '../../src/db/schema.sql');
  if (fs.existsSync(srcPath)) {
    return srcPath;
  }
  throw new Error(`schema.sql not found at ${localPath} or ${srcPath}`);
}

/** Add a column to an existing table; older databases predate it. */
function addColumnIfMissing(db: Db, table: string, column: string, type: string): void {
  const cols = db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/** Model version stamped on every `/api/search` audit row. */
export const FORECAST_MODEL_VERSION = 'live-v3-2026-11-28';

/** One point-in-time forecast exactly as issued, before any calibration. */
export interface ForecastLogRow {
  forecastKey: string;
  issuedAt: number;
  targetTs: number;
  targetDate: string;
  horizonMin: number;
  flt: string;
  airline: string | null;
  origin: string;
  dest: string;
  atMin: number;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  safeBy: number | null;
  n: number | null;
  score: number | null;
  tailReg: string | null;
  tailStatus: string | null;
  tailAdjusted: boolean;
  feedStale: boolean;
  eventMaxId: number | null;
  createdAt: number;
}

export interface ForecastLogger {
  /** `max(events.id)` now: the point-in-time cutoff for a request. */
  eventMaxId(): number | null;
  /** Append one audit row; a repeat of the same `forecastKey` is ignored. */
  insert(row: ForecastLogRow): void;
}

/**
 * Append-only forecast audit log. Rows are immutable point-in-time records:
 * `INSERT OR IGNORE` keeps a repeated request in the same second from
 * duplicating, and never overwrites what was issued earlier.
 */
export function createForecastLogger(db: Db): ForecastLogger {
  const maxEventId = db.prepare<[], { id: number | null }>(
    'SELECT max(id) AS id FROM events',
  );
  const insertRow = db.prepare(
    `INSERT OR IGNORE INTO forecast_log (
       forecast_key, issued_at, target_ts, target_date, horizon_min, flt,
       airline, origin, dest, at_min, p10, p50, p90, safe_by, n, score,
       tail_reg, tail_status, tail_adjusted, feed_stale, event_max_id,
       model_version, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  return {
    eventMaxId(): number | null {
      return maxEventId.get()?.id ?? null;
    },
    insert(row: ForecastLogRow): void {
      insertRow.run(
        row.forecastKey,
        row.issuedAt,
        row.targetTs,
        row.targetDate,
        row.horizonMin,
        row.flt,
        row.airline,
        row.origin,
        row.dest,
        row.atMin,
        row.p10,
        row.p50,
        row.p90,
        row.safeBy,
        row.n,
        row.score,
        row.tailReg,
        row.tailStatus,
        row.tailAdjusted ? 1 : 0,
        row.feedStale ? 1 : 0,
        row.eventMaxId,
        FORECAST_MODEL_VERSION,
        row.createdAt,
      );
    },
  };
}

export function openDb(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (dir && dir !== '.') {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  // Every statement in schema.sql is idempotent (`CREATE ... IF NOT EXISTS`),
  // so running it against an existing database is the guarded migration path
  // for new tables and indexes (including `forecast_log`/`forecast_outcome`).
  const schemaSql = fs.readFileSync(resolveSchemaPath(), 'utf8');
  db.exec(schemaSql);
  addColumnIfMissing(db, 'events', 'sched_ts', 'INTEGER');

  return db;
}
