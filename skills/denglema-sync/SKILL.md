---
name: denglema-sync
description: "Inspect, bind, upload, or force-refresh Denglema usage when the user asks about Denglema, uploads the latest snapshot, or uses Chinese triggers such as \u67e5\u770b\u8e6c\u4e86\u5417\u5feb\u7167, \u4e0a\u4f20\u8e6c\u4e86\u5417, \u7ed1\u5b9a\u8e6c\u4e86\u5417, or \u7acb\u5373\u540c\u6b65\u8e6c\u4e86\u5417."
---

# Denglema

Normal collection is automatic and local. Bundled lifecycle hooks refresh one latest snapshot at most once per hour while Codex is being used. Hooks do not upload.

Use the bundled Denglema MCP tools for user-facing actions. Do not shell out to the CLI for normal plugin use.

Never read or transmit prompt text, assistant messages, tool contents, source code, project names, model breakdowns, or full transcripts.

## View latest snapshot

When the user asks how much they have pedaled, whether a snapshot is ready, or asks to view the latest snapshot:

1. Call `denglema_latest_snapshot`.
2. Report the snapshot date, token total, observed time, and whether it is pending or already uploaded.
3. Do not upload unless the user asks.

If no snapshot exists yet, explain that a snapshot is generated automatically during Codex use, at most once per hour.

## Upload

When the user asks to upload Denglema:

1. Call `denglema_status`.
2. If bound, call `denglema_latest_snapshot`.
3. If a snapshot exists, call `denglema_upload_latest`.
4. Reply briefly with the snapshot date and uploaded token total.

Uploading the latest snapshot must not rescan local Codex logs.

If not bound, tell the user to open Denglema in Feishu, choose the bind-device action, and provide the one-time pairing code.

## Bind

When the user provides a pairing code:

1. Call `denglema_bind` with the supplied code.
2. Add a friendly installation name only when the user supplied one.
3. Do not upload automatically after binding. Tell the user whether a local snapshot is available and let them choose whether to upload it.

Never invent a pairing code, installation ID, user ID, or credential.

## Force refresh and sync

Only when the user explicitly asks to refresh immediately, force sync, or bypass the hourly snapshot interval, call `denglema_sync`.

- `dry_run=true`: force a fresh local snapshot and do not upload.
- `dry_run=false`: force a fresh local snapshot and upload it.

Do not use `denglema_sync` for ordinary upload requests.

## Privacy

The local snapshot contains only:

- leaderboard date
- observation timestamp
- cumulative Codex token total
- local timezone metadata

The upload contains only the first three fields. The MCP tools never return the installation token.
