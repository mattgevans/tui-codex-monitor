# Monitor source provenance

The desktop integration comes from Justin Tervala's MIT-licensed [Monitor](https://github.com/JustinTervala/monitor), local checkout `/Users/mevans/Documents/npm/monitor`, commit `69b148a3b31350a6bb3546d3dabddf659d891e3b`.

Vendored Codex modules (with local catalog changes for rollout paths and optional-provider availability):

- `src/providers/codex/catalog.ts` → `src/upstream/codex/catalog.ts`
- `src/providers/codex/transport.ts` → `src/upstream/codex/transport.ts`
- `src/providers/codex/projection.ts` → `src/upstream/codex/projection.ts`
- `src/providers/lineage.ts` → `src/upstream/lineage.ts`

`src/shared/types.ts` retains the source session and health types, omitting the unused Electron renderer, grouping, and command interfaces. Source copyright and permission text are preserved in `LICENSE`.

`src/upstream/claude/catalog.ts` is adapted from `src/providers/claude/catalog.ts` at the same upstream commit. It retains the whitelisted desktop-record and live-process readers, omits the hook-file readers, validates PID ranges, and propagates registry access errors other than a missing directory. `src/upstream/claude/transcript.ts` and `src/claude-observer.ts` add bounded transcript status projection, CLI discovery, desktop/CLI deduplication, and status reconciliation for this terminal application. No upstream hooks, response readers, or navigation actions are included. `src/monitor-observer.ts` combines providers while retaining separate health and identities.

`src/observer.ts` adapts the source provider's catalog/IPC reconciliation to this standalone terminal application. It follows every discovered desktop session, handles revisions, disconnects, and resynchronization, and excludes hook reads, response reads, and session-navigation operations. Local Codex additions in `rollout.ts` and `processes.ts` read log metadata and inspect open-file ownership. `src/model.ts` adds explicit terminal statuses and stable local acknowledgement identities. `src/read-state.ts` implements a separate metadata-only acknowledgement file. `src/ui.ts` uses Blessed for terminal rendering.

Monitor's original checkout is not modified and is not required at runtime. To update, compare the vendored modules against upstream, retain the MIT license, review private-protocol and file-format changes, and run both fixture checks and a live probe. Claude fixture coverage includes live waits/work/idle, transcript completion/error/staleness, metadata-only reads, deduplication, source failure recovery, CLI filtering, and mixed-provider snapshots.
