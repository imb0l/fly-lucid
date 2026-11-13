// Downloads the OurAirports CSV, extracts Nigerian airports with an IATA code,
// and commits the result to server/data/ng-airports.json so the runtime never
// needs network access for airport reference data.
//
// Run with: pnpm -C server exec tsx scripts/import-airports.ts

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CSV_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const TIMEOUT_MS = 120_000;

export interface AirportRow {
  iata: string;
  icao: string | null;
  name: string;
  lat: number | null;
  lon: number | null;
}

/** Splits CSV text into rows of fields. Handles quoted fields, embedded commas,
 * doubled quotes ("") and CRLF line endings. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      fieldStarted = true;
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldStarted = false;
    } else if (ch === '\r') {
      // handled by the following \n
    } else {
      field += ch;
      fieldStarted = true;
    }
  }

  if (fieldStarted || field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function extractNgAirports(csvText: string): AirportRow[] {
  const rows = parseCsv(csvText);
  if (rows.length === 0) throw new Error('CSV is empty');

  const header = rows[0].map((h) => h.trim());
  const col = (name: string): number => {
    const idx = header.indexOf(name);
    if (idx === -1) throw new Error(`CSV header missing column: ${name}`);
    return idx;
  };

  const iIata = col('iata_code');
  const iIdent = col('ident');
  const iName = col('name');
  const iLat = col('latitude_deg');
  const iLon = col('longitude_deg');
  const iCountry = col('iso_country');
  const iGps = header.includes('gps_code') ? col('gps_code') : -1;

  const byIata = new Map<string, AirportRow>();

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length <= iCountry) continue;
    if (cells[iCountry].trim() !== 'NG') continue;

    const iata = nonEmpty(cells[iIata]);
    if (iata === null) continue;
    if (!/^[A-Z]{3}$/.test(iata)) continue;

    const name = nonEmpty(cells[iName]);
    if (name === null) continue;

    const icao = nonEmpty(cells[iIdent]) ?? (iGps >= 0 ? nonEmpty(cells[iGps]) : null);

    const row: AirportRow = {
      iata,
      icao,
      name,
      lat: toNumber(cells[iLat]),
      lon: toNumber(cells[iLon]),
    };

    // Duplicate IATA codes exist for closed/relocated fields; keep the row
    // that carries coordinates, otherwise the first seen.
    const existing = byIata.get(iata);
    if (
      existing === undefined ||
      (existing.lat === null && row.lat !== null)
    ) {
      byIata.set(iata, row);
    }
  }

  return [...byIata.values()].sort((a, b) => (a.iata < b.iata ? -1 : a.iata > b.iata ? 1 : 0));
}

async function download(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  return await res.text();
}

async function main(): Promise<void> {
  const csv = await download(CSV_URL);
  const airports = extractNgAirports(csv);
  if (airports.length === 0) {
    throw new Error('No Nigerian airports extracted from CSV');
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = resolve(here, '../data/ng-airports.json');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(airports, null, 2)}\n`, 'utf8');

  const withCoords = airports.filter((a) => a.lat !== null && a.lon !== null).length;
  console.log(
    `Wrote ${airports.length} airports (${withCoords} with coordinates) to ${outPath}`,
  );
  for (const code of ['LOS', 'ABV']) {
    const found = airports.find((a) => a.iata === code);
    console.log(`  ${code}: ${found ? JSON.stringify(found) : 'MISSING'}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
