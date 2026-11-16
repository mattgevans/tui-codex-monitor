# Codex + Claude Terminal Monitor

A lightweight, read-only terminal dashboard for local Codex CLI and desktop sessions, Claude Code CLI sessions, and local Claude desktop Code-tab records. This includes local Codex sessions controlled through the ChatGPT iPhone app. Runs directly in Node with Blessed; it never starts Electron, a browser, an app-server, or an agent CLI.

## Run

Requires Node.js 24 or newer and local sessions from either provider. Codex desktop is needed for live Codex IPC state; Claude Code works independently of Codex.

```sh
cd ~/Repos/mattgevans/tui-codex-monitor
npm install
npm run tui
```

Every launch automatically discovers all supported providers and refreshes discovery every second. Run `npm run tui` to monitor Codex and Claude together. A missing Codex installation does not prevent Claude monitoring. Each provider retains its own health in JSON output; corrupt or unreadable sources still report degradation.

For a single JSON status snapshot, including session names, directories, runtime status,
connection health, and local read/archive flags:

```sh
npm run --silent tui -- --json
npm run --silent tui -- --json --duration=1000
npm run --silent tui -- --json --session 01a1b27b-e56e-7a12-9022-aed8796135c0
npm run --silent tui -- --json --session claude:00000000-0000-4000-8000-000000000001
```

JSON mode works without an interactive terminal, collects observations for 5 seconds
by default, prints one JSON object, and exits. `--duration` accepts 100–60000 ms.
Use npm's `--silent` option when piping stdout to a JSON parser so npm does not
print its script banner. The schema includes `schemaVersion`, `capturedAt`,
`health`, `counts`, and `sessions`. `health.providers` lists independent provider health.
Timestamps are Unix milliseconds. Session `id` values are native session IDs;
`provider` identifies `codex` or `claude`, and `monitorId` prefixes the native ID with that provider.
Locally archived sessions are included with
`archivedLocally: true`; status/attention/read counts exclude them. No transcripts,
prompts, responses, or tool arguments are included, and no local state is changed.
An unavailable desktop can still return session-log status with offline health;
catalog/protocol degradation produces a snapshot and exit code 1. Exit code 0
means the snapshot was collected, even when some statuses are `UNKNOWN`.
`--json` and `--probe` cannot be combined.
Use `--session ID` (or `--session=ID`) with `--json` to match an exact native or provider-prefixed session ID.
If both providers share a native ID, the native selector returns both; prefix it with `codex:` or `claude:` to select one.
The snapshot keeps the same schema, with `sessions` and counts limited to that
session. If the ID is not found, `sessions` is empty and the exit code is 1.

Use a terminal at least 80 columns wide and 24 rows high. Provider, session name, working directory, status, and activity appear in the list; the selected session's detail panel shows its directory and source status. Long paths in the list preserve their ending so repositories remain distinguishable.

| Key | Action |
| --- | --- |
| ↑ / ↓ or j / k | Select a session |
| r | Mark the selected attention item read locally; press again to undo |
| n | Show items needing attention |
| w | Show working sessions |
| d | Show items marked read locally |
| a | Show all sessions |
| x | Archive the selected session locally |
| v | Show locally archived sessions |
| u | Restore the selected archived session |
| / | Search provider, session name, directory, or ID |
| Esc | Clear search and return to all sessions |
| q / Ctrl-C | Quit |

## Status and attention

| Status | Evidence |
| --- | --- |
| `WORKING` | Active runtime/process or recent supported session-log activity |
| `WAITING` | Pending request, approval/input runtime state, or a recent Claude `AskUserQuestion` record |
| `IDLE` | Idle/not-loaded runtime or idle Claude process without a completed or failed latest turn |
| `DONE` | Completed/interrupted Codex turn or explicit Claude completion metadata |
| `ERROR` | System error, failed latest turn, or Claude API error metadata |
| `EXITED` | CLI session log has no owning Codex process (read-only `lsof` check) |
| `UNKNOWN` | No supported desktop state or usable session-log evidence |

`!` and amber highlight mean attention is needed: input/approval, an error, or an unread finished response. `▶` and blue identify working agents. `r` marks a locally acknowledged item. Labels and markers remain readable without relying on color alone.

Pressing **r** does not approve anything, send a message, set a provider read receipt, or change the actual `WAITING` status. It removes the current item from the attention view. A new request or turn returns to attention; observing work resume also clears the old acknowledgement. A temporary disconnect preserves acknowledgements. An item without a stable request/turn identity cannot be safely marked read.

Only provider-prefixed session IDs and attention identities are stored, in `~/.local/state/tui-codex-monitor/read.json` (or under `XDG_STATE_HOME`), with private file permissions. No prompts, responses, or tool arguments are persisted. Separate simultaneous dashboard instances should be avoided because they share this small acknowledgement file.

Press **x** to archive a session in this dashboard. Archived sessions are excluded from the normal views and their working/attention/read/unknown counts. Press **v** to view the archive and **u** to restore a session. This is a persistent local archive, stored as session IDs in `archive.json` beside `read.json`; it never changes a provider's archive flag or stops an agent. Archived sessions stay hidden through new activity until you restore them.

Activity uses the latest known turn start or observed runtime/request/turn-state change, with catalog update time as a labelled fallback. It is not a token-by-token activity clock. A periodic refresh does not count as activity.

## Integration and boundaries

