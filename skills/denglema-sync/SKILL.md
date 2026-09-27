---
name: denglema-sync
description: "Bind this Codex installation to Denglema or sync today's Codex token usage when the user asks to sync, upload, test the Denglema collector, or uses the Chinese triggers \u8e6c\u4e00\u4e0b, \u540c\u6b65\u8e6c\u4e86\u5417, or \u7ed1\u5b9a\u8e6c\u4e86\u5417."
---

# Denglema Sync

Use the bundled Denglema MCP tools. Do not shell out to the CLI for normal plugin use.

Never read or transmit prompt text, assistant messages, tool contents, source code, project names, model breakdowns, or full transcripts.

## Sync

When the user asks to sync:

1. Call `denglema_status`.
2. If `bound` is true, call `denglema_sync` with `dry_run=false`.
3. Reply briefly with the leaderboard date and uploaded token total.

If `bound` is false, tell the user to open Denglema in Feishu, choose the bind-device action, and provide the one-time pairing code. Do not ask the user to find or type the server URL.

## Bind

When the user provides a pairing code:

1. Call `denglema_bind` with the supplied code.
2. Add a friendly installation name only when the user supplied one.
3. After a successful bind, immediately call `denglema_sync` with `dry_run=false` unless the user explicitly asked not to upload yet.

Never invent a pairing code, installation ID, user ID, or credential.

## Offline test

When the user asks to test the collector, preview an upload, or avoid network writes, call:

```text
denglema_sync(dry_run=true)
```

Dry run scans the current native Codex environment with the same daily fast-path and performs no upload.

## Privacy

The sync sample contains only:

- leaderboard date
- observation timestamp
- cumulative Codex token total for this installation

The MCP tools never return the installation token.
