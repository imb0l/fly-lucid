import { openDb } from './db/db.js';
import { seedAirports } from './db/seed-airports.js';
import { FEED_URL } from './feed/fr24.js';
import { DEFAULT_POLL_MS, runPoller } from './ingest/poller.js';

const dbPath = process.env.DB_PATH ?? './data/fly.db';
const feedUrl = process.env.FEED_URL ?? FEED_URL;
const pollMs = process.env.POLL_MS === undefined ? DEFAULT_POLL_MS : Number(process.env.POLL_MS);

const controller = new AbortController();
let stopping = false;

function stop(signal: NodeJS.Signals): void {
  if (stopping) {
    return;
  }
  stopping = true;
  console.log(`poller: received ${signal}, shutting down`);
  controller.abort();
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const db = openDb(dbPath);
seedAirports(db);

try {
  await runPoller({ db, feedUrl, pollMs, signal: controller.signal });
  db.close();
  process.exit(0);
} catch (error) {
  console.error(`poller: ${error instanceof Error ? error.message : String(error)}`);
  db.close();
  process.exit(1);
}
