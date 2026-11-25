// Live product (/api/search) snapshotter for a frozen board day.
// Captures the live forecast() output for each scheduled flight on the board at
// T-120m and T-60m before its scheduled departure, saving:
//   - docs/forecast/live-snapshots-<DAY>.csv (raw snapshot log)
//   - docs/forecast/board-<DAY>-live-T120.md (board-formatted for score-board.mjs --csv-in)
//   - docs/forecast/board-<DAY>-live-T60.md  (board-formatted for score-board.mjs --csv-in)
// Usage: node server/scripts/snapshot-live-board.mjs [board.md] [YYYY-MM-DD] [--once]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const boardRel = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'docs/forecast/board-2026-11-23.md';
const day = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '2026-11-23';
const once = process.argv.includes('--once');
const apiBase = process.env.API_BASE ?? 'http://127.0.0.1:8787';
const HORIZONS_MIN = [120, 60];
const WINDOW_SEC = 10 * 60; // capture within [targetTs, targetTs + 10m]

const [Y, M, D] = day.split('-').map(Number);
const DAY_START_UTC = Date.UTC(Y, M - 1, D) / 1000 - 3600; // 00:00 WAT
const toMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const tsOf = (hm) => DAY_START_UTC + toMin(hm) * 60;

const boardPath = path.join(ROOT, boardRel);
const csvPath = path.join(ROOT, `docs/forecast/live-snapshots-${day}.csv`);

const legs = [];
for (const line of fs.readFileSync(boardPath, 'utf8').split('\n')) {
  if (!/^\| \d\d:\d\d \|/.test(line)) continue;
  const [sched, flt, route, carrier, p50, win, method, n] = line.trim().replace(/^\||\|$/g, '').split('|').map((s) => s.trim());
  const [orig, dest] = route.split('-');
  legs.push({ sched, flt, orig, dest, carrier, p50, win, method, n: Number(n), schedTs: tsOf(sched) });
}

const CSV_HEADER = 'horizon_min,captured_at_ts,sched_wat,flt,orig,dest,carrier,status,p50,p10,p90,n,score,tail_reg,tail_status,tail_adjusted,feed_stale,safe_by';
const captured = new Map(); // key: `${h}|${flt}|${orig}|${dest}|${sched}` -> row object

if (fs.existsSync(csvPath)) {
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n').slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const [h, capTs, sched, flt, orig, dest, carrier, status, p50, p10, p90, n, score, tReg, tStat, tAdj, stale, safeBy = ''] = line.split(',');
    captured.set(`${h}|${flt}|${orig}|${dest}|${sched}`, {
      horizonMin: Number(h), capturedAtTs: Number(capTs), sched, flt, orig, dest, carrier,
      status, p50, p10, p90, n: Number(n), score, tReg, tStat, tAdj, stale,
    });
  }
} else {
  fs.writeFileSync(csvPath, CSV_HEADER + '\n');
}

function writeHorizonBoards() {
  for (const h of HORIZONS_MIN) {
    const rows = [];
    const byStatus = {};
    for (const b of legs) {
      const k = `${h}|${b.flt}|${b.orig}|${b.dest}|${b.sched}`;
      const cap = captured.get(k);
      if (!cap || cap.status !== 'candidate') continue;
      const method = cap.tAdj === 'true' ? `live-T${h}-tail` : `live-T${h}`;
      byStatus[method] = (byStatus[method] || 0) + 1;
      rows.push(`| ${b.sched} | ${b.flt} | ${b.orig}-${b.dest} | ${b.carrier} | ${cap.p50} | ${cap.p10}-${cap.p90} | ${method} | ${cap.n} |`);
    }
    if (!rows.length) continue;
    const md = [
      `# Live /api/search snapshot board for ${day} (WAT) at T-${h}m`,
      '',
      `Captured legs with a live candidate forecast (` + '`n >= 5`' + `): ${rows.length} of ${legs.length} board legs. Method counts: ${JSON.stringify(byStatus)}.`,
      `Source: live \`GET /api/search\` responses snapshotted ${h} minutes before each flight's scheduled departure into \`docs/forecast/live-snapshots-${day}.csv\`.`,
      '',
      '| Sched WAT | Flight | Route | Carrier | Pred p50 | Window p10-p90 | Method | Hist n |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      ...rows,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(ROOT, `docs/forecast/board-${day}-live-T${h}.md`), md);
  }
}

async function pollTick() {
  const nowSec = Math.floor(Date.now() / 1000);
  let newCount = 0;
  for (const h of HORIZONS_MIN) {
    for (const b of legs) {
      const k = `${h}|${b.flt}|${b.orig}|${b.dest}|${b.sched}`;
      if (captured.has(k)) continue;
      const targetTs = b.schedTs - h * 60;
      if (nowSec < targetTs || nowSec > targetTs + WINDOW_SEC) continue;
      const url = `${apiBase}/api/search?origin=${b.orig}&dest=${b.dest}&date=${day}&at=${b.sched}`;
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const body = await res.json();
        const cand = (body.candidates ?? []).find((c) => c.flightNo === b.flt);
        const ins = (body.insufficient ?? []).find((c) => c.flightNo === b.flt);
        const row = cand
          ? {
              horizonMin: h, capturedAtTs: nowSec, sched: b.sched, flt: b.flt, orig: b.orig, dest: b.dest, carrier: b.carrier,
              status: 'candidate', p50: cand.p50, p10: cand.p10, p90: cand.p90, n: cand.n, score: cand.score,
              tReg: cand.tail?.reg ?? '', tStat: cand.tail?.status ?? '', tAdj: String(Boolean(cand.tail?.adjusted)), stale: String(Boolean(body.feedStale)), safeBy: cand.safeBy ?? '',
            }
          : {
              horizonMin: h, capturedAtTs: nowSec, sched: b.sched, flt: b.flt, orig: b.orig, dest: b.dest, carrier: b.carrier,
              status: ins ? 'insufficient' : 'absent', p50: '', p10: '', p90: '', n: ins?.n ?? 0, score: '',
              tReg: '', tStat: '', tAdj: '', stale: String(Boolean(body.feedStale)), safeBy: '',
            };
        captured.set(k, row);
        const csvLine = [
          row.horizonMin, row.capturedAtTs, row.sched, row.flt, row.orig, row.dest, row.carrier,
          row.status, row.p50, row.p10, row.p90, row.n, row.score, row.tReg, row.tStat, row.tAdj, row.stale, row.safeBy,
        ].join(',');
        fs.appendFileSync(csvPath, csvLine + '\n');
        newCount++;
      } catch {
        // retry on next tick within WINDOW_SEC
      }
    }
  }
  if (newCount > 0) writeHorizonBoards();
  return { nowSec, totalCaptured: captured.size, newCount };
}

const first = await pollTick();
if (once) {
  console.log(JSON.stringify({ board: boardRel, day, legs: legs.length, ...first }));
  process.exit(0);
}
console.log(`snapshot-live-board: watching ${legs.length} legs for ${day} at T-120m and T-60m`);
setInterval(() => { void pollTick(); }, 60_000);
