---
name: denglema-sync
description: "Connect, inspect, collect, upload, and configure consent-based automatic Denglema usage updates from Codex, Cursor, Claude Code, or another Agent Harness when the user asks about Denglema, binds an agent, changes upload behavior, or uses Chinese triggers such as 查看蹬了吗快照, 上传蹬了吗, 自动上传蹬了吗, 绑定蹬了吗, 接入蹬了吗, or 立即同步蹬了吗."
---

# Denglema

Denglema is **Agent Harness agnostic**.

The server does not care whether usage came from Codex, Cursor, Claude Code, or another harness. The current harness adapter is responsible for finding trustworthy usage data and producing the same Denglema schema v2 cumulative daily sample.

Do not infer support from a product name alone. If the current harness does not expose trustworthy cumulative token usage, say that this harness cannot be collected reliably yet rather than fabricating values.

Never read or transmit prompt text, assistant messages, tool contents, source code, full project paths, thread/chat names, or full transcripts.

## Adapter selection

Use the first available mode:

1. **Denglema MCP available** — use the bundled `denglema_*` tools. This is the preferred Codex adapter.
2. **No Denglema MCP** — use the current harness's native usage API, logs, state files, or other trustworthy local usage source and follow the HTTP contract below.

The protocol is the same in both modes:

```text
Harness usage source
      ↓
Harness Adapter
      ↓
Denglema schema v2
      ↓
Denglema Server
```

## Usage Contract

A schema v2 sample is cumulative for one installation and one local calendar date:

```json
{
  "schema_version": 2,
  "harness": "cursor",
  "date": "2026-09-29",
  "observed_at": "2026-09-29T07:00:00.000Z",
  "total_tokens": 123456,
  "models": [
    { "name": "gpt-5.6-sol", "total_tokens": 100000 }
  ],
  "projects": [
    { "name": "vimo-flow", "total_tokens": 80000 }
  ],
  "usage_limits": {
    "updated_at": "2026-09-29T07:00:00.000Z",
    "primary": {
      "used_percent": 82.5,
      "remaining_percent": 17.5,
      "window_minutes": 300,
      "resets_at": "2026-09-29T09:00:00.000Z"
    },
    "secondary": null
  }
}
```

Rules:

- `harness`: short lowercase identifier such as `codex`, `cursor`, or `claude-code`.
- `total_tokens`: current-date cumulative token total for this installation, not just the current chat/session.
- `models`: cumulative model-name token aggregates. Use `[]` if unavailable.
- `projects`: cumulative workspace **basename** token aggregates. Never upload full paths. Use `[]` if unavailable.
- `usage_limits`: optional. Include it only when the current harness exposes a trustworthy rate-limit source. Record used/remaining percentages, window duration, reset time, and observation time; never infer an absolute token quota.
- All token values must be non-negative integers.
- Do not guess missing model/project breakdowns or usage limits.

Canonical protocol reference:
`https://github.com/viviennebla/codex-sync-server/blob/main/docs/denglema-usage-contract.md`

## Connection state for non-MCP adapters

When MCP is unavailable, reuse a local connection if the harness environment already has one.

Recommended local state:

```text
~/.denglema/connection.json
```

It may contain:

```json
{
  "server": "https://vimo-dev-server.taila62aff.ts.net",
  "installation_id": "inst_...",
  "token": "opaque-token",
  "timezone": "Asia/Shanghai",
  "harness": "cursor"
}
```

If you create this file, restrict it to the current user when the environment allows it.

The installation token is secret. Never print it back to the user, place it in a prompt, commit it to a repository, or send it anywhere except the Denglema server.

## Bind

### MCP mode

When the user provides a pairing code:

1. Call `denglema_bind` with the supplied code.
2. Treat bind as successful only if the tool returns `ok: true` and a non-empty `installation_id`.
3. Call `denglema_status` and verify the same installation ID.
4. The Codex adapter performs one fresh collection and initial upload after binding.
5. Report the installation ID and initial uploaded date/token total. Never report the installation token.
6. If the user has not already chosen an auto-upload preference, ask one concise follow-up:
   `要自动更新蹬了吗吗？关闭 / 每 1 小时 / 每 3 小时（推荐） / 每 6 小时 / 每天`
