import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ClaudeObserver } from '../src/claude-observer';
import { TranscriptReader } from '../src/upstream/claude/transcript';
import { readLiveProcesses } from '../src/upstream/claude/catalog';
import { ReadState } from '../src/read-state';
import { ArchiveState } from '../src/archive-state';

const id = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const desktopId = `local_${id}`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tcm-claude-'));
  const config = join(root, 'config');
  const project = join(config, 'projects', '-tmp-project');
  const desktop = join(root, 'desktop');
  const org = join(desktop, 'account', 'org');
  mkdirSync(project, { recursive: true });
  mkdirSync(org, { recursive: true });
  mkdirSync(join(config, 'sessions'));
  const path = join(project, `${id}.jsonl`);
  const event = (type: string, fields: Record<string, unknown> = {}) => ({
    sessionId: id, cwd: '/tmp/project', type, timestamp: new Date().toISOString(), uuid: 'event-1', ...fields,
  });
  const append = (type: string, fields: Record<string, unknown> = {}) =>
    appendFileSync(path, JSON.stringify(event(type, fields)) + '\n');
  const proc = (fields: Record<string, unknown>) => writeFileSync(join(config, 'sessions', '123.json'),
    JSON.stringify({ pid: 123, entrypoint: 'cli', kind: 'interactive', sessionId: id, status: 'busy',
      statusUpdatedAt: Date.now(), cwd: '/tmp/project', ...fields }));
  const record = (fields: Record<string, unknown> = {}) => writeFileSync(join(org, `${desktopId}.json`),
    JSON.stringify({ sessionId: desktopId, cliSessionId: id, title: 'Desktop task', cwd: '/tmp/project',
      createdAt: 1000, lastActivityAt: 2000, completedTurns: 1, initialMessage: 'SECRET', ...fields }));
  const observer = new ClaudeObserver({ configDir: config, desktopDir: desktop, processAlive: () => true });
  const run = (args: string[]) => spawnSync(process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/cli.ts', ...args],
    { encoding: 'utf8', timeout: 10000, env: { ...process.env, CODEX_HOME: join(root, 'codex'),
      CLAUDE_CONFIG_DIR: config, CLAUDE_DESKTOP_DIR: desktop, XDG_STATE_HOME: root } });
  return { root, config, project, org, path, observer, event, append, proc, record, run };
}

test('Claude transcript discovery, questions, results, errors, refresh and local acknowledgements', t => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const read = new ReadState(join(f.root, 'read.json'));
  f.append('custom-title', { customTitle: 'Named Claude task' });
  f.append('user', { message: { content: 'SECRET PROMPT' } });
  f.observer.refresh();
  assert.equal(f.observer.agents[0].runtime, 'WORKING');
  assert.equal(f.observer.agents[0].title, 'Named Claude task');
  assert.equal(f.observer.agents[0].directory, '/tmp/project');
  f.append('assistant', { uuid: 'question-1', message: { stop_reason: 'tool_use', content: [
    { type: 'tool_use', name: 'AskUserQuestion', input: { questions: 'SECRET QUESTION' } },
  ] } });
  f.observer.refresh();
  assert.equal(f.observer.agents[0].runtime, 'WAITING');
  assert.equal(read.toggle(f.observer.agents[0]), true);
  f.observer.refresh();
  assert.equal(read.isRead(f.observer.agents[0]), true);
  f.append('user', { uuid: 'answer-1', message: { content: [{ type: 'tool_result', content: 'SECRET ANSWER' }] } });
  f.observer.refresh();
  read.reconcile(f.observer.agents);
  assert.equal(f.observer.agents[0].runtime, 'WORKING');
  assert.equal(read.isRead(f.observer.agents[0]), false);
  f.append('assistant', { uuid: 'result-1', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'SECRET RESPONSE' }] } });
  const before = readFileSync(f.path);
  f.observer.refresh();
  assert.equal(f.observer.agents[0].runtime, 'DONE');
  assert.equal(read.toggle(f.observer.agents[0]), true);
  assert.equal(new ReadState(read.path).isRead(f.observer.agents[0]), true);
  const archive = new ArchiveState(join(f.root, 'archive.json'));
  archive.set(f.observer.agents[0].id, true);
  assert.equal(archive.has(`codex:${id}`), false);
  assert.deepEqual(readFileSync(f.path), before);
  f.append('assistant', { uuid: 'error-1', isApiErrorMessage: true, message: { content: 'SECRET ERROR' } });
  f.observer.refresh();
  assert.equal(f.observer.agents[0].runtime, 'ERROR');
  assert.equal(read.isRead(f.observer.agents[0]), false);
  assert.doesNotMatch(JSON.stringify(f.observer.agents), /SECRET/);
});

