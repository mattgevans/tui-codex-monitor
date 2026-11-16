import { spawnSync } from 'node:child_process';

/** Exact open-file ownership, never cwd/title matching or process control. */
export function openRollouts(): Set<string> | undefined {
  const result = spawnSync('lsof', ['-nP', '-F', 'pn', '-c', 'codex'], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || (result.status !== 0 && result.status !== 1) || result.stderr.trim()) return;
  return new Set(result.stdout.split('\n').filter(line => line.startsWith('n/')).map(line => line.slice(1)));
}