7. Do **not** enable automatic upload until the user explicitly chooses a schedule.
8. After an explicit choice, call `denglema_auto_upload` with `off`, `1h`, `3h`, `6h`, or `1d`.

### Harness-native mode

When MCP is unavailable and the user provides a pairing code:

1. Identify the current harness name.
2. POST to:
   `<server>/api/installations/pair`
3. Body:
   `{"code":"...","installation_name":"<harness / environment name>"}`
4. Require a response containing `installation_id` and `token`.
5. Persist the server, installation ID, token, timezone, and harness locally.
6. Immediately collect one fresh schema v2 sample and upload it.
7. Report success only after the sample upload succeeds. Do not expose the token.

Never invent a pairing code, installation ID, user ID, credential, or binding success.

## View latest snapshot

### MCP mode

1. Call `denglema_status`.
2. Call `denglema_latest_snapshot`.
3. Report date, token total, observed time, and pending/uploaded state.
4. Do not upload unless the user asks.

### Harness-native mode

If the adapter maintains a local latest snapshot, read it. Otherwise collect a lightweight current cumulative sample from the harness-native usage source without uploading it.

Report the date, total tokens, harness, and observed time.

## Upload

When the user says `上传蹬了吗` or otherwise asks to upload:

### MCP mode

1. Call `denglema_status`.
2. If bound, call `denglema_latest_snapshot`.
3. If a snapshot exists, call `denglema_upload_latest`.
4. Reply briefly using only `uploaded_date` and `uploaded_total_tokens`.

Ordinary MCP upload must not rescan Codex logs.

### Harness-native mode

1. Read the local Denglema connection.
2. Reuse a recent local cumulative snapshot if the adapter maintains one; otherwise collect the current harness's cumulative usage once.
3. Produce schema v2 with the correct `harness`.
4. POST it to:
   `<server>/api/usage/sample`
5. Send the installation token only as:
   `Authorization: Bearer <token>`
6. Treat upload as successful only on a successful HTTP response.
7. Reply with only the sample date and total token count.

Do not silently switch to a different harness's data source.

## Automatic upload

Automatic upload is opt-in.

### MCP / Codex mode

When the user asks to enable, disable, or change automatic updates:

1. If no interval was supplied, ask for one choice: `关闭 / 1h / 3h / 6h / 1d`.
2. Only after the user explicitly chooses, call `denglema_auto_upload`.
3. Report the selected schedule briefly.
4. Do not reinterpret a vague statement such as "keep this updated" as permission to upload in the background.

The bundled Codex adapter keeps the existing local snapshot cadence and uploads pending data only when the selected interval is due while the Codex MCP process is running.

### Harness-native mode

Do not claim background scheduling unless the current harness has a real local scheduler or persistent process capable of enforcing the user's selected interval. Otherwise keep manual upload behavior and say that automatic scheduling is not implemented for that harness yet.

## Force refresh and sync

Only when the user explicitly asks to refresh immediately, force sync, or bypass a cached/latest snapshot:

- MCP mode: call `denglema_sync`.
  - `dry_run=true`: fresh local snapshot, no upload.
  - `dry_run=false`: fresh local snapshot and upload.
- Harness-native mode: explicitly reread the harness-native usage source, rebuild schema v2, and upload only if requested.

## Version awareness

Version awareness applies to the bundled Codex Plugin adapter.

For every user-facing action when `denglema_status` is available, call it first. If `plugin.update_available=true`, complete the user's requested action first, then append a brief update notice:

1. `codex plugin marketplace upgrade denglema`
2. `codex plugin add denglema@denglema`

Do not show Codex Plugin update instructions when operating through a non-Codex harness adapter.

## Privacy

Allowed upload fields:

- leaderboard date
- observation timestamp
- cumulative token total
- harness identifier
- model-name token aggregates
- workspace-basename token aggregates
- usage-limit percentages, window duration, reset time, and limit observation time

Never upload:

- prompts
- assistant messages
- source code
- tool input/output contents
- full filesystem paths
- chat/thread names
- transcripts
- installation credentials
