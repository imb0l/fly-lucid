import { buildApp } from './api/app.js';
import { openDb } from './db/db.js';
import { seedAirports } from './db/seed-airports.js';

const dbPath = process.env.DB_PATH ?? './data/fly.db';
const port = process.env.PORT === undefined ? 8787 : Number(process.env.PORT);

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`api: invalid PORT: ${String(process.env.PORT)}`);
  process.exit(1);
}

const db = openDb(dbPath);
const airportCount = seedAirports(db);
const app = buildApp(db, { logger: true });

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info(`api: received ${signal}, shutting down`);
  try {
    await app.close();
  } finally {
    db.close();
    process.exit(0);
  }
};

const handleSignal = (signal: NodeJS.Signals): void => {
  void shutdown(signal);
};

process.once('SIGINT', handleSignal);
process.once('SIGTERM', handleSignal);

try {
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`api: ${airportCount} airports loaded from ${dbPath}`);
} catch (error) {
  console.error(
    `api: failed to listen on port ${port}: ${error instanceof Error ? error.message : String(error)}`,
  );
  db.close();
  process.exit(1);
}
