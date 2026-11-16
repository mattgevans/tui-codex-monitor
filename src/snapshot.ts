import { dirname, join } from 'node:path';
import type { SessionObserver } from './monitor-observer';
import { needsAttention, type Status } from './model';
import { ReadState } from './read-state';
import { ArchiveState } from './archive-state';

/** Capture metadata only; reading a snapshot never changes local acknowledgements. */
export function statusSnapshot(observer: Pick<SessionObserver, 'agents' | 'health'>,
  read = new ReadState(), archive = new ArchiveState(join(dirname(read.path), 'archive.json'))) {
  const sessions = observer.agents.map(agent => ({
    id: agent.externalId,
    monitorId: agent.id,
    provider: agent.provider,
    title: agent.title,
    directory: agent.directory,
    status: agent.runtime,
    evidence: agent.evidence,
    detail: agent.detail,
    awaitingInput: agent.awaitingInput ?? false,
    needsAttention: needsAttention(agent) && !read.isRead(agent),
    readLocally: read.isRead(agent),
    archivedLocally: archive.has(agent.id),
    activityAt: agent.activityAt ?? null,
    updatedAt: agent.updatedAt,
    observedAt: agent.observedAt,
  }));
  const visible = sessions.filter(session => !session.archivedLocally);
  const statuses: Status[] = ['WORKING', 'WAITING', 'IDLE', 'DONE', 'ERROR', 'EXITED', 'UNKNOWN'];
  return {
    schemaVersion: 1,
    capturedAt: Date.now(),
    health: { ...observer.health },
    counts: {
      total: sessions.length,
      visible: visible.length,
      archived: sessions.length - visible.length,
      needsAttention: visible.filter(session => session.needsAttention).length,
      read: visible.filter(session => session.readLocally).length,
      statuses: Object.fromEntries(statuses.map(status => [status, visible.filter(session => session.status === status).length])),
    },
    sessions,
  };
}
