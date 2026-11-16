import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { dashboard } from '../src/ui';
import { DesktopObserver } from '../src/observer';
import { ReadState } from '../src/read-state';
import type { Agent } from '../src/model';
import { ArchiveState } from '../src/archive-state';
import type { Widgets } from 'blessed';
import { EventEmitter } from 'node:events';
import type { SessionObserver } from '../src/monitor-observer';

test('terminal renders attention, name, directory, filters and read acknowledgement without Electron', () => {
  const root = mkdtempSync('/tmp/tcm-ui-');
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 120, rows: 32 });
  output.on('data', () => {});
  const observer = new DesktopObserver(root);
  const waiting: Agent = {
    id: 'codex:synthetic-session', externalId: 'synthetic-session', provider: 'codex',
    title: 'Waiting example', directory: '/tmp/example-repository', status: 'review',
    runtime: 'WAITING', detail: 'Waiting for approval in Codex', awaitingInput: true,
    attentionKey: 'request:approval-1', attentionToken: 'WAITING:approval-1',
    updatedAt: Date.now(), observedAt: Date.now(), evidence: 'live', archived: false,
  };
  observer.agents = [waiting, { ...waiting, id: 'codex:working-session', externalId: 'working-session',
    title: 'Working example', runtime: 'WORKING', status: 'running', attentionToken: null, awaitingInput: false }];
  const read = new ReadState(join(root, 'read.json'));
  const ui = dashboard(observer, { input, output, terminal: 'xterm-256color' }, read);
  const screenshot = () => String(ui.screen.screenshot()).replace(/\x1b\[[0-9;]*m/g, '');
  const key = (name: string) => ui.screen.emit(`key ${name}`, name, { name });
  try {
    let view = screenshot();
    assert.match(view, /1 working.*1 need attention/);
    assert.match(view, /! WAITING/);
    assert.match(view, /Waiting example/);
    assert.match(view, /Directory: \/tmp\/example-repository/);
    key('r');
    assert.equal(read.isRead(waiting), true);
    assert.match(screenshot(), /0 need attention.*1 read/);
    key('n');
    assert.match(screenshot(), /No sessions match/);
    key('d');
    assert.match(screenshot(), /READ locally/);
    key('r');
    assert.equal(read.isRead(waiting), false);
    key('w');
    assert.match(screenshot(), /Working example/);
    assert.doesNotMatch(screenshot(), /Waiting example/);
    key('a');
    key('n');
    key('x');
    assert.doesNotMatch(screenshot(), /! WAITING/);
    assert.match(screenshot(), /0 need attention/);
    assert.equal(new ArchiveState(join(root, 'archive.json')).has(waiting.id), true);
    observer.emit('update');
    key('n');
    assert.match(screenshot(), /No sessions match/);
    key('v');
    assert.match(screenshot(), /ARCHIVED locally/);
    assert.match(screenshot(), /Waiting example/);
    key('u');
    assert.match(screenshot(), /No sessions match/);
    assert.equal(new ArchiveState(join(root, 'archive.json')).has(waiting.id), false);
    assert.equal(waiting.archived, false, 'source session was not modified');
    key('a');
    output.columns = 80; output.rows = 24;
    ui.screen.program.cols = 80; ui.screen.program.rows = 24;
    ui.screen.realloc(); ui.screen.emit('resize');
    view = screenshot();
    assert.match(view, /SESSION MONITOR/);
    assert.match(view, /Directory: \/tmp\/example-repository/);
    assert.match(view, /mark read\/unread/);

    // Removing a middle row selects its successor; removing the last selects its predecessor.
    observer.agents = ['A', 'B', 'C', 'D'].map(letter => ({ ...waiting,
      id: `codex:session-${letter}`, externalId: `session-${letter}`, title: `Session ${letter}`,
      runtime: 'WORKING', status: 'running', attentionToken: null, awaitingInput: false,
    }));
    key('a');
    const list = ui.screen.children.find(child => child.type === 'list') as Widgets.ListElement;
    list.select(1);
    key('x');
    assert.match(screenshot(), /Session C  \[WORKING\]/);
    observer.emit('update');
    assert.match(screenshot(), /Session C  \[WORKING\]/);
    key('x');
    assert.match(screenshot(), /Session D  \[WORKING\]/);
    key('x');
    assert.match(screenshot(), /Session A  \[WORKING\]/);
    key('x');
    assert.match(screenshot(), /No sessions match/);
  } finally {
    ui.close(); input.destroy(); output.destroy(); rmSync(root, { recursive: true, force: true });
  }
});

test('mixed-provider terminal labels and local actions stay separate at 80 columns', () => {
  const root = mkdtempSync('/tmp/tcm-mixed-ui-');
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
  output.on('data', () => {});
  const observer: SessionObserver = Object.assign(new EventEmitter(), {
    agents: ['claude', 'codex'].map((provider): Agent => ({
      id: `${provider}:same-session`, externalId: 'same-session', provider: provider as Agent['provider'],
      title: `${provider} task`, directory: '/tmp/shared-repository', runtime: 'DONE', status: 'review',
      detail: 'Finished turn', evidence: 'history', attentionKey: 'result-1', attentionToken: 'result-1',
      updatedAt: 1000, observedAt: 1000, archived: false,
    })),
    health: { state: 'offline' as const, message: 'Reading local session history', lastObservedAt: 1000 },
    start() {}, stop() {},
  });
  const read = new ReadState(join(root, 'read.json'));
  const ui = dashboard(observer, { input, output, terminal: 'xterm-256color' }, read);
  const screenshot = () => String(ui.screen.screenshot()).replace(/\x1b\[[0-9;]*m/g, '');
  const key = (name: string) => ui.screen.emit(`key ${name}`, name, { name });
  try {
    assert.match(screenshot(), /DONE\s+claude/);
    assert.match(screenshot(), /DONE\s+codex/);
    assert.match(screenshot(), /Directory: \/tmp\/shared-repository/);
    key('r');
    assert.equal(read.isRead(observer.agents[0]), true);
    assert.equal(read.isRead(observer.agents[1]), false);
    key('d');
    key('x');
    const archive = new ArchiveState(join(root, 'archive.json'));
    assert.equal(archive.has(observer.agents[0].id), true);
    assert.equal(archive.has(observer.agents[1].id), false);
    key('a');
    assert.match(screenshot(), /codex task/);
    assert.doesNotMatch(screenshot(), /claude task/);
    key('v');
    assert.match(screenshot(), /claude task/);
    key('u');
    assert.equal(new ArchiveState(join(root, 'archive.json')).has(observer.agents[0].id), false);
    assert.equal(archive.has(observer.agents[1].id), false);
  } finally {
    ui.close(); input.destroy(); output.destroy(); rmSync(root, { recursive: true, force: true });
  }
});
