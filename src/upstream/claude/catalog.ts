import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Same shape the desktop's own `claude://code/continue?session=` handler accepts. */
export const validSessionId = (id: string) => /^local_[A-Za-z0-9-]{1,64}$/.test(id);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Claude Code's own session id, as accepted by `claude --resume`. */
export const validCliSessionId = (id: string) => uuid.test(id);
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

/** Whitelisted desktop session metadata. Prompts, summaries and error text are never kept. */
export interface DesktopRecord {
  sessionId: string;
  cliSessionId: string | null;
  title: string | null;
  titleSource?: 'user' | 'auto';
  cwd: string | null;
  archived: boolean;
  createdAt: number | null;
  lastActivityAt: number | null;
  lastFocusedAt: number | null;
  lastAssistantUuid: string | null;
  /** Successful turns; incremented once per turn, unlike the per-message uuid. */
  completedTurns: number;
  forkedFromSessionId?: string | null;
  lineageDetached?: boolean;
  errorAt: number | null;
}

/** A Claude Code process registered in `<config>/sessions/<pid>.json`. */
export interface LiveProcess {
  pid: number;
  status: 'busy' | 'shell' | 'idle' | 'waiting' | 'unknown';
  waitingFor: string | null;
  statusUpdatedAt: number | null;
}

const time = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 4e15 ? value : null;
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (statSync(path).size > MAX_RECORD_BYTES) return null;
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    // A record can be mid-write; the next pass reads it again.
    return null;
  }
}

function recordFiles(root: string): string[] {
  // <root>/<account>/<org>/local_<id>.json
  const files: string[] = [];
  const dirs = (path: string) =>
    readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => join(path, entry.name));
  for (const account of dirs(root))
    for (const org of dirs(account))
      for (const name of readdirSync(org))
        if (/^local_[A-Za-z0-9-]{1,64}\.json$/.test(name)) files.push(join(org, name));
  return files;
}

/** Read every desktop Code-tab session record. Throws only if the store itself is unreadable. */
export function readDesktopRecords(root: string): DesktopRecord[] {
  const byId = new Map<string, DesktopRecord>();
  for (const file of recordFiles(root)) {
    const raw = readJson(file);
    const sessionId = raw?.sessionId;
    if (!raw || typeof sessionId !== 'string' || !validSessionId(sessionId)) continue;
    const assistant = raw.lastAssistantUuid;
    const record: DesktopRecord = {
      sessionId,
      cliSessionId:
        typeof raw.cliSessionId === 'string' && uuid.test(raw.cliSessionId)
          ? raw.cliSessionId
          : null,
      title: text(raw.title)?.slice(0, 500) ?? null,
      titleSource: raw.titleSource === 'user' || raw.titleSource === 'auto' ? raw.titleSource : undefined,
      cwd: text(raw.cwd),
      archived: raw.isArchived === true,
      createdAt: time(raw.createdAt),
      lastActivityAt: time(raw.lastActivityAt),
      lastFocusedAt: time(raw.lastFocusedAt),
      lastAssistantUuid: typeof assistant === 'string' && uuid.test(assistant) ? assistant : null,
      completedTurns:
        Number.isSafeInteger(raw.completedTurns) && (raw.completedTurns as number) > 0
          ? (raw.completedTurns as number)
          : 0,
      forkedFromSessionId:
        typeof raw.forkedFromSessionId === 'string' &&
        validSessionId(raw.forkedFromSessionId) &&
        raw.forkedFromSessionId !== sessionId
          ? raw.forkedFromSessionId
          : null,
      lineageDetached: raw.lineageDetached === true,
      errorAt: raw.error !== undefined && raw.error !== null ? time(raw.errorAt) : null,
    };
    const old = byId.get(sessionId);
    if (!old || (record.lastActivityAt ?? 0) > (old.lastActivityAt ?? 0))
      byId.set(sessionId, record);
  }
  return [...byId.values()];
}

export function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves exit. Permission/inspection errors must not claim a process died.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** A terminal (`claude` CLI) process; it has no desktop record. */
export interface TerminalProcess extends LiveProcess {
  sessionId: string;
  cwd: string | null;
  name: string | null;
}

export interface LiveProcesses {
  /** Keyed by desktop `local_` session id. */
  desktop: Map<string, LiveProcess>;
  /** Keyed by Claude Code session uuid. */
  terminal: Map<string, TerminalProcess>;
  /** Valid registry identities whose owning process has exited. */
  exitedDesktop: Map<string, LiveProcess>;
  exitedTerminal: Map<string, TerminalProcess>;
}

/** Newest process per session, with confirmed exits separate from live state. */
export function readLiveProcesses(
  registry: string,
  alive: (pid: number) => boolean = processAlive,
): LiveProcesses {
  const out: LiveProcesses = { desktop: new Map(), terminal: new Map(), exitedDesktop: new Map(), exitedTerminal: new Map() };
  let names: string[];
  try {
    names = readdirSync(registry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return out;
  }
  const newer = (old: LiveProcess | undefined, entry: LiveProcess) =>
    !old || (entry.statusUpdatedAt ?? 0) > (old.statusUpdatedAt ?? 0);
  for (const name of names) {
    const match = /^(\d{1,10})\.json$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid < 1 || pid > 0x7fffffff) continue;
    const raw = readJson(join(registry, name));
    if (!raw || raw.pid !== pid) continue;
    const status = raw.status === 'busy' || raw.status === 'shell' || raw.status === 'idle' || raw.status === 'waiting'
      ? raw.status : 'unknown';
    const host = raw.hostSessionId,
      session = raw.sessionId;
    const desktop = typeof host === 'string' && validSessionId(host);
    const terminal =
      !desktop &&
      raw.entrypoint === 'cli' &&
      raw.kind === 'interactive' &&
      typeof session === 'string' &&
      uuid.test(session);
    if (!desktop && !terminal) continue;
    const running = alive(pid);
    const entry: LiveProcess = {
      pid,
      status,
      // The CLI writes a short fixed phrase here, e.g. "permission prompt" or "input needed".
      waitingFor:
        typeof raw.waitingFor === 'string' && /^[a-z ]{1,40}$/.test(raw.waitingFor)
          ? raw.waitingFor
          : null,
      statusUpdatedAt: time(raw.statusUpdatedAt),
    };
    if (desktop) {
      const target = running ? out.desktop : out.exitedDesktop;
      if (newer(target.get(host), entry)) target.set(host, entry);
    } else {
      const target = running ? out.terminal : out.exitedTerminal;
      if (newer(target.get(session as string), entry)) target.set(session as string, {
        ...entry,
        sessionId: session as string,
        cwd: text(raw.cwd),
        name: text(raw.name)?.slice(0, 200) ?? null,
      });
    }
  }
  return out;
}
