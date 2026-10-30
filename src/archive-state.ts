import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Dashboard-only visibility, independent of Codex's source archive flag. */
export class ArchiveState {
  private ids = new Set<string>();
  constructor(readonly path: string) {
    try {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(value) || !value.every(id => typeof id === 'string'))
        throw new Error('Expected an array of session IDs');
      this.ids = new Set(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(`Cannot load local archive at ${path}: ${String(error)}`);
    }
  }
  has(id: string) { return this.ids.has(id); }
  set(id: string, archived: boolean) {
    const next = new Set(this.ids);
    if (archived) next.add(id); else next.delete(id);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify([...next], null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
    this.ids = next;
  }
}
