import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopObserver } from '../src/observer';
import { ReadState } from '../src/read-state';
import { classify, attentionToken, clean, type Agent } from '../src/model';
import { FrameDecoder, encodeFrame } from '../src/upstream/codex/transport';
import { projectConversation, sessionFromProjection, patchProjection, type Projection } from '../src/upstream/codex/projection';

const threadId = 'test-desktop-thread';
const base = { id: `codex:${threadId}`, provider: 'codex' as const, externalId: threadId,
  title: 'Synthetic task', directory: '/tmp/project', status: 'unknown' as const,
  detail: '', updatedAt: 1000, observedAt: 1000, evidence: 'unavailable' as const,
  attentionKey: null, archived: false };
const state = (runtime: string, turnStatus = 'inProgress', flags: string[] = []): Projection => ({
  id: threadId, threadRuntimeStatus: { type: runtime, activeFlags: flags },
  turns: [{ id: 'turn-1', status: turnStatus, turnStartedAtMs: 1000 }], hasUnreadTurn: true,
});
const agent = (s: Projection): Agent => {
  const session = sessionFromProjection(base, s);
  return { ...session, runtime: classify(s), attentionToken: attentionToken(session, s) };
};
async function until(check: () => boolean) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 4000) throw new Error('Timed out waiting for observer');
    await delay(10);
  }
}

test('runtime classification distinguishes work, approval, input, completion, idle, errors and unknown', () => {
  assert.equal(classify(state('active')), 'WORKING');
  assert.equal(classify(state('active', 'inProgress', ['waitingOnApproval'])), 'WAITING');
  assert.equal(classify(state('active', 'inProgress', ['waitingOnUserInput'])), 'WAITING');
  assert.equal(classify({ ...state('active'), requests: [{ id: 'input-1' }] }), 'WAITING');
  assert.equal(classify(state('idle', 'completed')), 'DONE');
  assert.equal(classify(state('idle', 'interrupted')), 'DONE');
  assert.equal(classify(state('notLoaded', 'failed')), 'ERROR');
  assert.equal(classify(state('systemError')), 'ERROR');
  assert.equal(classify({ threadRuntimeStatus: { type: 'idle' } }), 'IDLE');
  assert.equal(classify({}), 'UNKNOWN');
});

