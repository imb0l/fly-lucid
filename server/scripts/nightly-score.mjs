// Nightly combined score: run score-board.mjs --db for every board frozen for a day,
// and write one markdown report preserving each board's tables verbatim.
// Usage: node server/scripts/nightly-score.mjs <YYYY-MM-DD>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const day = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) {
  console.error('usage: node server/scripts/nightly-score.mjs <YYYY-MM-DD> [prospectiveAfter HH:MM]');
  process.exit(2);
}
const prospectiveAfter = process.argv[3] ?? null;
if (prospectiveAfter !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(prospectiveAfter)) {
  console.error('prospectiveAfter must be HH:MM in WAT');
  process.exit(2);
}

const forecastDir = path.join(ROOT, 'docs/forecast');
const scorer = path.join(ROOT, 'server/scripts/score-board.mjs');
const resolver = path.join(ROOT, 'server/scripts/resolve-forecast-outcomes.mjs');
const exact = `board-${day}.md`;
const boards = fs.readdirSync(forecastDir)
  .filter((f) => f === exact || (f.startsWith(`board-${day}-`) && f.endsWith('.md')))
  .sort((a, b) => (a === exact ? -1 : b === exact ? 1 : a.localeCompare(b)));
if (!boards.length) {
  console.error(`no docs/forecast/board-${day}*.md to score`);
  process.exit(1);
}

const sections = [];

execFileSync(process.execPath, [resolver, day], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
});

const db = new Database(path.join(ROOT, 'server/data/fly.db'), { readonly: true });
const safetyRows = db.prepare(`
  SELECT l.model_version, COUNT(*) AS n, COALESCE(SUM(o.early), 0) AS early
  FROM forecast_outcome o
  JOIN forecast_log l ON l.id = o.forecast_id
  WHERE l.target_date = ? AND o.outcome = 'matched' AND l.safe_by IS NOT NULL
  GROUP BY l.model_version
  ORDER BY l.model_version
`).all(day);
db.close();

const wilson = (early, n) => {
  if (n === 0) return 'n/a';
  const z = 1.959963984540054;
  const p = early / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / denom;
  return `${(100 * Math.max(0, center - half)).toFixed(1)}–${(100 * Math.min(1, center + half)).toFixed(1)}%`;
};

const totalN = safetyRows.reduce((sum, row) => sum + row.n, 0);
const totalEarly = safetyRows.reduce((sum, row) => sum + row.early, 0);
const safetySection = [
  '## safe_by calibration (live `/api/search` audit log)',
  '',
  `Matched forecasts with a recorded safe_by: **${totalN}**. Early departures: **${totalEarly}** (${totalN ? (100 * totalEarly / totalN).toFixed(1) : '0.0'}%; Wilson 95% CI ${wilson(totalEarly, totalN)}).`,
  '',
  '| Model version | Matched | Early | Early rate | Wilson 95% CI |',
  '|---|---|---|---|---|',
  ...safetyRows.map((row) => `| ${row.model_version} | ${row.n} | ${row.early} | ${(100 * row.early / row.n).toFixed(1)}% | ${wilson(row.early, row.n)} |`),
  '',
].join('\n');
const summary = [];
for (const board of boards) {
  const locked = board.includes('-locked-') || board.includes('-live-lock-');
  const variants = [{ suffix: '', args: [] }];
  if (locked && prospectiveAfter !== null) {
    variants.push({ suffix: ` — prospective >= ${prospectiveAfter} WAT`, args: ['--after', prospectiveAfter] });
  }
  for (const variant of variants) {
    const out = execFileSync(process.execPath, [scorer, path.join(forecastDir, board), day, '--db', ...variant.args], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    }).trimEnd();
    const body = (out.startsWith('# Board score') ? out.slice(out.indexOf('\n') + 1) : out).replace(/^\n+/, '');
    sections.push(`## ${board}${variant.suffix}\n\n${body}`);
    const legs = /^\| Board legs \| (\d+) \|$/m.exec(body)?.[1] ?? '?';
    const all = /^\| All \| (\d+) \| ([-\d.]+) \|/m.exec(body);
    summary.push(`${board}${variant.suffix}: ${legs} legs, ${all?.[1] ?? '?'} scored, MAE ${all?.[2] ?? '?'} min`);
  }
}

const report = [
  `# Nightly score — ${day} (WAT)`,
  '',
  'Forecast outcomes are resolved first; the safe_by section reports early departures with Wilson 95% intervals. Locked boards are also scored separately for departures at or after the supplied prospective cutoff; earlier legs remain retrospective. Unmatched forecasts remain unscored, never invented cancellations.',
  '',
  safetySection,
  ...sections.flatMap((s) => [s, '']),
].join('\n');

const outPath = path.join(forecastDir, `score-${day}-auto.md`);
fs.writeFileSync(outPath, report + '\n');
console.log(`wrote ${path.relative(ROOT, outPath)}`);
for (const line of summary) console.log(line);
