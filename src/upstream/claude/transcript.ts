import { openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import type { Status } from '../../model';

export interface TranscriptState {
  directory: string | null;
  title: string | null;
  createdAt?: number;
  activityAt?: number;
  runtime: Status;
  identity: string | null;
}

/** Bounded, read-only transcript projection. Never retain message text or tool arguments. */
export class TranscriptReader {
  private cache = new Map<string, { signature: string; state?: TranscriptState }>();

  read(path: string, sessionId: string): TranscriptState | undefined {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile()) return;
      const key = `${sessionId}\0${path}`;
      const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      const cached = this.cache.get(key);
      if (cached?.signature === signature) return cached.state;
      const prefixSize = Math.min(stat.size, 1024 * 1024);
      const state: TranscriptState = { directory: null, title: null, runtime: 'UNKNOWN', identity: null };
      let matched = false;
      const scan = (offset: number, size: number, skipFirst: boolean) => {
        const buffer = Buffer.alloc(size);
        const bytes = readSync(fd!, buffer, 0, size, offset);
        const lines = buffer.subarray(0, bytes).toString('utf8').split('\n');
        if (skipFirst) lines.shift();
        lines.pop(); // An in-progress JSONL record is never evidence.
        for (const line of lines) {
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event?.sessionId !== sessionId || event.isSidechain === true) continue;
          matched = true;
          if (typeof event.cwd === 'string' && event.cwd.startsWith('/')) state.directory = event.cwd;
          if (event.type === 'custom-title' && typeof event.customTitle === 'string')
            state.title = event.customTitle.slice(0, 500);
          const at = Date.parse(event.timestamp);
          if (!Number.isFinite(at)) continue;
          state.createdAt = Math.min(state.createdAt ?? at, at);
          const identity = typeof event.uuid === 'string' ? event.uuid.slice(0, 200) : null;
          let runtime: Status | undefined;
          if (event.type === 'user' && event.isMeta !== true) runtime = 'WORKING';
          if (event.type === 'assistant') {
            const content = event.message?.content;
            const question = Array.isArray(content) && content.some((part: any) =>
              part?.type === 'tool_use' && part.name === 'AskUserQuestion');
            runtime = event.isApiErrorMessage === true ? 'ERROR' : question ? 'WAITING' :
              ['end_turn', 'stop_sequence'].includes(event.message?.stop_reason) ? 'DONE' : 'WORKING';
          }
          if (event.type === 'system' && event.subtype === 'turn_duration') runtime = 'DONE';
          if (runtime) {
            state.runtime = runtime;
            state.activityAt = at;
            state.identity = identity ?? (runtime === 'DONE' ? state.identity ?? `completed:${at}` : null);
          } else if (event.type === 'progress' && state.runtime === 'WORKING') {
            state.activityAt = Math.max(state.activityAt ?? 0, at);
          }
        }
      };
      scan(0, prefixSize, false);
      if (stat.size > prefixSize) {
        const offset = Math.max(0, stat.size - 2 * 1024 * 1024);
        state.runtime = 'UNKNOWN'; state.identity = null; state.activityAt = undefined;
        scan(offset, stat.size - offset, offset > 0);
      }
      const result = matched ? state : undefined;
      this.cache.set(key, { signature, state: result });
      return result;
    } catch { return; }
    finally { if (fd !== undefined) closeSync(fd); }
  }

  retain(paths: Set<string>) {
    for (const key of this.cache.keys()) if (!paths.has(key)) this.cache.delete(key);
  }
}
