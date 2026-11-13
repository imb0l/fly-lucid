import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

interface AirportRow {
  iata: string;
  icao: string | null;
  name: string;
  lat: number | null;
  lon: number | null;
}

function resolveAirportsPath(): string {
  // Works from both src/db (tsx/vitest) and dist/db (compiled): both are two levels below server/.
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(dir, '../../data/ng-airports.json');
}

/** Upserts the committed airport list so the runtime never needs network for reference data. */
export function seedAirports(db: Db): number {
  const rows = JSON.parse(fs.readFileSync(resolveAirportsPath(), 'utf8')) as AirportRow[];
  const upsert = db.prepare(
    `INSERT INTO airports (iata, icao, name, lat, lon) VALUES (@iata, @icao, @name, @lat, @lon)
     ON CONFLICT(iata) DO UPDATE SET icao = excluded.icao, name = excluded.name, lat = excluded.lat, lon = excluded.lon`,
  );
  db.transaction((list: AirportRow[]) => {
    for (const row of list) {
      upsert.run(row);
    }
  })(rows);
  return rows.length;
}
