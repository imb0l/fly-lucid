// Reproducible error audit and causal-horizon tail-floor evaluation for 19 Nov.
// Usage: node server/scripts/error-audit.mjs
// Sources:
//   - Board: docs/forecast/board-2026-11-19.md
//   - Scored actuals: docs/forecast/actuals-2026-11-19.csv
//   - Same-day tail chains & arrival times: data/fr24-19nov-hist-*.json (FR24 airport pages; NOT fly.db, which had a poller outage after 07:38 WAT on 19 Nov)
//   - Prior-day registration assignments & live poller null audit: server/data/fly.db
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(ROOT, 'server/package.json'));
const Database = require('better-sqlite3');
const db = new Database(path.join(ROOT, 'server/data/fly.db'), { readonly: true });

const DAY_START_UTC = Date.UTC(2026, 10, 19) / 1000 - 3600; // 2026-11-19 00:00 WAT
const CUTOFF_19NOV_UTC = Date.UTC(2026, 10, 18, 23, 0, 0) / 1000;
const toMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// 1. Live poller null-key audit (id >= 9590, 19-22 Nov)
const SCHED_CARRIERS = new Set(['APO', 'IAN', 'NUA', 'GWG', 'FVJ', 'CYX', 'ARA', 'RAN', 'NGL', 'OLA', 'UMZ', 'ENU', 'DIR', 'NVD', 'QTR']);
const liveDeps = db.prepare("SELECT id, hex, reg, flt, airline, airport, dest, ts FROM events WHERE id >= 9590 AND kind='DEP' ORDER BY id").all();
const schedDeps = liveDeps.filter((r) => SCHED_CARRIERS.has(r.airline));
const schedNulls = schedDeps.filter((r) => !r.flt || !r.dest);
console.log('=== 1. Live Poller DEP Null-Key Audit (events.id >= 9590) ===');
console.log(JSON.stringify({
  totalLiveDeps: liveDeps.length,
  nonScheduledOrPrivate: liveDeps.length - schedDeps.length,
  scheduledCarrierDeps: schedDeps.length,
  scheduledMissingFltOrDest: schedNulls.length,
  scheduledMissingPct: +((100 * schedNulls.length) / Math.max(1, schedDeps.length)).toFixed(1),
}));

// 2. Load 19 Nov board, actuals CSV, and FR24 raw pages (for reg + arrival timestamps)
const board = new Map();
for (const line of fs.readFileSync(path.join(ROOT, 'docs/forecast/board-2026-11-19.md'), 'utf8').split('\n')) {
  if (!/^\| \d\d:\d\d \|/.test(line)) continue;
  const [sched, flt, route, carrier, p50, win, method, n] = line.trim().replace(/^\||\|$/g, '').split('|').map((s) => s.trim());
  const [orig, dest] = route.split('-');
  const [lo, hi] = win.split('-');
  board.set(`${flt}|${orig}|${dest}|${sched}`, {
    sched, flt, orig, dest, carrier, p50, win, method, n: Number(n),
    schedM: toMin(sched), p50M: toMin(p50), loM: toMin(lo), hiM: toMin(hi),
  });
}

const fr24Legs = new Map();
const dataDir = path.join(ROOT, 'data');
const re = /^fr24-19nov-hist-(?:([A-Z]{3})-)?p-?\d+\.json$/;
for (const f of fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : []) {
  const m = re.exec(f);
  if (!m) continue;
  const orig = m[1] ?? 'LOS';
  const j = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
  const dep = j?.result?.response?.airport?.pluginData?.schedule?.departures?.data ?? [];
  for (const item of dep) {
    const fl = item.flight;
    const flt = fl.identification.number.default;
    const dest = fl.airport?.destination?.code?.iata ?? null;
    const sched = fl.time.scheduled.departure;
    const real = fl.time.real?.departure ?? null;
    const schedArr = fl.time.scheduled?.arrival ?? null;
    const realArr = fl.time.real?.arrival ?? null;
    const reg = fl.aircraft?.registration ?? null;
    fr24Legs.set(`${orig}|${dest}|${flt}|${sched}`, { orig, dest, flt, sched, real, schedArr, realArr, reg });
  }
}

const byReg19 = new Map();
for (const x of fr24Legs.values()) {
  if (!x.real || !x.reg) continue;
  if (!byReg19.has(x.reg)) byReg19.set(x.reg, []);
  byReg19.get(x.reg).push(x);
}
for (const seq of byReg19.values()) seq.sort((a, b) => a.sched - b.sched);