test('Claude process registry overrides logs, distinguishes approval, idle and busy, and ignores dead PIDs', t => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.proc({ status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: 10 });
  f.observer.refresh();
  assert.equal(f.observer.health.state, 'live');
  assert.equal(f.observer.agents[0].runtime, 'WAITING');
  assert.match(f.observer.agents[0].detail, /approval/);
  const token = f.observer.agents[0].attentionToken;
  f.proc({ status: 'waiting', statusUpdatedAt: 11 });
  f.observer.refresh();
  assert.notEqual(f.observer.agents[0].attentionToken, token);
  assert.match(f.observer.agents[0].detail, /input/);
  f.proc({ status: 'busy' });
  f.observer.refresh();
  assert.equal(f.observer.agents[0].runtime, 'WORKING');
  f.proc({ status: 'idle' });
  f.observer.refresh();
  assert.equal(f.observer.agents[0].runtime, 'IDLE');
  f.append('assistant', { message: { stop_reason: 'end_turn' } });
  f.observer.refresh();
  assert.equal(f.observer.agents[0].runtime, 'DONE');
  assert.equal(readLiveProcesses(join(f.config, 'sessions'), () => false).terminal.size, 0);
  f.proc({ pid: 999 });
  assert.equal(readLiveProcesses(join(f.config, 'sessions'), () => true).terminal.size, 0);
  f.proc({ kind: 'headless' });
  assert.equal(readLiveProcesses(join(f.config, 'sessions'), () => true).terminal.size, 0);
});

test('Claude desktop metadata is deduplicated with CLI sessions and excludes source archives', t => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.record();
  f.append('assistant', { message: { stop_reason: 'end_turn' } });
  f.proc({ hostSessionId: desktopId, entrypoint: 'claude-desktop', status: 'busy' });
  f.observer.refresh();
  assert.equal(f.observer.agents.length, 1);
  assert.equal(f.observer.agents[0].externalId, desktopId);
  assert.equal(f.observer.agents[0].title, 'Desktop task');
  assert.equal(f.observer.agents[0].runtime, 'WORKING');
  assert.doesNotMatch(JSON.stringify(f.observer.agents), /SECRET/);
  f.record({ isArchived: true });
  f.observer.refresh();
  assert.equal(f.observer.agents.length, 0);
  rmSync(f.path);
  rmSync(join(f.config, 'sessions', '123.json'));
  f.record();
  f.observer.refresh();
  assert.equal(f.observer.agents[0].runtime, 'DONE');
  assert.equal(f.observer.agents[0].evidence, 'history');
});

test('Claude logs require complete matching records, exclude subagents and expire silent work', t => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const old = new Date(Date.now() - 180_000).toISOString();
  f.append('user', { timestamp: old });
  f.append('assistant', { sessionId: otherId, message: { stop_reason: 'end_turn' } });
  f.append('assistant', { isSidechain: true, message: { stop_reason: 'end_turn' } });
  appendFileSync(f.path, '{malformed}\n');
  const pending = JSON.stringify(f.event('assistant', { uuid: 'final', message: { stop_reason: 'end_turn' } }));
  appendFileSync(f.path, pending);
  f.observer.refresh();
  assert.equal(f.observer.agents[0].runtime, 'UNKNOWN');
  appendFileSync(f.path, '\n');
  f.observer.refresh();
  assert.equal(f.observer.agents[0].runtime, 'DONE');
  mkdirSync(join(f.project, id, 'subagents'), { recursive: true });
  writeFileSync(join(f.project, id, 'subagents', `${otherId}.jsonl`), JSON.stringify(f.event('user', { sessionId: otherId })) + '\n');
  f.observer.refresh();
  assert.equal(f.observer.agents.length, 1);
  f.append('user', { timestamp: old, uuid: 'new-turn' });
  f.observer.refresh();
  assert.equal(f.observer.agents[0].runtime, 'UNKNOWN', 'cache refresh must not make old work fresh');
});

