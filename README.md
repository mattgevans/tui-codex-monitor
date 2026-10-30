# Codex Terminal Monitor

A lightweight, read-only terminal dashboard for local Codex desktop sessions, including local sessions controlled through the ChatGPT iPhone app. Runs directly in Node with Blessed; it never starts Electron, a browser, an app-server, or Codex CLI.

## Run

Requires Node.js 24 or newer and Codex desktop running on this Mac.

```sh
cd ~/Repos/mattgevans/tui-codex-monitor
npm install
npm run tui
```

Use a terminal at least 80 columns wide and 24 rows high. Session names, working directories, status, and activity appear in the list; the selected session's detail panel shows its directory and source status. Long paths in the list preserve their ending so repositories remain distinguishable.

| Key | Action |
| --- | --- |
| ↑ / ↓ or j / k | Select a session |
| r | Mark the selected attention item read locally; press again to undo |
| n | Show items needing attention |
| w | Show working sessions |
| d | Show items marked read locally |
| a | Show all sessions |
| / | Search session name, directory, or ID |
| Esc | Clear search and return to all sessions |
| q / Ctrl-C | Quit |

## Status and attention

| Status | Desktop evidence |
| --- | --- |
| `WORKING` | Active runtime with no input/approval request |
| `WAITING` | Pending request, waiting-on-approval, or waiting-on-user-input flag |
| `IDLE` | Idle/not-loaded runtime without a completed or failed latest turn |
| `DONE` | Latest turn completed or interrupted, runtime idle/not-loaded |
| `ERROR` | System error or failed latest turn, without active work |
| `UNKNOWN` | No current desktop state, disconnected owner, or unsupported protocol |

`!` and amber highlight mean attention is needed: input/approval, an error, or an unread finished response. `▶` and blue identify working agents. `r` marks a locally acknowledged item. Labels and markers remain readable without relying on color alone.

Pressing **r** does not approve anything, send a message, set a Codex read receipt, or change the actual `WAITING` status. It removes the current item from the attention view. A new request or turn returns to attention; observing work resume also clears the old acknowledgement. A temporary disconnect preserves acknowledgements. An item without a stable request/turn identity cannot be safely marked read.

Only session IDs and attention identities are stored, in `~/.local/state/tui-codex-monitor/read.json` (or under `XDG_STATE_HOME`), with private file permissions. No prompts, responses, or tool arguments are persisted. Separate simultaneous dashboard instances should be avoided because they share this small acknowledgement file.

Activity uses the latest known turn start or observed runtime/request/turn-state change, with catalog update time as a labelled fallback. It is not a token-by-token activity clock. A periodic refresh does not count as activity.

## Integration and boundaries

The integration is reused from [agent-workstream-monitor](https://github.com/JustinTervala/monitor), inspected locally at `~/Documents/npm/monitor`:

- Read the highest `state_N.sqlite` in `CODEX_HOME` or `~/.codex`, using read-only SQLite and `query_only`.
- Discover all nonarchived local catalog sessions without a recency or count cutoff, refreshing every second. Monitor's catalog excludes spawned subagent entries.
- Follow the existing desktop IPC socket, using Monitor's original observer transport and reduced, transcript-free state projection. Changes update the dashboard immediately.
- Use registration, follow/unfollow, and discovery refusal only. Never take ownership, resume agents, answer approvals, or write to source databases or session files.
- Omit Monitor's CLI hooks, process discovery, GUI, summaries, and terminal-control features.

Local tasks created or continued from your iPhone use the same local desktop catalog/runtime. This cannot observe cloud-only tasks or sessions hosted on another machine. The desktop must provide live state: historical or unloaded catalog entries that have no broadcasting owner remain `UNKNOWN`. A catalog timestamp cannot reliably establish whether an agent is working or waiting, so the dashboard does not guess.

This uses Codex's private desktop protocol, currently stream version 11 and read-receipt version 3. Unsupported versions, revision gaps, and disconnects invalidate affected runtime evidence; the observer reconnects/resynchronizes. Future desktop changes may require updating the vendored adapter.

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
