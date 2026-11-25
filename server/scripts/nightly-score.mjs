// Nightly combined score: run score-board.mjs --db for every board frozen for a day,
// and write one markdown report preserving each board's tables verbatim.
// Usage: node server/scripts/nightly-score.mjs <YYYY-MM-DD>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const day = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) {
  console.error('usage: node server/scripts/nightly-score.mjs <YYYY-MM-DD>');
  process.exit(2);
}

const forecastDir = path.join(ROOT, 'docs/forecast');
const scorer = path.join(ROOT, 'server/scripts/score-board.mjs');
const exact = `board-${day}.md`;
const boards = fs.readdirSync(forecastDir)
  .filter((f) => f === exact || (f.startsWith(`board-${day}-`) && f.endsWith('.md')))
  .sort((a, b) => (a === exact ? -1 : b === exact ? 1 : a.localeCompare(b)));
if (!boards.length) {
  console.error(`no docs/forecast/board-${day}*.md to score`);
  process.exit(1);
}

const sections = [];
const summary = [];
for (const board of boards) {
  const out = execFileSync(process.execPath, [scorer, path.join(forecastDir, board), day, '--db'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).trimEnd();
  // Drop the per-board H1 (the report supplies its own heading); all tables stay verbatim.
  const body = (out.startsWith('# Board score') ? out.slice(out.indexOf('\n') + 1) : out).replace(/^\n+/, '');
  sections.push(`## ${board}\n\n${body}`);
  const legs = /^\| Board legs \| (\d+) \|$/m.exec(body)?.[1] ?? '?';
  const all = /^\| All \| (\d+) \| ([-\d.]+) \|/m.exec(body);
  summary.push(`${board}: ${legs} legs, ${all?.[1] ?? '?'} scored, MAE ${all?.[2] ?? '?'} min`);
}

const report = [
  `# Nightly score — ${day} (WAT)`,
  '',
  'Ground truth: poller db `server/data/fly.db` (readonly). One section per frozen board; tables preserved verbatim from `score-board.mjs --db`.',
  '',
  ...sections.flatMap((s) => [s, '']),
].join('\n');

const outPath = path.join(forecastDir, `score-${day}-auto.md`);
fs.writeFileSync(outPath, report + '\n');
console.log(`wrote ${path.relative(ROOT, outPath)}`);
for (const line of summary) console.log(line);
