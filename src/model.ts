import type { Session } from './shared/types';
import { latestTurn, type Projection } from './upstream/codex/projection';

export type Status = 'WORKING' | 'WAITING' | 'IDLE' | 'DONE' | 'ERROR' | 'EXITED' | 'UNKNOWN';
export interface Agent extends Session { runtime: Status; attentionToken: string | null }

export function classify(state: Projection): Status {
  const runtime = state.threadRuntimeStatus;
  if (state.requests?.length || runtime?.activeFlags?.some(f =>
    f === 'waitingOnApproval' || f === 'waitingOnUserInput')) return 'WAITING';
  if (runtime?.type === 'systemError') return 'ERROR';
  if (runtime?.type === 'active') return 'WORKING';
  if (runtime?.type === 'idle' || runtime?.type === 'notLoaded') {
    const turn = latestTurn(state);
    if (turn?.status === 'failed') return 'ERROR';
    if (turn?.status === 'completed' || turn?.status === 'interrupted') return 'DONE';
    return 'IDLE';
  }
  return 'UNKNOWN';
}

export function attentionToken(session: Session, state: Projection): string | null {
  const status = classify(state);
  if (!['WAITING', 'DONE', 'ERROR'].includes(status)) return null;
  const turn = latestTurn(state);
  const identity = session.attentionKey || turn?.turnId || turn?.id;
  // No stable identity means we cannot safely silence future attention.
  return identity ? JSON.stringify([status, identity, turn?.turnId || turn?.id,
    (state.requests || []).map(r => [r.id, r.requestId, r.method]),
    [...(state.threadRuntimeStatus?.activeFlags || [])].sort()]) : null;
}

export function needsAttention(agent: Agent): boolean {
  return agent.runtime === 'WAITING' || agent.runtime === 'ERROR' ||
    (agent.runtime === 'DONE' && agent.status === 'review');
}

export function clean(value: string): string {
  // Source-controlled text must never emit terminal commands or blessed tags.
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/[{}]/g, '').trim();
}

export function age(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
