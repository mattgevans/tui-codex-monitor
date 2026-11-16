import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const run = (args: string[], home: string) => spawnSync(process.execPath,
  ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/cli.ts', ...args],
  { encoding: 'utf8', timeout: 10000, env: { ...process.env, CODEX_HOME: home, XDG_STATE_HOME: home,
    CLAUDE_CONFIG_DIR: join(home, 'claude'), CLAUDE_DESKTOP_DIR: join(home, 'claude-desktop') } });

test('JSON mode works without a terminal or desktop and returns one metadata snapshot', () => {
  const home = mkdtempSync(join(tmpdir(), 'tcm-json-'));
  try {
    const db = new DatabaseSync(join(home, 'state_1.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,source TEXT,archived INTEGER,updated_at INTEGER)');
    db.prepare('INSERT INTO threads VALUES(?,?,?,?,0,?)').run('test-session', 'Example task', '/tmp/project', 'cli', 1000);
    db.close();
    const result = run(['--json', '--duration=100'], home);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const snapshot = JSON.parse(result.stdout);
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.health.state, 'offline');
    assert.equal(snapshot.counts.statuses.UNKNOWN, 1);
    assert.equal(snapshot.counts.statuses.EXITED, 0);
    assert.equal(snapshot.sessions[0].id, 'test-session');
    assert.equal(snapshot.sessions[0].title, 'Example task');
    assert.equal(snapshot.sessions[0].directory, '/tmp/project');
    assert.equal(snapshot.sessions[0].status, 'UNKNOWN');
    assert.equal(snapshot.sessions[0].archivedLocally, false);
    assert.equal(snapshot.sessions[0].readLocally, false);
    assert.equal('attentionToken' in snapshot.sessions[0], false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('JSON mode reports catalog failure in JSON and exits nonzero', () => {
  const home = mkdtempSync(join(tmpdir(), 'tcm-json-'));
  try {
    const db = new DatabaseSync(join(home, 'state_1.sqlite'));
    db.exec('CREATE TABLE unsupported(id TEXT)');
    db.close();
    const result = run(['--json', '--duration=100'], home);
    assert.equal(result.status, 1, result.stderr);
    const snapshot = JSON.parse(result.stdout);
    assert.equal(snapshot.health.state, 'degraded');
    assert.deepEqual(snapshot.sessions, []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('JSON mode filters by exact session ID and reports missing sessions', () => {
  const home = mkdtempSync(join(tmpdir(), 'tcm-json-session-'));
  const id = '01a1b27b-e56e-7a12-9022-aed8796135c0';
  try {
    const db = new DatabaseSync(join(home, 'state_1.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,source TEXT,archived INTEGER,updated_at INTEGER)');
    const insert = db.prepare('INSERT INTO threads VALUES(?,?,?,?,0,?)');
    insert.run(id, 'Selected task', '/tmp/selected', 'cli', 1000);
    insert.run(`${id}-other`, 'Other task', '/tmp/other', 'cli', 1000);
    db.close();
    for (const selector of [['--session', id], [`--session=${id}`]]) {
      const result = run(['--json', '--duration=100', ...selector], home);
      assert.equal(result.status, 0, result.stderr);
      const snapshot = JSON.parse(result.stdout);
      assert.deepEqual(snapshot.sessions.map((session: { id: string }) => session.id), [id]);
      assert.equal(snapshot.counts.total, 1);
      assert.equal(snapshot.counts.statuses.UNKNOWN, 1);
    }
    const missing = run(['--json', '--duration=100', '--session', 'missing'], home);
    assert.equal(missing.status, 1, missing.stderr);
    const snapshot = JSON.parse(missing.stdout);
    assert.deepEqual(snapshot.sessions, []);
    assert.equal(snapshot.counts.total, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('session selector requires JSON mode and a single nonempty ID', () => {
  for (const args of [
    ['--session', 'test'], ['--probe', '--session=test'], ['--json', '--session'],
    ['--json', '--session='], ['--json', '--session', '--duration=100'],
    ['--json', '--session=a', '--session=b'],
  ]) {
    const result = run(args, '/nonexistent');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
});

test('JSON mode rejects invalid durations and conflicting output modes', () => {
  for (const args of [['--json', '--duration=0'], ['--json', '--probe']]) {
    const result = run(args, '/nonexistent');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
});

test('snapshot respects local read/archive flags without changing acknowledgements', async () => {
  const { statusSnapshot } = await import('../src/snapshot');
  const { ReadState } = await import('../src/read-state');
  const { ArchiveState } = await import('../src/archive-state');
  const { readFileSync } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'tcm-snapshot-'));
  try {
    const read = new ReadState(join(home, 'read.json'));
    const archive = new ArchiveState(join(home, 'archive.json'));
    const agent = { id: 'codex:test-session', externalId: 'test-session', provider: 'codex' as const,
      title: 'Task', directory: null, runtime: 'DONE' as const, status: 'review' as const,
      detail: '', updatedAt: 1000, observedAt: 1000, evidence: 'live' as const,
      archived: false, attentionKey: 'turn-1', attentionToken: 'turn-1' };
    read.toggle(agent);
    archive.set(agent.id, true);
    const before = readFileSync(read.path, 'utf8');
    const snapshot = statusSnapshot({ agents: [agent], health: {
      provider: 'codex', state: 'live', message: 'Connected', lastObservedAt: 1000,
    } }, read, archive);
    assert.equal(snapshot.sessions[0].status, 'DONE');
    assert.equal(snapshot.sessions[0].readLocally, true);
    assert.equal(snapshot.sessions[0].needsAttention, false);
    assert.equal(snapshot.sessions[0].archivedLocally, true);
    assert.equal(snapshot.counts.total, 1);
    assert.equal(snapshot.counts.visible, 0);
    assert.equal(snapshot.counts.statuses.DONE, 0);
    assert.equal(readFileSync(read.path, 'utf8'), before);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
