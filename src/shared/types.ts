export type ProviderId = 'codex' | 'claude';
export type SessionStatus = 'review' | 'running' | 'read' | 'unknown';
export type QueueSection = SessionStatus | 'snoozed';

export interface TerminalIdentity {
  pid: number;
  tty: string;
  startedAt: string;
}

/** Provider-owned observation. Never store transcript content here. */
export interface Session {
  id: string;
  provider: ProviderId;
  externalId: string;
  title: string;
  directory: string | null;
  status: SessionStatus;
  detail: string;
  updatedAt: number;
  createdAt?: number;
  /** Source-owned ancestry. Missing means unavailable; null means no recorded parent. */
  lineage?: { parentId: string | null };
  observedAt: number;
  evidence: 'live' | 'history' | 'unavailable';
  /** Stable result/request identity, not an observation timestamp. */
  attentionKey: string | null;
  /** Claude hooks can own the completion while the task keeps its desktop identity. */
  completionSource?: 'terminal';
  /** Actual turn activity, not a title edit, focus, or catalog refresh. */
  activityAt?: number;
  awaitingInput?: boolean;
  /** Source-owned flag. Codex-archived tasks are hidden throughout Monitor. */
  archived: boolean;
  /** Source-owned sidebar pin. Missing means the source does not expose it. */
  sourcePinned?: boolean;
  /** false when the source app has no exact-session route (e.g. a terminal session). */
  openable?: boolean;
  /** Native CLI session id; never a command string. */
  resumeId?: string | null;
  /** Live agent process in a terminal, for Show in iTerm. */
  terminalPid?: number | null;
  /** Codex process identity, checked again before focusing iTerm. */
  terminalIdentity?: TerminalIdentity | null;
  /** Codex CLI has exited and no active desktop turn is observed. */
  terminalResumeAllowed?: boolean;
}

export interface ProviderHealth {
  provider: ProviderId;
  state: 'connecting' | 'live' | 'degraded' | 'offline';
  message: string;
  lastObservedAt: number | null;
  /** Scope observation loss to these Monitor ids; omitted for a whole-provider disconnect. */
  disconnectedSessionIds?: string[];
}