const csvLines = fs.readFileSync(path.join(ROOT, 'docs/forecast/actuals-2026-11-19.csv'), 'utf8').trim().split('\n').slice(1);
const scored = [];
for (const line of csvLines) {
  const [flt, orig, dest, boardSched, fr24Sched, realTs] = line.split(',');
  if (!realTs) continue;
  const b = board.get(`${flt}|${orig}|${dest}|${boardSched}`);
  if (!b) continue;
  const rTs = Number(realTs);
  const sTs = Number(fr24Sched);
  const fr = fr24Legs.get(`${orig}|${dest}|${flt}|${sTs}`) ?? null;
  const actM = (rTs - DAY_START_UTC) / 60;
  scored.push({ ...b, realTs: rTs, schedTs: sTs, fr, actM, absErr: Math.abs(actM - b.p50M) });
}

// 3. Attribution of >= 60m errors on 19 Nov
const big39 = scored.filter((r) => r.absErr >= 60);
let firstLeg = 0, hasPrior = 0, priorLate60 = 0;
for (const r of big39) {
  const reg = r.fr?.reg;
  const seq = reg ? (byReg19.get(reg) ?? []) : [];
  const idx = seq.findIndex((x) => x.flt === r.flt && x.orig === r.orig && x.sched === r.schedTs);
  if (idx <= 0) firstLeg++;
  else {
    hasPrior++;
    const prev = seq[idx - 1];
    if ((prev.real - prev.sched) / 60 >= 60) priorLate60++;
  }
}
console.log('\n=== 2. Attribution of >=60 min Errors on 19 Nov ===');
console.log(JSON.stringify({ totalScored: scored.length, absErrGte60: big39.length, firstLegOfTail: firstLeg, hasPriorLegOnSameTail: hasPrior, priorLegDelayedGte60m: priorLate60 }));

// 4. Strictly causal horizon evaluation vs post-departure oracle
const latestPriorRegStmt = db.prepare(
  "SELECT reg FROM events WHERE kind='DEP' AND flt=? AND airport=? AND dest=? AND ts < ? AND reg IS NOT NULL ORDER BY ts DESC LIMIT 1",
);

function evalHorizon(leadMode, regMode) {
  const errs = [];
  for (const r of scored) {
    let p50 = r.p50M;
    let tQuery;
    if (leadMode === 'oracle') tQuery = r.realTs - 1;
    else if (leadMode === 'p50-60') tQuery = DAY_START_UTC + (r.p50M - 60) * 60;
    else if (leadMode === 'p50') tQuery = DAY_START_UTC + r.p50M * 60;
    else tQuery = r.schedTs - leadMode * 60;

    const reg = regMode === 'prior-db-reg'
      ? (latestPriorRegStmt.get(r.flt, r.orig, r.dest, CUTOFF_19NOV_UTC)?.reg ?? null)
      : (r.fr?.reg ?? null);

    if (reg && byReg19.has(reg)) {
      const inbounds = byReg19.get(reg).filter((x) => x.sched < r.schedTs && x.dest === r.orig);
      if (inbounds.length) {
        const prev = inbounds[inbounds.length - 1];
        const schedBlock = prev.schedArr && prev.sched ? (prev.schedArr - prev.sched) / 60 : 55;
        const tQMin = (tQuery - DAY_START_UTC) / 60;
        let readyMin;
        if (leadMode === 'oracle') {
          const arrMin = prev.realArr ? (prev.realArr - DAY_START_UTC) / 60 : (prev.real - DAY_START_UTC) / 60 + schedBlock;
          readyMin = arrMin + 35;
        } else if (prev.realArr && prev.realArr <= tQuery) {
          readyMin = (prev.realArr - DAY_START_UTC) / 60 + 35;
        } else if (prev.real && prev.real <= tQuery) {
          readyMin = Math.max(tQMin, (prev.real - DAY_START_UTC) / 60 + schedBlock) + 35;
        } else {
          readyMin = tQMin + schedBlock + 35;
        }
        p50 = Math.max(p50, readyMin);
      }
    }
    errs.push(Math.abs(r.actM - p50));
  }
  return { horizon: String(leadMode), regMode, n: errs.length, MAE: +mean(errs).toFixed(1), MedAE: +median(errs).toFixed(1) };
}

console.log('\n=== 3. Causal Query-Horizon vs Post-Departure Oracle (19 Nov, n=223) ===');
console.table([
  { horizon: 'baseline (day-ahead board)', regMode: 'none', n: scored.length, MAE: +mean(scored.map((r) => r.absErr)).toFixed(1), MedAE: +median(scored.map((r) => r.absErr)).toFixed(1) },
  evalHorizon(120, 'prior-db-reg'),
  evalHorizon(60, 'prior-db-reg'),
  evalHorizon(0, 'prior-db-reg'),
  evalHorizon('p50-60', 'prior-db-reg'),
  evalHorizon(0, 'same-day-fr24-reg'),
  evalHorizon('p50-60', 'same-day-fr24-reg'),
  evalHorizon('oracle', 'prior-db-reg'),
  evalHorizon('oracle', 'same-day-fr24-reg'),
]);