test('read acknowledgements survive restart and return on a new request or resumed work', () => {
  const dir = mkdtempSync('/tmp/tcm-read-');
  try {
    const path = join(dir, 'state', 'read.json');
    const read = new ReadState(path);
    const waiting = agent({ ...state('active'), requests: [{ id: 'request-1', method: 'approval' }] });
    assert.equal(read.toggle(waiting), true);
    assert.equal(read.isRead(waiting), true);
    assert.equal(new ReadState(path).isRead(waiting), true);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const unavailable: Agent = { ...waiting, evidence: 'unavailable', runtime: 'UNKNOWN', attentionToken: null };
    read.reconcile([unavailable]);
    assert.equal(read.isRead(waiting), true);
    const next = agent({ ...state('active'), requests: [{ id: 'request-2', method: 'approval' }] });
    read.reconcile([next]);
    assert.equal(read.isRead(next), false);
    read.toggle(next);
    read.reconcile([agent(state('active'))]);
    assert.equal(read.isRead(next), false);
    assert.equal(read.toggle(agent(state('active'))), false);
    const noIdentity = agent({ threadRuntimeStatus: { type: 'active', activeFlags: ['waitingOnApproval'] } });
    assert.equal(read.toggle(noIdentity), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('projection drops transcript/tool content and prevents unsafe patch paths', () => {
  const projection = projectConversation({ ...state('active'), prompt: 'secret',
    requests: [{ id: 'a', method: 'input', arguments: { secret: 'private' } }],
    turns: [{ id: 'turn-1', status: 'inProgress', text: 'private' }] });
  assert.equal(JSON.stringify(projection).includes('private'), false);
  assert.equal(JSON.stringify(projection).includes('secret'), false);
  const patched = patchProjection(projection, [
    { op: 'replace', path: ['turns', 0, 'text'], value: 'private' },
    { op: 'replace', path: ['threadRuntimeStatus', 'activeFlags'], value: ['waitingOnUserInput'] },
  ]);
  assert.equal(classify(patched), 'WAITING');
  assert.equal(JSON.stringify(patched).includes('private'), false);
  assert.throws(() => patchProjection(projection, [{ op: 'add', path: ['__proto__', 'oops'], value: 1 }]));
  assert.equal(clean('\x1b[2J{name}\n\x07title'), '[2Jname  title');
});

test('framing supports fragmented and coalesced desktop messages', () => {
  const decoder = new FrameDecoder();
  const frame = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: 2 })]);
  assert.deepEqual(decoder.push(frame.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(frame.subarray(3)), [{ a: 1 }, { b: 2 }]);
  assert.throws(() => new FrameDecoder().push(Buffer.alloc(4)));
});

test('SQLite + IPC discovers new sessions, follows revisions, degrades safely, and sends only observer operations', async () => {
  const home = mkdtempSync('/tmp/tcm-ipc-');
  mkdirSync(join(home, 'ipc'), { mode: 0o700 });
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,source TEXT,archived INTEGER,updated_at INTEGER)');
  const insert = db.prepare('INSERT INTO threads VALUES(?,?,?,?,0,?)');
  insert.run(threadId, 'Phone-accessible local session', '/tmp/repo', 'desktop', 1000);
  const outbound: Record<string, any>[] = [];
  const sockets: Socket[] = [];
  let socket: Socket;
  const send = (value: unknown) => socket.write(encodeFrame(value));
  let revision = 0;
  const snapshot = (s: Projection, version = 11) => send({ type: 'broadcast', sourceClientId: 'desktop-owner',
    method: 'thread-stream-state-changed', version,
    params: { hostId: 'local', conversationId: threadId, change: { type: 'snapshot', revision: ++revision, conversationState: s } } });
  const server = createServer(client => {
    socket = client; sockets.push(client);
    const decoder = new FrameDecoder();
    client.on('data', chunk => {
      for (const raw of decoder.push(chunk)) {
        const message = raw as Record<string, any>;
        outbound.push(message);
        if (message.method === 'initialize') send({ type: 'response', requestId: message.requestId, resultType: 'success' });
        if (message.method === 'thread-stream-following-changed' && message.params.following && message.params.conversationId === threadId)
          snapshot(state('active'));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(join(home, 'ipc', 'ipc.sock'), resolve));
  const observer = new DesktopObserver(home);
  try {
    observer.start();
    await until(() => observer.agents[0]?.runtime === 'WORKING');
    assert.equal(observer.health.state, 'live');
    snapshot({ ...state('active'), requests: [{ id: 'approval-1', method: 'approval' }] });
    await until(() => observer.agents[0]?.runtime === 'WAITING');
    assert.equal(observer.agents[0].awaitingInput, true);
    const before = observer.agents[0].activityAt;
    observer.refresh();
    assert.equal(observer.agents[0].activityAt, before, 'catalog refresh is not new activity');
    send({ type: 'broadcast', sourceClientId: 'desktop-owner', method: 'thread-stream-state-changed', version: 11,
      params: { hostId: 'local', conversationId: threadId, change: { type: 'patches', revision: ++revision, baseRevision: revision - 1,
        patches: [{ op: 'replace', path: ['requests'], value: [] },
          { op: 'replace', path: ['threadRuntimeStatus'], value: { type: 'idle' } },
          { op: 'replace', path: ['turns', 0, 'status'], value: 'completed' }] } } });
    await until(() => observer.agents[0]?.runtime === 'DONE');
    insert.run('new-phone-thread', 'New local task', '/tmp/other', 'desktop', 1001);
    await until(() => observer.agents.length === 2);
    assert.equal(observer.agents.find(a => a.externalId === 'new-phone-thread')?.runtime, 'UNKNOWN');
    db.prepare('UPDATE threads SET archived=1 WHERE id=?').run('new-phone-thread');
    await until(() => observer.agents.length === 1);
    snapshot(state('systemError'));
    await until(() => observer.agents[0]?.runtime === 'ERROR');
    // Unsupported private protocol must not pretend the old status is current.
    const unsupported: string[] = [];
    observer.on('update', () => {
      if (observer.health.state === 'degraded') unsupported.push(observer.agents[0]?.runtime);
    });
    snapshot(state('active'), 999);
    await until(() => unsupported.length > 0);
    assert.ok(unsupported.includes('UNKNOWN'));
    await until(() => observer.agents[0]?.runtime === 'WORKING');
    socket!.destroy();
    await until(() => observer.health.state === 'offline');
    assert.equal(observer.agents[0].runtime, 'UNKNOWN');
    assert.equal(observer.agents[0].awaitingInput, false);
    const allowed = new Set(['initialize', 'thread-stream-following-changed']);
    assert.ok(outbound.length > 2);
    assert.ok(outbound.every(m => allowed.has(m.method)), 'no approval, ownership, execution or read receipt commands');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM threads').get()?.count, 2);
  } finally {
    observer.stop();
    for (const client of sockets) client.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close(); rmSync(home, { recursive: true, force: true });
  }
});