test('Claude bounded reads preserve metadata and find explicit completion beyond a large transcript', t => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.append('user');
  f.append('custom-title', { customTitle: 'Large session' });
  f.append('file-history-snapshot', { snapshot: 'SECRET'.repeat(600_000) });
  f.append('assistant', { uuid: 'assistant-final', message: { stop_reason: null } });
  f.append('system', { uuid: undefined, subtype: 'turn_duration' });
  const reader = new TranscriptReader();
  const state = reader.read(f.path, id)!;
  assert.equal(state.title, 'Large session');
  assert.equal(state.runtime, 'DONE');
  assert.equal(state.identity, 'assistant-final');
  assert.doesNotMatch(JSON.stringify(state), /SECRET/);
  assert.equal(reader.read(f.path, otherId), undefined);
  assert.strictEqual(reader.read(f.path, id), state);
});

test('Claude source failures invalidate live claims and recover on the next refresh', t => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.proc({});
  f.observer.refresh();
  const projects = join(f.config, 'projects');
  renameSync(projects, `${projects}-saved`);
  writeFileSync(projects, 'not a directory');
  f.observer.refresh();
  assert.equal(f.observer.health.state, 'degraded');
  assert.equal(f.observer.agents[0].runtime, 'UNKNOWN');
  assert.equal(f.observer.agents[0].evidence, 'unavailable');
  rmSync(projects);
  renameSync(`${projects}-saved`, projects);
  f.observer.refresh();
  assert.equal(f.observer.health.state, 'live');
  assert.equal(f.observer.agents[0].runtime, 'WORKING');
});

test('CLI automatically discovers Claude without Codex and supports native and namespaced selectors', t => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.append('assistant', { message: { stop_reason: 'end_turn', content: 'SECRET' } });
  for (const selector of [id, `claude:${id}`]) {
    const result = f.run(['--json', '--duration=100', '--session', selector]);
    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout);
    assert.equal(snapshot.health.state, 'offline');
    const codex = snapshot.health.providers.find((provider: { provider: string }) => provider.provider === 'codex');
    assert.equal(codex.available, false);
    assert.equal(codex.state, 'offline');
    assert.doesNotMatch(result.stdout + result.stderr, /ENOENT|no such file or directory/);
    assert.equal(existsSync(join(f.root, 'codex')), false);
    assert.equal(snapshot.sessions[0].id, id);
    assert.equal(snapshot.sessions[0].provider, 'claude');
    assert.equal(snapshot.sessions[0].monitorId, `claude:${id}`);
    assert.equal(snapshot.sessions[0].status, 'DONE');
    assert.doesNotMatch(result.stdout, /SECRET/);
  }
  for (const args of [['--provider', 'claude'], ['--provider=codex'], ['--provider=all']]) {
    const result = f.run(['--json', ...args]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /all supported providers are discovered automatically/);
  }
});

test('mixed JSON keeps provider identities distinct and exposes independent catalog failures', t => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.append('assistant', { message: { stop_reason: 'end_turn' } });
  const codex = join(f.root, 'codex');
  mkdirSync(codex);
  const dbPath = join(codex, 'state_1.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,source TEXT,archived INTEGER,updated_at INTEGER)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,0,?)').run(id, 'Codex task', '/tmp/project', 'cli', 1000);
  db.close();
  const all = f.run(['--json', '--duration=100']);
  assert.equal(all.status, 0, all.stderr);
  const allSnapshot = JSON.parse(all.stdout);
  assert.equal(allSnapshot.sessions.length, 2, 'plain JSON mode discovers both providers without selection');
  assert.deepEqual(allSnapshot.health.providers.map((provider: { provider: string }) => provider.provider).sort(), ['claude', 'codex']);
  const result = f.run(['--json', '--duration=100', `--session=${id}`]);
  assert.equal(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.sessions.length, 2);
  assert.deepEqual(snapshot.sessions.map((session: { provider: string }) => session.provider).sort(), ['claude', 'codex']);
  const selected = JSON.parse(f.run(['--json', '--duration=100', `--session=codex:${id}`]).stdout);
  assert.equal(selected.sessions.length, 1);
  writeFileSync(dbPath, 'corrupted database');
  const failed = f.run(['--json', '--duration=100']);
  assert.equal(failed.status, 1);
  const degraded = JSON.parse(failed.stdout);
  assert.equal(degraded.health.state, 'degraded');
  assert.equal(degraded.sessions[0].provider, 'claude');
});
