---
name: denglema-sync
description: "Bind this Codex installation to Denglema or upload today's Codex token usage when the user asks to sync, upload, test the Denglema collector, or uses the Chinese triggers \u8e6c\u4e00\u4e0b, \u540c\u6b65\u8e6c\u4e86\u5417, or \u7ed1\u5b9a\u8e6c\u4e86\u5417."
---

# Denglema Sync

Use the plugin's local collector. Never read or transmit prompt text, assistant messages, tool contents, source code, or full transcripts.

The default internal Denglema service is:

```text
http://10.21.5.77:1600
```

## Sync

When the user asks to sync, first inspect local binding state:

```bash
node "$PLUGIN_ROOT/src/cli.js" denglema status --json
```

If `bound` is true, run:

```bash
node "$PLUGIN_ROOT/src/cli.js" denglema sync
```

Reply briefly with the leaderboard date and uploaded token total.

If `bound` is false, tell the user to open Denglema in Feishu, choose the bind-device action, and provide the one-time pairing code. Do not ask the user to find or type the server URL.

## Bind

When the user provides a pairing code, bind this installation to the default internal service:

```bash
node "$PLUGIN_ROOT/src/cli.js" denglema bind --server "http://10.21.5.77:1600" --code "<pairing-code>"
```

Add `--name "<label>"` only when the user supplied a useful installation label.

After a successful bind, immediately run one normal sync unless the user explicitly asked not to upload yet.

## Offline test

When the user asks to test the collector, preview an upload, or the company service is unavailable, run:

```bash
node "$PLUGIN_ROOT/src/cli.js" denglema sync --dry-run
```

Dry run is valid even before pairing. It scans the current native Codex environment using the same daily fast-path and performs no network request.

## Privacy

The upload sample contains only:

- leaderboard date
- observation timestamp
- cumulative Codex token total for this installation

It does not upload prompts, code, transcript contents, project names, model breakdowns, or filesystem paths.
