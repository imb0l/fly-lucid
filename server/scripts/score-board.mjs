// Score a frozen board against FR24 airport-departure pages. Run `pnpm -C server build` first.
// Usage: node server/scripts/score-board.mjs <board.md> <day YYYY-MM-DD> [dataDir] [--db | --csv-in <csv>] [--csv <out>]
//   --db        build ground truth from server/data/fly.db (poller DEP rows, earliest ts per flt|orig|dest)
//   --csv-in    build ground truth from a saved CSV instead of the raw pages
//   --csv       also write the matched ground truth as CSV
// Board rows: | sched | flt | ORIG-DEST | carrier | p50 | p10-p90 | method | n |
// FR24 rows: data/fr24-<ddmonyy>-hist-<ORIG>-p<n>.json (and legacy un-suffixed files for LOS).
// Match key: flt|orig|dest, one-to-one nearest, window [sched-6h, sched+12h]. Never key on minute-of-day alone.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const boardPath = process.argv[2];
const day = process.argv[3];
const dataDir = process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : path.join(ROOT, 'data');
if (!boardPath || !day) {
  console.error('usage: node server/scripts/score-board.mjs <board.md> <YYYY-MM-DD> [dataDir] [--db | --csv-in <csv>] [--csv <out>]');
  process.exit(2);
}
const MATCH_BEFORE_SEC = 6 * 3600;
const MATCH_AFTER_SEC = 12 * 3600;
const [Y, M, D] = day.split('-').map(Number);
const DAY_START_UTC = Date.UTC(Y, M - 1, D) / 1000 - 3600; // WAT = UTC+1
const minuteOfDay = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const tsOf = (hm) => DAY_START_UTC + minuteOfDay(hm) * 60; // hm is WAT wall clock
const watOf = (ts) => { const m = Math.round((ts - DAY_START_UTC) / 60); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

const legs = [];
for (const line of fs.readFileSync(boardPath, 'utf8').split('\n')) {
  if (!/^\| \d\d:\d\d \|/.test(line)) continue;
  const [sched, flt, route, carrier, p50, win, method, n] = line.trim().replace(/^\||\|$/g, '').split('|').map((s) => s.trim());
  const [o, d] = route.split('-');
  const [lo, hi] = win.split('-');
  legs.push({ sched, flt, orig: o, dest: d, carrier, p50, win, method, n: Number(n), schedTs: tsOf(sched), p50Ts: tsOf(p50), loTs: tsOf(lo), hiTs: tsOf(hi) });
}

const prefix = `fr24-${day.slice(8, 10)}${['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'][M - 1]}-hist`;
const rowsByOrigin = new Map();
const csvInAt = process.argv.indexOf('--csv-in');
if (csvInAt !== -1 && process.argv[csvInAt + 1]) {
  // Score from a saved ground-truth CSV instead of the raw FR24 pages.
  const [hdr, ...rest] = fs.readFileSync(process.argv[csvInAt + 1], 'utf8').trim().split('\n');
  const cols = hdr.split(',');
  const idx = (name) => cols.indexOf(name);
  for (const line of rest) {
    const c = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((x) => x.replace(/,$/, '').replace(/^"|"$/g, ''));
    const orig = c[idx('orig')];
    if (!rowsByOrigin.has(orig)) rowsByOrigin.set(orig, new Map());
    const sched = Number(c[idx('fr24_sched_ts')]);
    rowsByOrigin.get(orig).set(`${c[idx('flt')]}|${c[idx('dest')]}|${sched}`, {
      flt: c[idx('flt')], dest: c[idx('dest')], sched,
      real: c[idx('real_ts')] === '' ? null : Number(c[idx('real_ts')]),
      status: c[idx('status')] ?? '',
    });
  }
}
const fromDb = process.argv.indexOf('--db') !== -1;
if (fromDb) {
  // Score from the project's own poller database instead of the raw FR24 pages.
  // A usable actual is a DEP row with a flight number and destination; the same
  // flight can be observed several times, so keep the earliest departure.
  const require = createRequire(path.join(ROOT, 'server/package.json'));
  const Database = require('better-sqlite3');
  const db = new Database(path.join(ROOT, 'server/data/fly.db'), { readonly: true });
  try {
    const rows = db.prepare(`
      SELECT flt, airport AS orig, dest, MIN(ts) AS ts
      FROM events
      WHERE kind = 'DEP' AND flt IS NOT NULL AND dest IS NOT NULL
        AND ts >= ? AND ts < ?
      GROUP BY flt, airport, dest
      ORDER BY ts
    `).all(DAY_START_UTC, DAY_START_UTC + 86400);
    for (const r of rows) {
      if (!rowsByOrigin.has(r.orig)) rowsByOrigin.set(r.orig, new Map());
      rowsByOrigin.get(r.orig).set(`${r.flt}|${r.dest}|${r.ts}`, {
        flt: r.flt, orig: r.orig, dest: r.dest,
        board_sched_wat: '',
        fr24_sched_ts: r.ts,
        sched: r.ts,
        real_ts: r.ts,
        real: r.ts,
        real_wat: watOf(r.ts),
        status: 'poller',
      });
    }
  } finally {
    db.close();
  }
}
const re = /^fr24-(\d\d)([a-z]{3})\d*-hist-(?:([A-Z]{3})-)?p-?\d+\.json$/;
for (const f of rowsByOrigin.size ? [] : fs.readdirSync(dataDir)) {
  const m = re.exec(f);
  if (!m || !prefix || `fr24-${m[1]}${m[2]}-hist` !== prefix) continue;
  const orig = m[3] ?? 'LOS';
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')); } catch { continue; }
  const dep = j?.result?.response?.airport?.pluginData?.schedule?.departures;
  if (!dep?.data) continue;
  if (!rowsByOrigin.has(orig)) rowsByOrigin.set(orig, new Map());
  const seen = rowsByOrigin.get(orig);
  for (const r of dep.data) {
    const flt = r.flight.identification.number.default;
    const dest = r.flight.airport?.destination?.code?.iata ?? null;
    const sched = r.flight.time.scheduled.departure;
    const k = `${flt}|${dest}|${sched}`;
    if (seen.has(k)) continue; // page files can overlap
    seen.set(k, { flt, dest, sched, real: r.flight.time.real?.departure ?? null, status: r.flight.status.text });
  }
}
const rowsByOriginArr = new Map([...rowsByOrigin].map(([o, map]) => [o, [...map.values()]]));

const matched = [];
const unmatched = [];
for (const o of rowsByOriginArr.keys()) {
  const own = legs.filter((b) => b.orig === o);
  const cand = [];
  own.forEach((b, bi) => rowsByOriginArr.get(o).forEach((r, ri) => {
    if (r.flt !== b.flt || r.dest !== b.dest) return;
    const dd = r.sched - b.schedTs;
    if (dd >= -MATCH_BEFORE_SEC && dd <= MATCH_AFTER_SEC) cand.push({ bi, ri, abs: Math.abs(dd) });
  }));
  cand.sort((a, b) => a.abs - b.abs);
  const ub = new Set(); const ur = new Set(); const pair = new Map();
  for (const c of cand) { if (ub.has(c.bi) || ur.has(c.ri)) continue; ub.add(c.bi); ur.add(c.ri); pair.set(c.bi, rowsByOriginArr.get(o)[c.ri]); }
  own.forEach((b, bi) => (pair.has(bi) ? matched.push({ b, r: pair.get(bi) }) : unmatched.push(b)));
}
for (const b of legs) if (!rowsByOriginArr.has(b.orig)) unmatched.push(b);

const scored = matched.filter((p) => p.r.real !== null);
const unscored = matched.filter((p) => p.r.real === null);
const statusCount = {};
for (const p of unscored) statusCount[p.r.status] = (statusCount[p.r.status] ?? 0) + 1;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const row = (pairs) => {
  const errs = pairs.map(({ b, r }) => (r.real - b.p50Ts) / 60);
  const sch = pairs.map(({ b, r }) => (r.real - b.schedTs) / 60);
  const cov = pairs.filter(({ b, r }) => r.real >= b.loTs && r.real <= b.hiTs).length;
  const width = pairs.map(({ b }) => (b.hiTs - b.loTs) / 60);
  return { n: pairs.length, mae: mean(errs.map(Math.abs)), med: median(errs.map(Math.abs)), bias: mean(errs), schedMae: mean(sch.map(Math.abs)), cov: (100 * cov) / pairs.length, width: mean(width) };
};
const fmt = (x, d = 1) => x.toFixed(d);

console.log(`# Board score — ${day} (WAT)\n`);
if (fromDb) console.log(`Board: \`${path.relative(ROOT, boardPath)}\`  Poller actuals: \`${path.relative(ROOT, path.join(ROOT, 'server/data/fly.db'))}\`\n`);
else console.log(`Board: \`${path.relative(ROOT, boardPath)}\`  FR24 pages: \`${path.relative(ROOT, dataDir)}/fr24-${day.slice(8, 10)}${['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'][M - 1]}-hist-*.json\`\n`);
console.log('| Join step | Legs |');
console.log('|---|---|');
console.log(`| Board legs | ${legs.length} |`);
console.log(`| Origins with ${fromDb ? 'poller' : 'FR24'} data | ${rowsByOriginArr.size} (${[...rowsByOriginArr.keys()].sort().join(', ')}) |`);
console.log(`| Legs with no ${fromDb ? 'poller' : 'FR24'} origin data | ${legs.filter((b) => !rowsByOriginArr.has(b.orig)).length} |`);
console.log(`| Matched (flt\\|orig\\|dest, one-to-one) | ${matched.length} |`);
console.log(`| Matched, no ${fromDb ? 'poller' : 'FR24'} row | ${unmatched.length} |`);
console.log(`| Matched, real departure (scored) | ${scored.length} |`);
console.log(`| Matched, no real departure (unscored) | ${unscored.length}: ${Object.entries(statusCount).sort((a, b) => b[1] - a[1]).map(([s, c]) => `${c} ${s}`).join(', ')} |`);
console.log('\n## Accuracy (scored legs only)\n');
console.log('| Subset | n | MAE vs p50 (min) | Median abs err | Bias | MAE vs schedule | p10–p90 coverage | Mean width |');
console.log('|---|---|---|---|---|---|---|---|');
const all = row(scored);
console.log(`| All | ${all.n} | ${fmt(all.mae)} | ${fmt(all.med)} | ${fmt(all.bias, 0)} | ${fmt(all.schedMae)} | ${fmt(all.cov, 0)}% | ${fmt(all.width, 0)} |`);
for (const m of [...new Set(scored.map((p) => p.b.method))].sort()) {
  const s = row(scored.filter((p) => p.b.method === m));
  console.log(`| ${m} | ${s.n} | ${fmt(s.mae)} | ${fmt(s.med)} | ${fmt(s.bias, 0)} | ${fmt(s.schedMae)} | ${fmt(s.cov, 0)}% | ${fmt(s.width, 0)} |`);
}
console.log('\n## By origin\n');
console.log('| Origin | n | MAE vs p50 | Median abs err | MAE vs schedule | Coverage |');
console.log('|---|---|---|---|---|---|');
for (const o of [...new Set(scored.map((p) => p.b.orig))].sort()) {
  const s = row(scored.filter((p) => p.b.orig === o));
  console.log(`| ${o} | ${s.n} | ${fmt(s.mae)} | ${fmt(s.med)} | ${fmt(s.schedMae)} | ${fmt(s.cov, 0)}% |`);
}
if (unmatched.length) {
  console.log(`\n## Matched, no ${fromDb ? 'poller' : 'FR24'} row\n`);
  for (const b of unmatched) console.log(`- ${b.sched} ${b.flt} ${b.orig}-${b.dest}`);
}

// Compact ground truth: board leg, FR24 scheduled and real departure. Reproduces the score without the raw pages.
const csvAt = process.argv.indexOf('--csv');
if (csvAt !== -1 && process.argv[csvAt + 1]) {
  const lines = ['flt,orig,dest,board_sched_wat,fr24_sched_ts,real_ts,real_wat,status'];
  for (const { b, r } of [...matched].sort((x, y) => x.b.schedTs - y.b.schedTs)) {
    lines.push([b.flt, b.orig, b.dest, b.sched, r.sched, r.real ?? '', r.real === null ? '' : watOf(r.real), `"${r.status}"`].join(','));
  }
  fs.writeFileSync(process.argv[csvAt + 1], lines.join('\n') + '\n');
  console.log(`\nwrote ${process.argv[csvAt + 1]} (${lines.length - 1} rows)`);
}
