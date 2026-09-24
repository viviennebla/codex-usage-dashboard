---
name: denglema-sync
description: Bind this Codex installation to Denglema or upload today's Codex token usage when the user asks to sync, upload, 蹬一下, or 同步蹬了吗.
---

# Denglema Sync

Use the plugin's local collector. Do not read or transmit prompt text, assistant messages, tool contents, source code, or full transcripts.

## Bind

When the user provides a Denglema server URL and one-time pairing code, run:

```bash
node "$PLUGIN_ROOT/src/cli.js" denglema bind --server "<server>" --code "<code>"
```

Add `--name "<label>"` only when the user supplied a useful installation label.

## Sync

When the user asks to upload or sync usage, run:

```bash
node "$PLUGIN_ROOT/src/cli.js" denglema sync
```

The sync command sends only this installation's cumulative Codex token count for today plus the observation timestamp. Repeating the command is safe and must not double-count usage.