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

  const schemaSql = fs.readFileSync(resolveSchemaPath(), 'utf8');
  db.exec(schemaSql);
  addColumnIfMissing(db, 'events', 'sched_ts', 'INTEGER');

  return db;
}
