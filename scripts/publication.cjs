// Publication checks only. Do not import or run the scoring/RSS implementation.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual, parseArgs } = require('node:util');

const DAY = 24 * 60 * 60 * 1000;
const GRACE = 60 * 60 * 1000;
const dateKey = (date) => date.toISOString().slice(0, 10).replaceAll('-', '');

function dueAt(date) {
  if (!/^\d{8}$/.test(date)) throw new Error('Expected a YYYYMMDD publication date');
  const due = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T03:15:00Z`);
  if (!Number.isFinite(due.getTime()) || dateKey(due) !== date) throw new Error('Invalid publication date');
  return due;
}

function expectedDate(now) {
  // Yesterday remains acceptable until today's 04:15 UTC deadline.
  const today = dateKey(now);
  return now.getTime() < dueAt(today).getTime() + GRACE
    ? dateKey(new Date(now.getTime() - DAY)) : today;
}

function readJson(root, file, ref) {
  const text = ref
    ? execFileSync('git', ['show', `${ref}:${file}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    : fs.readFileSync(path.join(root, file), 'utf8');
  return JSON.parse(text);
}

function verify(root, date, ref) {
  dueAt(date);
  const ranking = readJson(root, 'ranking.json', ref);
  if (ranking.date !== date) throw new Error(`Publication missing: expected ${date}, found ${ranking.date}`);
  if (!Array.isArray(ranking.rows) || ranking.rows.length === 0) throw new Error('Ranking has no rows');
  if (!ranking.rows.every(row => row && typeof row.name === 'string' && row.name.trim()
      && Number.isFinite(row.score) && Number.isInteger(row.rank) && row.rank > 0)) {
    throw new Error('Ranking contains invalid rows');
  }
  for (const file of ['prev_ranking.json', `history/${date}.json`]) {
    if (!isDeepStrictEqual(ranking, readJson(root, file, ref))) {
      throw new Error(`${file} does not match ranking.json`);
    }
  }
  return ranking;
}

function optionalJson(root, file) {
  try { return readJson(root, file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function plan(root, now) {
  const date = dateKey(now);
  const ranking = optionalJson(root, 'ranking.json');
  if (ranking) {
    dueAt(ranking.date);
    if (ranking.date > date) throw new Error('Ranking is dated in the future');
    if (ranking.date === date) {
      verify(root, date);
      return { date, build: false };
    }
  }
  // A partial publication must not cause the daily score cap to be applied twice.
  const previous = optionalJson(root, 'prev_ranking.json');
  if ((previous && previous.date >= date) || fs.existsSync(path.join(root, `history/${date}.json`))) {
    throw new Error('Partial publication detected; restore matching files before retrying');
  }
  return { date, build: true };
}

function check(root, now) {
  const ranking = readJson(root, 'ranking.json');
  dueAt(ranking.date);
  const expected = expectedDate(now);
  if (ranking.date < expected || ranking.date > dateKey(now)) {
    throw new Error(`Publication missing or stale: expected at least ${expected}, found ${ranking.date}`);
  }
  return verify(root, ranking.date);
}

function report(message, warning = false) {
  console.log(warning ? `::warning::${message}` : message);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
}

function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { date: { type: 'string' }, ref: { type: 'string' } },
  });
  const root = process.cwd();
  const now = new Date();
  switch (positionals[0]) {
    case 'plan': {
      const result = plan(root, now);
      const delay = now.getTime() - dueAt(result.date).getTime();
      if (result.build && delay > GRACE) {
        report(`Publication ${result.date} is overdue by ${Math.floor(delay / 60000)} minutes since 03:15 UTC; attempting recovery.`, true);
      }
      report(result.build ? `Preparing publication ${result.date}.` : `Publication ${result.date} already exists; skipping calculation.`);
      if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `date=${result.date}\nbuild=${result.build}\n`);
      }
      break;
    }
    case 'verify':
      verify(root, values.date, values.ref);
      report(`Verified publication ${values.date}${values.ref ? ` on ${values.ref}` : ''}: ranking, previous ranking and daily history agree.`);
      break;
    case 'check': {
      const ranking = check(root, now);
      // Commit time is a publication proxy, not proof of downstream CDN delivery.
      const committed = execFileSync('git', ['log', '-1', '--format=%cI', '--', 'ranking.json'], { encoding: 'utf8' }).trim();
      const timestamp = new Date(committed);
      if (!Number.isFinite(timestamp.getTime())) throw new Error('Cannot determine ranking commit time');
      const delay = timestamp.getTime() - dueAt(ranking.date).getTime();
      report(`Publication ${ranking.date} verified; ranking commit at ${committed}.`);
      if (delay > GRACE) report(`Publication commit was ${Math.floor(delay / 60000)} minutes after 03:15 UTC (threshold: 60 minutes).`, true);
      break;
    }
    default: throw new Error('Usage: node scripts/publication.cjs plan|check|verify [--date YYYYMMDD] [--ref origin/main]');
  }
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    // One line prevents data errors from injecting additional Actions commands.
    const message = String(error.message).replace(/[\r\n]/g, ' ').replaceAll('%', '%25');
    console.error(`::error::${message}`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, 'Publication check failed. See the error in this step.\n');
    process.exitCode = 1;
  }
}

module.exports = { check, dateKey, dueAt, expectedDate, plan, verify };
