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

  return db;
}
