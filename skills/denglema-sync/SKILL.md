---
name: denglema-sync
description: "Inspect, bind, upload, or force-refresh Denglema usage when the user asks about Denglema, uploads the latest snapshot, or uses Chinese triggers such as \u67e5\u770b\u8e6c\u4e86\u5417\u5feb\u7167, \u4e0a\u4f20\u8e6c\u4e86\u5417, \u7ed1\u5b9a\u8e6c\u4e86\u5417, or \u7acb\u5373\u540c\u6b65\u8e6c\u4e86\u5417."
---

# Denglema

Normal collection is automatic and local. The bundled local MCP runtime refreshes one latest snapshot at most once per hour while Codex is being used. Automatic collection never uploads.

Use the bundled Denglema MCP tools for user-facing actions. Do not shell out to the CLI for normal plugin use.

Never read or transmit prompt text, assistant messages, tool contents, source code, full project paths, thread names, or full transcripts. Denglema schema v2 may transmit model names and workspace basenames only as token aggregates.

## Version awareness

For every user-facing Denglema action, call `denglema_status` first. The status result includes `plugin.current_version`, `plugin.latest_version`, and `plugin.update_available`.

If `update_available=true`, append a brief update notice after completing the user's requested action. Give these commands in order:

1. `codex plugin marketplace upgrade denglema`
2. `codex plugin add denglema@denglema`

Do not claim an update exists when `update_check` is unavailable.

If `local_snapshot.schema_version=2` and `local_snapshot.breakdown_upload_pending=true`, explain briefly that the local snapshot already contains model/project aggregates but the richer v2 snapshot has not been uploaded yet. Do not upload automatically. If the user asks to upload, `denglema_upload_latest` must upload that v2 snapshot and its breakdowns.

## View latest snapshot

When the user asks how much they have pedaled, whether a snapshot is ready, or asks to view the latest snapshot:

1. Call `denglema_status`.
2. Call `denglema_latest_snapshot`.
3. Report the snapshot date, token total, observed time, and whether it is pending or already uploaded.
4. Do not upload unless the user asks.

If no snapshot exists yet, explain that the local plugin runtime generates one automatically during Codex use, at most once per hour.

## Upload

When the user asks to upload Denglema:

1. Call `denglema_status`.
2. If bound, call `denglema_latest_snapshot`.
3. If a snapshot exists, call `denglema_upload_latest`.
4. Reply briefly using only `uploaded_date` and `uploaded_total_tokens` from the upload tool result. Do not use token values from model/project breakdown rows as the uploaded total.

Uploading the latest snapshot must not rescan local Codex logs.

If not bound, tell the user to open the Denglema web page, choose the bind-new-device action, and provide a fresh one-time pairing code. Pairing codes expire after five minutes and are consumed after one successful bind. Each native Codex environment needs its own pairing code, but environments paired from the same Denglema web identity aggregate under the same leaderboard user.

## Bind

When the user provides a pairing code:

1. Call `denglema_bind` with the supplied code. Never infer success from the user's wording or from the presence of a pairing code.
2. Add a friendly installation name only when the user supplied one.
3. Treat the bind as successful only if the tool result explicitly contains `ok: true` and a non-empty `installation_id`. If the tool is unavailable, errors, or does not return an installation ID, say the binding did not complete.
4. After a successful bind, call `denglema_status` and verify that it reports `bound: true` with the same `installation_id`. If verification fails, report the mismatch instead of saying success.
5. The bind tool performs one fresh local collection and immediately uploads that snapshot. This is the only automatic upload in the onboarding flow.
6. Report the verified installation ID and the initial uploaded date/token total, or the upload failure while keeping the binding successful.

Never invent a pairing code, installation ID, user ID, credential, or binding success.

## Force refresh and sync

Only when the user explicitly asks to refresh immediately, force sync, or bypass the hourly snapshot interval, call `denglema_sync`.

- `dry_run=true`: force a fresh local snapshot and do not upload.
- `dry_run=false`: force a fresh local snapshot and upload it.

Do not use `denglema_sync` for ordinary upload requests.

## Privacy

The local snapshot contains:

- leaderboard date
- observation timestamp
- cumulative Codex token total
- local timezone metadata
- model-name token aggregates
- workspace-basename token aggregates

The upload excludes prompts, source code, full paths, thread names, assistant messages, tool contents, and full transcripts. The MCP tools never return the installation token.
