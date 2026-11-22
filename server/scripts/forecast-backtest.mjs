// Forecast backtest and board generator. Run `pnpm -C server build` first; it imports server/dist.
// Usage: node server/scripts/forecast-backtest.mjs [backtest|board] [spanMult] [fixed|old]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(ROOT, 'server/package.json'));
const Database = require('better-sqlite3');
const F = await import(pathToFileURL(path.join(ROOT, 'server/dist/model/forecast.js')).href);
const MODE = process.argv[2] ?? 'backtest';
const SPAN_MULT = Number(process.argv[3] ?? 1.25);
const MATCH = process.argv[4] ?? 'fixed'; // 'fixed' = windowed nearest, one-to-one; 'old' = same WAT day earliest
const MATCH_BEFORE_SEC = 6 * 3600;
const MATCH_AFTER_SEC = 12 * 3600;
const K = 5;
const MIN_POOL = 100;
const CARRIER_MIN = Number(process.env.CARRIER_MIN ?? 3); // min carrier samples before carrier median replaces pool median
const db = new Database(path.join(ROOT, 'server/data/fly.db'), { readonly: true });

const harvest = [];
for (const f of fs.readdirSync(path.join(ROOT, 'data'))) {
  if (!f.endsWith('.json')) continue;
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));
  if (Array.isArray(j)) harvest.push(...j);
  if (Array.isArray(j?.sched16)) harvest.push(...j.sched16);
}
const keyOf = (flt, o, d, ts) => `${flt}|${o}|${d}|${F.watDateStr(ts)}`;
const sched = new Map();
const actualByLeg = new Map();
const addActual = (flt, o, d, ts) => {
  const k = `${flt}|${o}|${d}`;
  if (!actualByLeg.has(k)) actualByLeg.set(k, new Set());
  actualByLeg.get(k).add(ts);
};
for (const r of harvest) {
  if (r.schedDep) { const k = keyOf(r.flt, r.orig, r.dest, r.schedDep); if (!sched.has(k)) sched.set(k, { schedTs: r.schedDep, air: r.airlineIcao, flt: r.flt, o: r.orig, d: r.dest }); }
  if (r.realDep) addActual(r.flt, r.orig, r.dest, r.realDep);
}
for (const r of db.prepare("SELECT flt, airport AS o, dest AS d, ts FROM events WHERE kind='DEP' AND flt IS NOT NULL").all()) addActual(r.flt, r.o, r.d, r.ts);

const train = [];
for (const r of harvest) if (r.schedDep && r.realDep) {
  const delay = (r.realDep - r.schedDep) / 60;
  if (Math.abs(delay) < 300) train.push({ flt: r.flt, o: r.orig, d: r.dest, air: r.airlineIcao, day: F.watDateStr(r.realDep), delay, schedClock: F.minuteOfDayWat(r.schedDep) });
}
const poolCache = new Map();
const poolFor = (day) => { if (!poolCache.has(day)) poolCache.set(day, train.filter(x => x.day < day)); return poolCache.get(day); };

const sortedQ = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };
const median = (a) => sortedQ(a, 0.5);
const dayStartUtc = (day) => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d) / 1000 - 3600; };
// history p50 is minute-of-day (0..1439); move it onto the same unwrapped frame as the schedule-anchored value
const shiftNear = (x, target) => { let y = x; while (y - target > 720) y -= 1440; while (target - y > 720) y += 1440; return y; };

const claimed = new Set();
function matchLeg(s, day) {
  const list = actualByLeg.get(`${s.flt}|${s.o}|${s.d}`);
  if (!list) return null;
  if (MATCH === 'old') {
    let best = null;
    for (const ts of list) if (F.watDateStr(ts) === day && (best === null || ts < best)) best = ts;
    return best;
  }
  let best = null, bestAbs = Infinity;
  for (const ts of list) {
    const delta = ts - s.schedTs;
    if (delta < -MATCH_BEFORE_SEC || delta > MATCH_AFTER_SEC) continue;
    if (claimed.has(`${s.flt}|${s.o}|${s.d}|${ts}`)) continue;
    if (Math.abs(delta) < bestAbs) { best = ts; bestAbs = Math.abs(delta); }
  }
  if (best !== null) claimed.add(`${s.flt}|${s.o}|${s.d}|${best}`);
  return best;
}

