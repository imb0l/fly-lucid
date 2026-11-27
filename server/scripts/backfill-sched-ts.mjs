// Backfill events.sched_ts from FR24 harvest *and* daily schedule snapshots.
// Scans every data/fr24-*.json file recursively for arrays whose rows carry
// flt|orig|dest|schedDep (sched16/sched19/sched23/sched25/sched26/schedDD, `all`,
// `recentActuals`, top-level arrays, ...). Rows with realDep are harvest actuals;
// rows without it are schedule-only legs and are matched by schedule time too.
//
// Matching: join on flt|orig|dest, then nearest DEP event by absolute time inside an
// asymmetric window because actual departures run late, never early:
//   schedDep - 30 min <= event.ts <= schedDep + 12 h
// Pairs are assigned closest-first, one-to-one for both events and schedule legs.
// Existing sched_ts values are never overwritten (UPDATE ... AND sched_ts IS NULL),
// so re-running only fills NULLs and reports zero new writes.
//
// Run `pnpm -C server build` first; it imports server/dist.
// Usage: node server/scripts/backfill-sched-ts.mjs [dbPath]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA_DIR = path.join(ROOT, 'data');
// Only FR24 capture files may contribute schedule legs; board-*/backtest-* are generated output.
const SOURCE_FILE = /^fr24-.*\.json$/i;
const MAX_EARLY_SEC = 30 * 60;        // event.ts >= schedDep - 30 min
const MAX_LATE_SEC = 12 * 60 * 60;    // event.ts <= schedDep + 12 h

const dbPath = process.argv[2] ?? path.join(ROOT, 'server/data/fly.db');
const { openDb } = await import(pathToFileURL(path.join(ROOT, 'server/dist/db/db.js')).href);
const db = openDb(dbPath); // applies the sched_ts migration

// --- scan ---------------------------------------------------------------
function* jsonFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonFiles(full);
    else if (entry.isFile() && SOURCE_FILE.test(entry.name)) yield full;
  }
}

const isScheduleRow = (r) =>
  r && typeof r === 'object' &&
  typeof r.flt === 'string' && r.flt.trim() !== '' &&
  typeof r.orig === 'string' && r.orig.trim() !== '' &&
  typeof r.dest === 'string' && r.dest.trim() !== '' &&
  typeof r.schedDep === 'number' && Number.isFinite(r.schedDep);

const rows = [];
const files = [];
for (const file of jsonFiles(DATA_DIR)) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`skip unreadable ${path.relative(ROOT, file)}: ${err.message}`);
    continue;
  }
  let contributed = 0;
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        if (isScheduleRow(item)) {
          rows.push(item);
          contributed += 1;
        } else if (item && typeof item === 'object') walk(item);
      }
      return;
    }
    if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) walk(node[key]);
    }
  };
  walk(parsed);
  if (contributed > 0) files.push({ file: path.relative(ROOT, file), rows: contributed });
}

// --- legs ---------------------------------------------------------------
// Deduplicate identical schedule rows repeated across snapshots (e.g. `all` vs sched19).
const legs = new Map();
for (const r of rows) {
  const flt = r.flt.trim();
  const orig = r.orig.trim();
  const dest = r.dest.trim();
  const key = `${flt}|${orig}|${dest}|${r.schedDep}`;
  const hasRealDep = typeof r.realDep === 'number' && Number.isFinite(r.realDep);
  const existing = legs.get(key);
  if (existing) {
    existing.hasRealDep ||= hasRealDep;
  } else {
    legs.set(key, { key, flt, orig, dest, schedDep: r.schedDep, hasRealDep });
  }
}

// --- match --------------------------------------------------------------
const depRows = db.prepare(
  "SELECT id, ts FROM events WHERE kind = 'DEP' AND flt = ? AND airport = ? AND dest = ? AND sched_ts IS NULL",
);
const pairs = [];
for (const leg of legs.values()) {
  for (const row of depRows.all(leg.flt, leg.orig, leg.dest)) {
    const delta = row.ts - leg.schedDep; // positive = departure late
    if (delta < -MAX_EARLY_SEC || delta > MAX_LATE_SEC) continue;
    pairs.push({
      id: row.id,
      schedTs: leg.schedDep,
      legKey: leg.key,
      hasRealDep: leg.hasRealDep,
      delta,
      absDelta: Math.abs(delta),
    });
  }
}
pairs.sort((a, b) => a.absDelta - b.absDelta || a.delta - b.delta);

const usedEvent = new Set();
const usedLeg = new Set();
const assigned = [];
for (const p of pairs) {
  if (usedEvent.has(p.id) || usedLeg.has(p.legKey)) continue;
  usedEvent.add(p.id);
  usedLeg.add(p.legKey);
  assigned.push(p);
}

const update = db.prepare('UPDATE events SET sched_ts = ? WHERE id = ? AND sched_ts IS NULL');
db.transaction(() => {
  for (const p of assigned) update.run(p.schedTs, p.id);
})();

// --- report -------------------------------------------------------------
const legList = [...legs.values()];
const withReal = legList.filter((l) => l.hasRealDep);
const schedOnly = legList.filter((l) => !l.hasRealDep);
const matchedSchedOnly = assigned.filter((p) => !p.hasRealDep).length;
const matchedWithReal = assigned.length - matchedSchedOnly;
const totals = db.prepare(
  "SELECT COUNT(*) AS dep, SUM(sched_ts IS NOT NULL) AS withSched FROM events WHERE kind = 'DEP'",
).get();
console.log(JSON.stringify({
  filesWithScheduleRows: files,
  scheduleRowsScanned: rows.length,
  uniqueLegs: legList.length,
  legsWithRealDep: withReal.length,
  legsScheduleOnly: schedOnly.length,
  matchedEvents: assigned.length,
  matchedScheduleOnly: matchedSchedOnly,
  matchedHarvestLegs: matchedWithReal,
  unmatchedScheduleOnly: schedOnly.length - matchedSchedOnly,
  unmatchedHarvestLegs: withReal.length - matchedWithReal,
  windowSec: { before: MAX_EARLY_SEC, after: MAX_LATE_SEC },
  depEventsTotal: totals.dep,
  depEventsWithSched: totals.withSched ?? 0,
}, null, 2));
db.close();
