# Monitor source provenance

The desktop integration comes from Justin Tervala's MIT-licensed [Monitor](https://github.com/JustinTervala/monitor), local checkout `/Users/mevans/Documents/npm/monitor`, commit `69b148a3b31350a6bb3546d3dabddf659d891e3b`.

Copied unchanged:

- `src/providers/codex/catalog.ts` → `src/upstream/codex/catalog.ts`
- `src/providers/codex/transport.ts` → `src/upstream/codex/transport.ts`
- `src/providers/codex/projection.ts` → `src/upstream/codex/projection.ts`
- `src/providers/lineage.ts` → `src/upstream/lineage.ts`

`src/shared/types.ts` retains the source session and health types, omitting the unused Electron renderer, grouping, and command interfaces. Source copyright and permission text are preserved in `LICENSE`.

`src/observer.ts` adapts the source provider's catalog/IPC reconciliation to this standalone terminal application. It follows every discovered desktop session, handles revisions, disconnects, and resynchronization, and excludes hook reads, process checks, response reads, and session-navigation operations. `src/model.ts` adds explicit terminal statuses and stable local acknowledgement identities. `src/read-state.ts` implements a separate metadata-only acknowledgement file. `src/ui.ts` uses Blessed for terminal rendering.

Monitor's original checkout is not modified and is not required at runtime. To update, compare the four vendored modules against upstream, retain the MIT license, review private-protocol changes, and run both fixture checks and a live probe.
