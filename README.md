# Codex Usage Dashboard

Local usage monitor for Codex sessions. The first implementation was inspired by
`ccusage`, but the current data path reads native Codex JSONL logs directly.

## Run

```powershell
npm run cli -- --since 20260701
npm run web -- --port 34777
```

Open `http://127.0.0.1:34777`.

## Data Source

The parser scans:

- `${CODEX_HOME}/sessions`
- `${CODEX_HOME}/archived_sessions`
- `${CODEX_HOME}/session_index.jsonl`
- `${CODEX_HOME}/state_5.sqlite`
- `~/.codex/sessions` and `~/.codex/archived_sessions` when `CODEX_HOME` is not set
- WSL Codex homes such as
  `\\wsl.localhost\Ubuntu-26.04\home\<user>\.codex`

It consumes `token_count` events and aggregates:

- daily token usage
- session usage
- project usage from the logged `cwd`
- GUI thread names from `session_index.jsonl`
- CLI and exec thread names from the Codex app `threads` sqlite table
- fallback session names from the first logged user message when the GUI index
  has no entry
- latest primary and secondary Codex rate limits
- active session idle time
- 15-minute and 60-minute token burn rate

Projectless Codex GUI sessions often use generated directories under
`Documents/Codex/<date>/...`. Those rows are grouped by thread id and displayed
with the GUI thread name when it is available.

On Windows, WSL usage is included by default by probing common distro names such
as `Ubuntu-26.04` and `Ubuntu`. Set `CODEX_WSL_DISTROS=Name1,Name2` to add custom
distro names, or pass `--no-wsl` to skip WSL discovery for one run.

## Current Limits

Codex logs provide token counts and rate-limit samples, but not a complete local
pricing table. Costs are therefore shown as `N/A` until model pricing support is
added.

## Snapshot

```powershell
npm run snapshot -- --since 20260701
```

This writes `state/latest.json`, which is intended to be the stable data contract
between the collector, CLI, and web dashboard.