The Codex integration and Claude catalog readers are reused from [agent-workstream-monitor](https://github.com/JustinTervala/monitor), inspected locally at `~/Documents/npm/monitor`. Codex integration:

- Read the highest `state_N.sqlite` in `CODEX_HOME` or `~/.codex`, using read-only SQLite and `query_only`.
- Discover all nonarchived local catalog sessions without a recency or count cutoff, refreshing every second. Monitor's catalog excludes spawned subagent entries.
- Follow the existing desktop IPC socket, using Monitor's original observer transport and reduced, transcript-free state projection. Changes update the dashboard immediately.
- Use registration, follow/unfollow, and discovery refusal only. Never take ownership, resume agents, answer approvals, or write to source databases or session files.
- Read local rollout event metadata as a fallback when a session has no desktop broadcast. No hooks, process control, or CLI launch is needed.
- Inspect Codex open files with `lsof` to identify exited CLI sessions by their exact rollout path. Desktop live state takes precedence. If process inspection fails, retain the log-based status; quiet logs alone do not prove exit.
- Omit Monitor's CLI hooks, GUI, summaries, and terminal-control features.

Local tasks created or continued from your iPhone use the same local desktop catalog/runtime. This cannot observe cloud-only tasks or sessions hosted on another machine. Desktop broadcasts take precedence. Without a broadcasting owner, the monitor reads the session’s local JSONL log for explicit `task_started`, `task_complete`, and `turn_aborted` events. This also covers CLI sessions whose catalog source is `vscode`. Completed or interrupted turns show `DONE` and can be acknowledged locally; active turns with recent log events show `WORKING`. The detail panel labels this evidence **Local session history**. No prompts, responses, or tool arguments are retained.

Log reads are bounded to a 1 MiB metadata prefix and 2 MiB tail and cached until the file changes. Missing, mismatched, unsupported, or insufficient logs remain `UNKNOWN`. Active log evidence expires after two minutes without events so a killed CLI does not remain working forever; a long silent operation can therefore temporarily show `UNKNOWN`. Logs do not reliably expose pending approvals or input requests, so `WAITING` still requires desktop runtime evidence. A catalog timestamp alone never establishes status.

This uses Codex's private desktop protocol, currently stream version 11 and read-receipt version 3. Unsupported versions, revision gaps, and disconnects invalidate affected runtime evidence; the observer reconnects/resynchronizes. Future desktop changes may require updating the vendored adapter.

## Claude Code integration

- Discover top-level UUID-named session logs in `~/.claude/projects/<project>/*.jsonl` (or under `CLAUDE_CONFIG_DIR`) every second. Nested subagent transcripts and sidechain events are excluded. The monitor does not call Claude or install hooks.
- Read live process metadata from `<config>/sessions/<pid>.json`, ignoring dead PIDs, unsupported statuses, and unrelated/headless registry entries. `busy`/`shell`, `waiting`, and `idle` map to working, waiting, and idle. Permission waits are distinguished from other input waits. Older Claude versions may not expose this registry.
- On macOS, also discover local desktop Code-tab records under `~/Library/Application Support/Claude/claude-code-sessions`. Set `CLAUDE_DESKTOP_DIR` to override this monitor's desktop store path. A desktop record linked to a CLI transcript appears once, under its desktop ID; source-archived records are excluded.
- Without live process state, use explicit transcript metadata: user/assistant activity, `AskUserQuestion`, assistant `end_turn`/`stop_sequence`, system `turn_duration`, and API error flags. Ordinary tool calls do not prove an approval wait. Log-only working/waiting evidence expires after two minutes; a silent long operation can become `UNKNOWN`. Historical completions remain `DONE`; absence of a registry entry does not prove exit.
- Read at most a 1 MiB prefix and 2 MiB tail per changed transcript, caching only metadata. Incomplete lines, mismatched session IDs, and unsupported evidence do not establish status. Titles use Claude's saved manual or AI-generated names when available, with manual names taking priority. Sessions without a saved name use directory/session-ID labels; prompt and response text are never used as titles.

Live registry state takes precedence over transcript history. Provider labels appear in the session list, and provider-prefixed IDs keep local read/archive flags separate. Cloud-only sessions, ordinary Claude chats, Cowork sessions, and sessions stored on another machine are outside this integration.

Claude's transcript, desktop, and process-registry formats are internal and may change. See [Claude Code's session storage documentation](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored). Unknown formats fall back to `UNKNOWN`; reliable approval visibility requires supported live process metadata.

## Validation

```sh
npm run check   # TypeScript and synthetic SQLite/IPC/UI tests
npm run smoke   # live desktop connection/status probe (5 seconds)
npm run probe -- --duration=15000
```

The probe prints connection health, counts, and live session IDs/statuses. It excludes titles, directories, and transcript content, exits nonzero if no live session is observed, and performs no session actions.

On 30 October 2026, a live read-only probe discovered 22 local sessions and initially received live state for four (one working and three finished). After the user identified the phone-driven **“Modernize the app design”** session, the observer received its live `WORKING` status and correct working directory, `/Users/mevans/Repos/Tessra-Labs/recipe-system-app`. Other desktop sessions became observable during continued testing. A real input/approval transition from the phone has not yet been observed; approval/input transitions, new-session discovery, acknowledgement persistence/reset, and reconnect/error behavior are tested using synthetic SQLite and IPC fixtures.

The terminal rendering test exercises name/directory display, attention/read/working filters, read/unread actions, and resizing from 120×32 to 80×24. It uses the real Blessed renderer with synthetic session data.

See [UPSTREAM.md](UPSTREAM.md) for source provenance and license details.