function predictLeg(t, pool, dayStart) {
  const gAll = pool.map(x => x.delay);
  const gMed = median(gAll), gQ10 = sortedQ(gAll, 0.1), gQ90 = sortedQ(gAll, 0.9);
  const cd = pool.filter(x => x.air === t.air).map(x => x.delay);
  const carrierMed = cd.length >= CARRIER_MIN ? median(cd) : gMed;
  const spread = cd.length >= 10
    ? { lo: carrierMed - sortedQ(cd, 0.1), hi: sortedQ(cd, 0.9) - carrierMed }
    : { lo: gMed - gQ10, hi: gQ90 - gMed };
  const fd = pool.filter(x => x.flt === t.flt && x.o === t.o && x.d === t.d).map(x => x.delay);
  const nF = fd.length;
  const shrunk = nF ? (nF * median(fd) + K * carrierMed) / (nF + K) : carrierMed;
  const schedMin = (t.schedTs - dayStart) / 60;
  const delayPred = schedMin + shrunk;
  const hist = db.prepare("SELECT ts FROM events WHERE kind='DEP' AND flt=? AND airport=? AND dest=? AND ts < ? ORDER BY ts ASC").all(t.flt, t.o, t.d, dayStart).map(r => r.ts);
  const wd = hist.filter(x => { const dd = new Date((x + 3600) * 1000).getUTCDay(); return dd >= 1 && dd <= 5; });
  const used = wd.length >= 5 ? wd : hist;
  if (used.length >= F.MIN_SAMPLES) {
    const slotAtMin = ((Math.round(delayPred) % 1440) + 1440) % 1440;
    const m = F.estimateTightForecast(used, null, slotAtMin);
    const histP50 = shiftNear(m.p50, delayPred);
    const center = 0.5 * histP50 + 0.5 * delayPred;
    const disagree = Math.abs(histP50 - delayPred);
    const halfLo = (m.p50 - m.p10) + 0.25 * disagree;
    const halfHi = (m.p90 - m.p50) + 0.40 * disagree;
    return { p50: center, p10: center - halfLo, p90: center + halfHi, method: 'blend', histN: used.length, schedMin, histP50, delayPred };
  }
  return { p50: delayPred, p10: delayPred - spread.lo * SPAN_MULT, p90: delayPred + spread.hi * SPAN_MULT, method: 'delay-prior', histN: used.length, schedMin, delayPred };
}
const hhmm = (m) => { const x = ((Math.round(m) % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };

if (MODE === 'backtest') {
  const rows = [];
  const stats = { match: MATCH, span: SPAN_MULT, legs: 0, skippedPool: 0, unmatched: 0, matched: 0, nextDayMatch: 0, matchGte3h: 0 };
  const legs = [...sched.values()].sort((a, b) => a.schedTs - b.schedTs);
  for (const s of legs) {
    const day = F.watDateStr(s.schedTs);
    if (day >= '2026-11-18') continue;
    stats.legs++;
    const pool = poolFor(day);
    if (pool.length < MIN_POOL) { stats.skippedPool++; continue; }
    const ts = matchLeg(s, day);
    if (ts === null) { stats.unmatched++; continue; }
    stats.matched++;
    const nextDayMatch = F.watDateStr(ts) !== day;
    if (nextDayMatch) stats.nextDayMatch++;
    if (Math.abs(ts - s.schedTs) >= 3 * 3600) stats.matchGte3h++;
    const dayStart = dayStartUtc(day);
    const p = predictLeg(s, pool, dayStart);
    rows.push({ ...p, flt: s.flt, orig: s.o, dest: s.d, schedTs: s.schedTs, actualTs: ts, actMin: (ts - dayStart) / 60, day, air: s.air, nextDayMatch, schedOnly: p.schedMin });
  }
  const st = (rs, name, p = r => r.p50) => {
    if (!rs.length) return { set: name, n: 0 };
    const e = rs.map(r => Math.abs(p(r) - r.actMin));
    const cov = rs.filter(r => r.actMin >= r.p10 && r.actMin <= r.p90).length / rs.length;
    return { set: name, n: rs.length, MAE: +(e.reduce((a, b) => a + b, 0) / e.length).toFixed(1), within15: Math.round(100 * e.filter(x => x <= 15).length / e.length) + '%', within30: Math.round(100 * e.filter(x => x <= 30).length / e.length) + '%', coverage: Math.round(100 * cov) + '%', meanWidth: +(rs.reduce((s, r) => s + r.p90 - r.p10, 0) / rs.length).toFixed(1) };
  };
  const blend = rows.filter(r => r.method === 'blend');
  const none = rows.filter(r => r.method === 'delay-prior');
  console.log(JSON.stringify(stats));
  console.table([
    st(blend, 'history legs: blend p50', r => r.p50),
    st(blend, 'history legs: history-only p50', r => r.histP50),
    st(blend, 'history legs: schedule-only', r => r.schedOnly),
    st(none, 'no-history legs: delay-prior p50', r => r.p50),
    st(none, 'no-history legs: schedule-only', r => r.schedOnly),
    st(rows, 'all matched: p50 (blend or delay-prior)', r => r.p50),
    st(rows.filter(r => !r.nextDayMatch), 'all matched, same-WAT-day actual only', r => r.p50),
  ]);
  fs.writeFileSync(path.join(ROOT, 'data', `backtest-rows-${MATCH}.json`), JSON.stringify(rows));
}

if (MODE === 'board') {
  const DAY = process.argv[4] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[4]) ? process.argv[4] : '2026-11-19';
  const [, mm, dd] = DAY.split('-');
  const tag = `${dd}${['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'][Number(mm) - 1]}`;
  const rawSched = JSON.parse(fs.readFileSync(path.join(ROOT, `data/fr24-${tag}-schedule.json`), 'utf8'));
  const schedRows = rawSched[`sched${dd}`] ?? rawSched.sched19 ?? (Array.isArray(rawSched) ? rawSched : []);
  const seen = new Map();
  const domestic = new Set(db.prepare('select iata from airports').all().map(r => r.iata));
  for (const r of schedRows) {
    if (!r.flt || !r.schedDep || !domestic.has(r.orig) || !domestic.has(r.dest)) continue;
    const k = keyOf(r.flt, r.orig, r.dest, r.schedDep);
    if (!seen.has(k)) seen.set(k, { schedTs: r.schedDep, air: r.airlineIcao, airName: r.airlineName, flt: r.flt, o: r.orig, d: r.dest });
  }
  const dayStart = dayStartUtc(DAY);
  const boardPool = train.filter(x => x.day < DAY);
  const out = [];
  for (const t of seen.values()) {
    const p = predictLeg(t, boardPool, dayStart);
    out.push({ flt: t.flt, orig: t.o, dest: t.d, air: t.air, airName: t.airName, schedWat: hhmm(p.schedMin), p50: hhmm(p.p50), p10: hhmm(p.p10), p90: hhmm(p.p90), p50Min: +p.p50.toFixed(1), p10Min: +p.p10.toFixed(1), p90Min: +p.p90.toFixed(1), method: p.method, histN: p.histN });
  }
  out.sort((a, b) => a.schedWat.localeCompare(b.schedWat) || a.flt.localeCompare(b.flt));
  const byMethod = out.reduce((m, r) => (m[r.method] = (m[r.method] || 0) + 1, m), {});
  const md = [
    `# Departure forecast for ${DAY} (WAT), frozen before the day`,
    '',
    `Legs: ${out.length} unique scheduled departures. Method counts: ${JSON.stringify(byMethod)}.`,
    'Method: "blend" = 0.5 x history-model p50 + 0.5 x (schedule + shrunk flight/carrier delay); "delay-prior" = schedule + shrunk delay where history has fewer than 5 samples.',
    'Window: blend uses history p10/p90 offsets around the blended p50; delay-prior uses carrier delay p10/p90 spread x span multiplier.',
    'Schedule time is an input to this experiment only, not a product output.',
    '',
    '| Sched WAT | Flight | Route | Carrier | Pred p50 | Window p10-p90 | Method | Hist n |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...out.map(r => `| ${r.schedWat} | ${r.flt} | ${r.orig}-${r.dest} | ${r.air ?? '?'} | ${r.p50} | ${r.p10}-${r.p90} | ${r.method} | ${r.histN} |`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(ROOT, `data/board-${tag}.md`), md);
  fs.writeFileSync(path.join(ROOT, `data/board-${tag}.json`), JSON.stringify(out, null, 2));
  if (process.argv[5]) fs.writeFileSync(path.join(ROOT, process.argv[5]), md);
  console.log(JSON.stringify({ day: DAY, legs: out.length, byMethod }));
}
