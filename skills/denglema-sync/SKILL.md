---
name: denglema-sync
description: Bind this Codex installation to Denglema or upload today's Codex token usage when the user asks to sync, upload, 蹬一下, 同步蹬了吗, 绑定蹬了吗, or test the Denglema collector.
---

# Denglema Sync

Use the plugin's local collector. Never read or transmit prompt text, assistant messages, tool contents, source code, or full transcripts.

The company Denglema service is normally:

```text
http://10.21.5.77:1600
```

## When the user asks to sync

First inspect local binding state:

```bash
node "$PLUGIN_ROOT/src/cli.js" denglema status --json
```

If `bound` is true, run:

```bash
node "$PLUGIN_ROOT/src/cli.js" denglema sync
```

Report the date and uploaded token total in one short sentence.

If `bound` is false, do not invent credentials or a user ID. Tell the user to open 「蹬了吗」 in Feishu, choose 「绑定设备」, and provide the pairing code. Do not ask them to locate the server URL.

## Bind from a pairing code

When the user supplies a pairing code, bind this installation to the default internal service:

```bash
node "$PLUGIN_ROOT/src/cli.js" denglema bind \
  --server "http://10.21.5.77:1600" \
  --code "<pairing-code>"
```

Add `--name "<label>"` only when the user supplied a useful installation label.

After a successful bind, immediately run one normal sync unless the user asked not to upload yet.

## Offline / local testing

When the user asks to test the collector, preview the upload, or the company service is unavailable, run:

```bash
node "$PLUGIN_ROOT/src/cli.js" denglema sync --dry-run
```

Dry run is valid even before pairing. It scans the current native Codex environment using the same daily fast-path and prints what would be uploaded, but performs no network request.

## Privacy

The upload sample contains only:

- leaderboard date
- observation timestamp
- cumulative Codex token total for this installation

It does not upload prompts, code, transcript contents, project names, model breakdowns, or filesystem paths.
