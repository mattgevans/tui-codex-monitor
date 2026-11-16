import { openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import type { Projection } from './projection';

interface Observation { state: Projection; activityAt: number; active: boolean; terminal: boolean }
/** Bounded reads; cache status metadata only, never prompts, responses or tool arguments. */
export class RolloutReader {
  private cache = new Map<string, { signature: string; observation?: Observation }>();

  read(path: string, id: string, now = Date.now(), includeStale = false): Observation | undefined {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile()) return;
      const key = `${id}\0${path}`;
      const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      let cached = this.cache.get(key);
      if (cached?.signature !== signature) {
        const prefix = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
        readSync(fd, prefix, 0, prefix.length, 0);
        const end = prefix.indexOf(10);
        if (end < 0) return;
        const meta = JSON.parse(prefix.subarray(0, end).toString('utf8'));
        if (meta.type !== 'session_meta' || meta.payload?.id !== id) return;
        const offset = Math.max(0, stat.size - 2 * 1024 * 1024);
        const buffer = Buffer.alloc(stat.size - offset);
        readSync(fd, buffer, 0, buffer.length, offset);
        const lines = buffer.toString('utf8').split('\n');
        if (offset) lines.shift();
        lines.pop(); // Only complete JSONL records are evidence.
        let observation: Observation | undefined;
        for (const line of lines) {
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.type !== 'event_msg') continue;
          const p = event.payload;
          const at = Date.parse(event.timestamp);
          if (!Number.isFinite(at)) continue;
          if (['task_started', 'task_complete', 'turn_aborted'].includes(p?.type) && typeof p.turn_id === 'string') {
            const active = p.type === 'task_started';
            // Ignore late completion records from an older turn.
            if (!active && observation?.active && observation.state.turns?.[0]?.id !== p.turn_id) continue;
            observation = { active, activityAt: at, terminal: meta.payload?.originator === 'codex-tui', state: {
              threadRuntimeStatus: { type: active ? 'active' : 'idle' },
              turns: [{ id: p.turn_id, status: active ? 'inProgress' : p.type === 'turn_aborted' ? 'interrupted' : 'completed', turnStartedAtMs: at }],
            } };
          } else if (observation?.active) {
            // Token/tool activity keeps an explicitly started turn fresh.
            observation.activityAt = Math.max(observation.activityAt, at);
          }
        }
        cached = { signature, observation };
        this.cache.set(key, cached);
      }
      const result = cached.observation;
      // A killed CLI may never write a terminal event. Do not claim stale work is live.
      if (!includeStale && result?.active && now - result.activityAt > 120_000) return;
      return result;
    } catch {
      return;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  retain(paths: string[]) {
    const keep = new Set(paths);
    for (const key of this.cache.keys()) if (!keep.has(key)) this.cache.delete(key);
  }
}
