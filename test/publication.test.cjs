const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { check, dueAt, expectedDate, plan, verify } = require('../scripts/publication.cjs');

const now = new Date('2026-10-21T08:28:21Z');
const rootSource = path.resolve(__dirname, '..');
const payload = (date) => ({ date, rows: [{ name: 'Example', score: 75, rank: 1 }] });

function fixture(t, date = '20261020') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'history'));
  writeBundle(root, date);
  return root;
}

function writeBundle(root, date, data = payload(date)) {
  for (const file of ['ranking.json', 'prev_ranking.json', `history/${date}.json`]) {
    fs.writeFileSync(path.join(root, file), JSON.stringify(data));
  }
}

test('UTC deadline, grace period, midnight and DST dates', () => {
  assert.equal(expectedDate(new Date('2026-10-21T00:00:00Z')), '20261020');
  assert.equal(expectedDate(new Date('2026-10-21T04:14:59Z')), '20261020');
  assert.equal(expectedDate(new Date('2026-10-21T04:15:00Z')), '20261021');
  assert.equal(expectedDate(new Date('2027-01-01T01:00:00Z')), '20261231');
  assert.equal(expectedDate(new Date('2028-03-01T01:00:00Z')), '20280229');
  for (const date of ['20260329', '20261025']) assert.equal(dueAt(date).getUTCHours(), 3);
  assert.equal((now - dueAt('20261021')) / 1000, 18801);
  assert.throws(() => dueAt('20260230'));
});

test('missing daily publication permits recovery but fails watchdog', t => {
  const root = fixture(t);
  assert.deepEqual(plan(root, now), { date: '20261021', build: true });
  assert.throws(() => check(root, now), /missing or stale/);
  assert.equal(check(root, new Date('2026-10-21T04:14:59Z')).date, '20261020');
});

test('a successful publication makes primary, fallback and manual reruns no-ops', t => {
  const root = fixture(t, '20261021');
  const before = fs.readFileSync(path.join(root, 'prev_ranking.json'), 'utf8');
  for (let i = 0; i < 3; i++) assert.equal(plan(root, now).build, false);
  assert.equal(check(root, now).date, '20261021');
  assert.equal(fs.readFileSync(path.join(root, 'prev_ranking.json'), 'utf8'), before);
});

test('missing, malformed, empty and inconsistent outputs are rejected', t => {
  const root = fixture(t, '20261021');
  fs.unlinkSync(path.join(root, 'history/20261021.json'));
  assert.throws(() => plan(root, now), /ENOENT/);
  writeBundle(root, '20261021', { date: '20261021', rows: [] });
  assert.throws(() => verify(root, '20261021'), /no rows/);
  writeBundle(root, '20261021');
  fs.writeFileSync(path.join(root, 'prev_ranking.json'), JSON.stringify(payload('20261020')));
  assert.throws(() => check(root, now), /does not match/);
  fs.writeFileSync(path.join(root, 'ranking.json'), '{');
  assert.throws(() => plan(root, now), SyntaxError);
});

test('partial daily state must not trigger another score calculation', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'history/20261021.json'), JSON.stringify(payload('20261021')));
  assert.throws(() => plan(root, now), /Partial publication/);
  fs.unlinkSync(path.join(root, 'history/20261021.json'));
  fs.writeFileSync(path.join(root, 'prev_ranking.json'), JSON.stringify(payload('20261021')));
  assert.throws(() => plan(root, now), /Partial publication/);
});

test('future dates and generation crossing midnight fail verification', t => {
  const root = fixture(t, '20261022');
  assert.throws(() => plan(root, now), /future/);
  assert.throws(() => check(root, now), /missing or stale/);
  assert.throws(() => verify(root, '20261021'), /expected 20261021/);
});

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitFixture(t) {
  const root = fixture(t);
  fs.cpSync(path.join(rootSource, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Seed');
  const remote = path.join(root, 'remote.git');
  git(root, 'init', '--bare', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-u', 'origin', 'main');
  return { root, remote };
}

function publish(root, env = {}) {
  return spawnSync('bash', ['scripts/publish-ranking.sh', '20261021'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...env },
  });
}

test('push publishes matching files; local-only files cannot satisfy remote verification', t => {
  const { root } = gitFixture(t);
  writeBundle(root, '20261021');
  assert.throws(() => verify(root, '20261021', 'origin/main'), /expected 20261021/);
  const result = publish(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(verify(root, '20261021', 'origin/main').date, '20261021');
  const head = git(root, 'rev-parse', 'HEAD');
  assert.equal(publish(root).status, 0);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
});

test('real commit errors fail and never publish', t => {
  const { root } = gitFixture(t);
  writeBundle(root, '20261021');
  fs.writeFileSync(path.join(root, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.notEqual(publish(root).status, 0);
  assert.equal(verify(root, '20261020', 'origin/main').date, '20261020');
});

test('a concurrent change to main is preserved, never force-pushed or blindly rebased', t => {
  const { root, remote } = gitFixture(t);
  const other = path.join(root, 'other');
  git(root, 'clone', '--branch', 'main', remote, other);
  git(other, 'config', 'user.name', 'Other');
  git(other, 'config', 'user.email', 'other@example.invalid');
  fs.writeFileSync(path.join(other, 'README.md'), 'Concurrent edit');
  git(other, 'add', 'README.md');
  git(other, 'commit', '-m', 'Concurrent edit');
  git(other, 'push', 'origin', 'main');
  const remoteHead = git(other, 'rev-parse', 'HEAD');
  writeBundle(root, '20261021');
  const result = publish(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /main changed during publication/);
  assert.equal(git(root, '--git-dir', remote, 'rev-parse', 'main'), remoteHead);
});

test('a lost successful push response is recognized without another commit', t => {
  const { root } = gitFixture(t);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  // Only push loses its response; all operations still use a real local Git remote.
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/bash\n"$REAL_GIT" "$@"\nresult=$?\nif [[ "$1" == push && "$result" == 0 ]]; then exit 1; fi\nexit "$result"\n', { mode: 0o755 });
  writeBundle(root, '20261021');
  const result = publish(root, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, REAL_GIT: realGit });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(verify(root, '20261021', 'origin/main').date, '20261021');
  assert.equal(git(root, 'rev-list', '--count', 'main'), '2');
});

for (const recover of [true, false]) {
  test(recover ? 'transient push failures recover on the third attempt' : 'persistent push failure stops after three attempts', t => {
    const { root } = gitFixture(t);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/bash
if [[ "$1" == push ]]; then
  count=0
  if [[ -f "$PUSH_COUNT" ]]; then count=$(cat "$PUSH_COUNT"); fi
  count=$((count + 1))
  echo "$count" > "$PUSH_COUNT"
  if [[ "$count" -lt 3 || "$RECOVER" != true ]]; then exit 1; fi
fi
exec "$REAL_GIT" "$@"
`, { mode: 0o755 });
    // Retry timing is not under test; avoid ten seconds of waiting per fixture.
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeBundle(root, '20261021');
    const counter = path.join(root, 'push-count');
    const result = publish(root, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, REAL_GIT: realGit, PUSH_COUNT: counter, RECOVER: String(recover) });
    assert.equal(fs.readFileSync(counter, 'utf8').trim(), '3');
    assert.equal(result.status === 0, recover, result.stdout + result.stderr);
    assert.equal(verify(root, recover ? '20261021' : '20261020', 'origin/main').date, recover ? '20261021' : '20261020');
  });
}
