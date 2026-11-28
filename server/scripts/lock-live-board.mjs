// Lock the current live /api/search output for every leg on a frozen board.
// Writes a raw CSV and a board-formatted markdown file for nightly scoring.
// Usage: node server/scripts/lock-live-board.mjs <board.md> <YYYY-MM-DD> <label> [apiBase]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [boardRel, day, label, apiBase = 'http://127.0.0.1:8787'] = process.argv.slice(2);
if (!boardRel || !/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') || !/^[a-z0-9-]+$/.test(label ?? '')) {
  console.error('usage: node server/scripts/lock-live-board.mjs <board.md> <YYYY-MM-DD> <label> [apiBase]');
  process.exit(2);
}
const [Y, M, D] = day.split('-').map(Number);
const dayStart = Date.UTC(Y, M - 1, D) / 1000 - 3600;
const toMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const legs = [];
for (const line of fs.readFileSync(path.join(ROOT, boardRel), 'utf8').split('\n')) {
  if (!/^\| \d\d:\d\d \|/.test(line)) continue;
  const [sched, flt, route, carrier, p50, win, method, n] = line.trim().replace(/^\||\|$/g, '').split('|').map((s) => s.trim());
  const [orig, dest] = route.split('-');
  legs.push({ sched, flt, orig, dest, carrier, schedTs: dayStart + toMin(sched) * 60 });
}

const rows = [];
let cursor = 0;
async function worker() {
  while (cursor < legs.length) {
    const leg = legs[cursor++];
    const capturedAt = Math.floor(Date.now() / 1000);
    const query = new URLSearchParams({ origin: leg.orig, dest: leg.dest, date: day, at: leg.sched });
    try {
      const res = await fetch(`${apiBase}/api/search?${query.toString()}`);
      if (!res.ok) continue;
      const body = await res.json();
      const cand = (body.candidates ?? []).find((c) => c.flightNo === leg.flt);
      const ins = (body.insufficient ?? []).find((c) => c.flightNo === leg.flt);
      rows.push({
        capturedAt, sched: leg.sched, flt: leg.flt, orig: leg.orig, dest: leg.dest, carrier: leg.carrier,
        status: cand ? 'candidate' : ins ? 'insufficient' : 'absent',
        p50: cand?.p50 ?? '', p10: cand?.p10 ?? '', p90: cand?.p90 ?? '', safeBy: cand?.safeBy ?? '',
        n: cand?.n ?? ins?.n ?? 0, score: cand?.score ?? '', tailReg: cand?.tail?.reg ?? '',
        tailStatus: cand?.tail?.status ?? '', tailAdjusted: cand ? String(Boolean(cand.tail?.adjusted)) : '',
        feedStale: String(Boolean(body.feedStale)), modelVersion: body.modelVersion ?? 'unknown',
      });
    } catch {
      // leave the leg unlocked rather than inventing a forecast
    }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
rows.sort((a, b) => a.sched.localeCompare(b.sched) || a.flt.localeCompare(b.flt));

const csvPath = path.join(ROOT, `docs/forecast/live-lock-${day}-${label}.csv`);
const header = 'captured_at_ts,sched_wat,flt,orig,dest,carrier,status,p50,p10,p90,safe_by,n,score,tail_reg,tail_status,tail_adjusted,feed_stale,model_version';
fs.writeFileSync(csvPath, [header, ...rows.map((r) => [
  r.capturedAt, r.sched, r.flt, r.orig, r.dest, r.carrier, r.status, r.p50, r.p10, r.p90, r.safeBy,
  r.n, r.score, r.tailReg, r.tailStatus, r.tailAdjusted, r.feedStale, r.modelVersion,
].join(','))].join('\n') + '\n');

const candidates = rows.filter((r) => r.status === 'candidate');
const boardPath = path.join(ROOT, `docs/forecast/board-${day}-live-lock-${label}.md`);
const md = [
  `# Live /api/search lock for ${day} (WAT) — ${label}`,
  '',
  `Locked ${new Date().toISOString()} from ${apiBase}. ${candidates.length} candidate forecasts from ${legs.length} scheduled legs.`,
  'This is a point-in-time live-product snapshot, not a pre-day holdout for legs that already departed.',
  '',
  '| Sched WAT | Flight | Route | Carrier | Pred p50 | Window p10-p90 | Method | Hist n |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...candidates.map((r) => `| ${r.sched} | ${r.flt} | ${r.orig}-${r.dest} | ${r.carrier} | ${r.p50} | ${r.p10}-${r.p90} | live-lock${r.tailAdjusted === 'true' ? '-tail' : ''} | ${r.n} |`),
  '',
].join('\n');
fs.writeFileSync(boardPath, md);
console.log(JSON.stringify({ legs: legs.length, captured: rows.length, candidates: candidates.length, csv: path.relative(ROOT, csvPath), board: path.relative(ROOT, boardPath) }));
