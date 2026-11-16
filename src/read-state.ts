import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { needsAttention, type Agent } from './model';

/** Local acknowledgements only. Never writes to CODEX_HOME or desktop IPC. */
export class ReadState {
  private entries: Record<string, string> = Object.create(null);
  constructor(readonly path = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'tui-codex-monitor', 'read.json')) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Expected an object');
      for (const [id, token] of Object.entries(parsed)) if (typeof token === 'string') this.entries[id] = token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(`Cannot load local read state at ${path}: ${String(error)}`);
    }
  }
  isRead(agent: Agent) { return !!agent.attentionToken && this.entries[agent.id] === agent.attentionToken; }
  toggle(agent: Agent) {
    if (!needsAttention(agent) || !agent.attentionToken) return false;
    const next = { ...this.entries };
    if (this.isRead(agent)) delete next[agent.id];
    else next[agent.id] = agent.attentionToken;
    this.save(next);
    return true;
  }
  reconcile(agents: Agent[]) {
    const next = { ...this.entries };
    for (const agent of agents) {
      if (agent.evidence === 'unavailable') continue;
      if (next[agent.id] && next[agent.id] !== agent.attentionToken) delete next[agent.id];
    }
    if (JSON.stringify(next) !== JSON.stringify(this.entries)) this.save(next);
  }
  private save(next: Record<string, string>) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
    this.entries = next;
  }
}
