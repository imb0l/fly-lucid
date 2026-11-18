// Backfill events.sched_ts from harvest records that carry both schedDep and realDep.
// Joins on flt|orig|dest, then nearest DEP ts within MAX_DELTA_SEC, one-to-one (closest pairs first).
// Run `pnpm -C server build` first; it imports server/dist. Idempotent: re-running only fills NULLs.
// Usage: node server/scripts/backfill-sched-ts.mjs [dbPath]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_DELTA_SEC = 30 * 60;
const dbPath = process.argv[2] ?? path.join(ROOT, 'server/data/fly.db');
const { openDb } = await import(pathToFileURL(path.join(ROOT, 'server/dist/db/db.js')).href);
const db = openDb(dbPath); // applies the sched_ts migration

const harvest = [];
for (const f of fs.readdirSync(path.join(ROOT, 'data'))) {
  if (!f.endsWith('.json')) continue;
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));
  const lists = Array.isArray(j) ? [j] : [j?.sched16, j?.recentActuals, j?.sched19, j?.all];
  for (const list of lists) if (Array.isArray(list)) harvest.push(...list);
}
const legs = harvest.filter((r) => r.flt && r.orig && r.dest && r.schedDep && r.realDep);

const depRows = db.prepare(
  "SELECT id, ts FROM events WHERE kind = 'DEP' AND flt = ? AND airport = ? AND dest = ?",
);
const pairs = [];
for (const leg of legs) {
  for (const row of depRows.all(leg.flt, leg.orig, leg.dest)) {
    const delta = Math.abs(row.ts - leg.realDep);
    if (delta <= MAX_DELTA_SEC) pairs.push({ id: row.id, schedTs: leg.schedDep, delta, flt: leg.flt, orig: leg.orig, dest: leg.dest, realDep: leg.realDep });
  }
}
pairs.sort((a, b) => a.delta - b.delta);

const usedEvent = new Set();
const usedLeg = new Set();
const assigned = [];
for (const p of pairs) {
  const legKey = `${p.flt}|${p.orig}|${p.dest}|${p.realDep}`;
  if (usedEvent.has(p.id) || usedLeg.has(legKey)) continue;
  usedEvent.add(p.id);
  usedLeg.add(legKey);
  assigned.push(p);
}

const update = db.prepare('UPDATE events SET sched_ts = ? WHERE id = ? AND sched_ts IS NULL');
db.transaction(() => {
  for (const p of assigned) update.run(p.schedTs, p.id);
})();

const legKeys = new Set(legs.map((l) => `${l.flt}|${l.orig}|${l.dest}|${l.realDep}`));
const totals = db.prepare(
  "SELECT COUNT(*) AS dep, SUM(sched_ts IS NOT NULL) AS withSched FROM events WHERE kind = 'DEP'",
).get();
console.log(JSON.stringify({
  harvestLegsWithSchedAndReal: legs.length,
  uniqueHarvestLegs: legKeys.size,
  matchedEvents: assigned.length,
  unmatchedHarvestLegs: legKeys.size - usedLeg.size,
  depEventsTotal: totals.dep,
  depEventsWithSched: totals.withSched,
}, null, 2));
db.close();
