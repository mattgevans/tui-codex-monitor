import { EventEmitter } from 'node:events';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { Agent, Status } from './model';
import type { ProviderHealth } from './shared/types';
import { readDesktopRecords, readLiveProcesses, validCliSessionId,
  type DesktopRecord, type LiveProcess, type TerminalProcess } from './upstream/claude/catalog';
import { TranscriptReader, type TranscriptState } from './upstream/claude/transcript';

export interface ClaudeObserverOptions {
  configDir?: string;
  desktopDir?: string;
  processAlive?: (pid: number) => boolean;
}

function entries(path: string) {
  try { return readdirSync(path, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return [];
  }
}

/** Local Code sessions only. Does not install hooks, launch Claude or change source files. */
export class ClaudeObserver extends EventEmitter {
  agents: Agent[] = [];
  health: ProviderHealth = { provider: 'claude', state: 'connecting', message: 'Reading Claude sessions', lastObservedAt: null };
  readonly configDir: string;
  readonly desktopDir: string;
  private reader = new TranscriptReader();
  private timer?: NodeJS.Timeout;

  constructor(private options: ClaudeObserverOptions = {}) {
    super();
    this.configDir = options.configDir || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    this.desktopDir = options.desktopDir || process.env.CLAUDE_DESKTOP_DIR ||
      join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  }

  start() {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 1000);
  }

  refresh() {
    try {
      let records: DesktopRecord[] = [];
      try { records = readDesktopRecords(this.desktopDir); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const live = readLiveProcesses(join(this.configDir, 'sessions'), this.options.processAlive);
      const transcripts = new Map<string, TranscriptState>();
      const paths = new Set<string>();
      const projects = join(this.configDir, 'projects');
      for (const project of entries(projects).filter(entry => entry.isDirectory())) {
        const directory = join(projects, project.name);
        for (const file of entries(directory)) {
          const id = file.name.slice(0, -6);
          if (!file.isFile() || !file.name.endsWith('.jsonl') || !validCliSessionId(id)) continue;
          const path = join(directory, file.name);
          paths.add(`${id}\0${path}`);
          const state = this.reader.read(path, id);
          if (state && (!transcripts.has(id) || (state.activityAt ?? 0) > (transcripts.get(id)?.activityAt ?? 0)))
            transcripts.set(id, state);
        }
      }
      this.reader.retain(paths);
      const now = Date.now();
      const claimed = new Set(records.map(record => record.cliSessionId).filter(Boolean));
      this.agents = records.filter(record => !record.archived).map(record =>
        project(record.sessionId, record.cliSessionId ? transcripts.get(record.cliSessionId) : undefined,
          live.desktop.get(record.sessionId) ?? (record.cliSessionId ? live.terminal.get(record.cliSessionId) : undefined), record, now));
      for (const id of new Set([...transcripts.keys(), ...live.terminal.keys()])) {
        if (!claimed.has(id)) this.agents.push(project(id, transcripts.get(id), live.terminal.get(id), undefined, now));
      }
      const connected = live.desktop.size + live.terminal.size > 0;
      this.health = { provider: 'claude', state: connected ? 'live' : 'offline',
        message: connected ? 'Reading Claude process state and local session history' :
          this.agents.length ? 'Reading Claude session history · no live process state' : 'No local Claude Code sessions found',
        lastObservedAt: this.agents.length ? now : null };
    } catch (error) {
      // Preserve identities through observation loss, but never preserve a claim of live work.
      this.agents = this.agents.map(agent => ({ ...agent, runtime: 'UNKNOWN', status: 'unknown',
        evidence: 'unavailable', awaitingInput: false, attentionToken: null, detail: 'Claude session source unavailable' }));
      this.health = { ...this.health, state: 'degraded', message: `Could not read Claude sessions: ${String(error)}` };
    }
    this.emit('update');
  }

  stop() { clearInterval(this.timer); this.timer = undefined; }
}

function project(id: string, transcript: TranscriptState | undefined, live: LiveProcess | undefined,
  record: DesktopRecord | undefined, now: number): Agent {
  const terminal = live as TerminalProcess | undefined;
  const directory = record?.cwd ?? transcript?.directory ?? terminal?.cwd ?? null;
  let runtime: Status = transcript?.runtime ?? 'UNKNOWN';
  let identity = transcript?.identity ?? null;
  let activityAt = transcript?.activityAt;
  if (runtime === 'UNKNOWN' && record) {
    if (record.errorAt && record.errorAt >= (record.lastActivityAt ?? 0)) {
      runtime = 'ERROR'; identity = `error:${record.errorAt}`; activityAt = record.errorAt;
    } else if (record.completedTurns > 0) {
      runtime = 'DONE'; identity = `result:${record.completedTurns}`;
      activityAt = record.lastActivityAt ?? undefined;
    }
  }
  let detail = runtime === 'DONE' ? 'Claude turn finished in local session history' :
    runtime === 'ERROR' ? 'Claude reported an error in local session history' :
    runtime === 'WAITING' ? 'Claude asked a question in the local session log' :
    runtime === 'WORKING' ? 'Recent Claude turn activity in the local session log' : 'No supported Claude status evidence';
  if (live) {
    activityAt = Math.max(activityAt ?? 0, live.statusUpdatedAt ?? 0) || undefined;
    if (live.status === 'busy' || live.status === 'shell') {
      runtime = 'WORKING'; identity = null; detail = 'Claude process is working';
    } else if (live.status === 'waiting') {
      runtime = 'WAITING'; identity = live.statusUpdatedAt ? `waiting:${live.statusUpdatedAt}` : null;
      detail = live.waitingFor === 'permission prompt' ? 'Waiting for approval in Claude' : 'Waiting for your input in Claude';
    } else if (runtime !== 'DONE' && runtime !== 'ERROR') {
      runtime = 'IDLE'; identity = null; detail = 'Claude process is idle; no completed turn observed';
    }
  } else if (['WORKING', 'WAITING'].includes(runtime) && (!activityAt || now - activityAt > 120_000)) {
    runtime = 'UNKNOWN'; identity = null; detail = 'Claude session log is stale; no live process state';
  }
  const attention = ['DONE', 'ERROR', 'WAITING'].includes(runtime);
  const attentionKey = attention ? identity : null;
  return {
    id: `claude:${id}`, provider: 'claude', externalId: id,
    title: record?.title || transcript?.title || terminal?.name || `${directory ? basename(directory) : 'Claude'} · ${id.slice(0, 8)}`,
    directory, runtime, status: runtime === 'WORKING' ? 'running' : attention ? 'review' : runtime === 'IDLE' ? 'read' : 'unknown',
    detail, evidence: live ? 'live' : runtime === 'UNKNOWN' ? 'unavailable' : 'history',
    attentionKey, attentionToken: attentionKey ? JSON.stringify(['claude', runtime, attentionKey]) : null,
    awaitingInput: runtime === 'WAITING', archived: record?.archived ?? false,
    createdAt: record?.createdAt ?? transcript?.createdAt,
    activityAt, updatedAt: Math.max(activityAt ?? 0, record?.lastActivityAt ?? 0, record?.createdAt ?? 0),
    observedAt: now,
  };
}
