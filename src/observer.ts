import { openRollouts } from './upstream/codex/processes';
import { RolloutReader } from './upstream/codex/rollout';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderHealth } from './shared/types';
import { readCatalog, MissingCatalogError } from './upstream/codex/catalog';
import { CodexTransport } from './upstream/codex/transport';
import { LineageReader } from './upstream/lineage';
import { patchProjection, projectConversation, sessionFromProjection, type Projection } from './upstream/codex/projection';
import { attentionToken, classify, type Agent } from './model';

interface Live { revision: number; owner: string; state: Projection; activityAt?: number }

/** SQLite discovery + Monitor's observer protocol. No hooks, processes or session commands. */
export class DesktopObserver extends EventEmitter {
  readonly transport: CodexTransport;
  agents: Agent[] = [];
  health: ProviderHealth = { provider: 'codex', state: 'connecting', message: 'Connecting to Codex desktop', lastObservedAt: null };
  private live = new Map<string, Live>();
  private lineage = new LineageReader();
  private rollouts = new RolloutReader();
  private openPaths?: Set<string>;
  private timer?: NodeJS.Timeout;
  private running = false;
  private transportStarted = false;
  private connected = false;
  private protocolError: string | null = null;
  private catalogError: string | null = null;
  private resyncAt = new Map<string, number>();
  private tracked: string[] = [];
  constructor(readonly home = process.env.CODEX_HOME || join(homedir(), '.codex'), private readonly inspectProcesses = openRollouts) {
    super();
    this.transport = new CodexTransport(join(home, 'ipc', 'ipc.sock'));
    this.transport.on('ready', () => { this.connected = true; this.publish(); });
    this.transport.on('offline', (message: string) => {
      this.connected = false;
      this.live.clear();
      this.invalidate();
      this.publish(message);
    });
    this.transport.on('message', message => this.receive(message));
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 1000);
  }
  refresh() {
    try {
      const rows = readCatalog(this.home, [], this.lineage);
      this.catalogError = null;
      this.health.available = true;
      this.openPaths = this.inspectProcesses();
      this.tracked = rows.map(row => row.externalId);
      for (const id of this.live.keys()) if (!this.tracked.includes(id)) this.live.delete(id);
      this.rollouts.retain(rows.filter(r => r.rolloutPath).map(r => `${r.externalId}\0${r.rolloutPath}`));
      this.agents = rows.map(row => {
        const live = this.live.get(row.externalId);
        return live ? this.project(row, live.state, live.activityAt) : this.fallback(row);
      });
      this.transport.track(this.tracked);
      if (this.running && !this.transportStarted) {
        this.transportStarted = true;
        this.transport.start();
      }
      this.publish();
    } catch (error) {
      this.health.available = this.health.available === true || !(error instanceof MissingCatalogError);
      this.catalogError = error instanceof Error ? error.message : String(error);
      this.publish();
    }
  }
  private project(base: Agent | ReturnType<typeof readCatalog>[number], state: Projection, activityAt?: number): Agent {
    const session = sessionFromProjection(base, state);
    if (activityAt) session.activityAt = Math.max(session.activityAt || 0, activityAt);
    return { ...session, runtime: classify(state), attentionToken: attentionToken(session, state) };
  }
  private fallback(row: ReturnType<typeof readCatalog>[number]): Agent {
    const log = row.rolloutPath && this.rollouts.read(row.rolloutPath, row.externalId, Date.now(), true);
    if (!log) return { ...row, runtime: 'UNKNOWN', status: 'unknown', evidence: 'unavailable',
      awaitingInput: false, attentionToken: null, detail: 'No current desktop or session-log state' };
    const agent = this.project(row, log.state, log.activityAt);
    if (log.terminal && this.openPaths && !this.openPaths.has(row.rolloutPath!)) {
      return { ...agent, runtime: 'EXITED', status: 'read', evidence: 'history',
        awaitingInput: false, attentionToken: null, terminalResumeAllowed: true,
        detail: 'Codex CLI exited; no process holds this session log open' };
    }
    if (log.active && Date.now() - log.activityAt > 120_000 && !this.openPaths?.has(row.rolloutPath!))
      return { ...row, runtime: 'UNKNOWN', status: 'unknown', evidence: 'unavailable',
        awaitingInput: false, attentionToken: null, detail: 'Session log is stale; process state unavailable' };
    return { ...agent, evidence: 'history', status: log.active ? 'running' : 'review',
      detail: log.active ? 'Turn running in local session log' : 'Turn finished in local session log' };
  }
  private invalidate(id?: string) {
    this.agents = this.agents.map(a => !id || a.externalId === id ? this.fallback(a) : a);
  }
  private publish(offlineMessage = 'Codex desktop disconnected') {
    this.health = { ...this.health,
      state: this.health.available === false ? 'offline' : this.catalogError || this.protocolError ? 'degraded' : this.connected ? 'live' : 'offline',
      message: this.health.available === false ? 'No local Codex sessions found' :
        this.catalogError || this.protocolError || (this.connected ? 'Connected to Codex desktop · read-only' : offlineMessage),
    };
    this.emit('update');
  }
  private receive(message: Record<string, any>) {
    const p = message.params || {};
    if (message.method === 'client-status-changed' && p.status === 'disconnected') {
      for (const [id, live] of this.live) if (live.owner === p.clientId) {
        this.live.delete(id); this.invalidate(id);
      }
      this.publish(); return;
    }
    if (message.method === 'ipc-connection-reset') {
      this.live.clear(); this.invalidate();
      for (const id of this.tracked) this.transport.resync(id);
      this.publish(); return;
    }
    const id = p.conversationId || p.threadId;
    if (p.hostId !== 'local' || !this.tracked.includes(id)) return;
    if (message.method === 'thread-read-state-changed' && message.version === 3) {
      const live = this.live.get(id);
      if (live && typeof p.hasUnreadTurn === 'boolean') {
        live.state = { ...live.state, hasUnreadTurn: p.hasUnreadTurn };
        this.update(id, live);
      }
      return;
    }
    if (message.method !== 'thread-stream-state-changed') return;
    try {
      if (message.version !== 11) throw new Error(`Unsupported Codex stream version ${message.version}; expected 11`);
      const c = p.change;
      const old = this.live.get(id);
      if (!c || !Number.isSafeInteger(c.revision)) throw new Error('Missing Codex revision');
      if (old && old.owner === message.sourceClientId && c.revision <= old.revision) return;
      let state: Projection;
      if (c.type === 'snapshot') {
        if (c.conversationState?.id !== id) throw new Error('Codex snapshot identity mismatch');
        state = projectConversation(c.conversationState);
      } else if (c.type === 'patches') {
        if (!old || old.owner !== message.sourceClientId || c.baseRevision !== old.revision)
          throw new Error('Missed Codex state update; resynchronizing');
        state = patchProjection(old.state, c.patches);
      } else throw new Error('Unknown Codex state message');
      this.protocolError = null;
      this.update(id, { revision: c.revision, owner: String(message.sourceClientId), state });
    } catch (error) {
      this.protocolError = error instanceof Error ? error.message : String(error);
      this.live.delete(id); this.invalidate(id);
      if (Date.now() - (this.resyncAt.get(id) || 0) > 2000) {
        this.resyncAt.set(id, Date.now()); this.transport.resync(id);
      }
      this.publish();
    }
  }
  private update(id: string, live: Live) {
    const previous = this.live.get(id);
    const signature = (state: Projection) => JSON.stringify([
      state.threadRuntimeStatus, state.requests, state.turns, state.turnHistory,
    ]);
    live.activityAt = previous && signature(previous.state) !== signature(live.state)
      ? Date.now() : previous?.activityAt;
    this.live.set(id, live);
    this.agents = this.agents.map(a => a.externalId === id ? this.project(a, live.state, live.activityAt) : a);
    this.health.lastObservedAt = Date.now();
    this.publish();
  }
  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.transport.stop();
    this.transportStarted = false;
  }
}
