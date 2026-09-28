# Denglema Plugin — Mac local test

This document is only for local repository development. For normal GitHub Marketplace installation, use `docs/denglema-plugin-install.md`.

The plugin can be installed and tested locally without the company Denglema server.

## Add the repo marketplace

```bash
git clone https://github.com/viviennebla/codex-usage-dashboard.git
cd codex-usage-dashboard
git checkout feat/denglema-plugin-upload
codex plugin marketplace add .
codex plugin marketplace list
```

Restart the ChatGPT desktop app after adding or refreshing a local marketplace. In the Plugins Directory, choose **蹬了吗** and install the plugin.

Codex also exposes installed plugins through `/plugins` on supported local clients. See the current OpenAI plugin documentation if the UI differs.

## Test without the company service

Ask Codex:

```text
测试同步蹬了吗
```

The skill runs:

```bash
node "$PLUGIN_ROOT/src/cli.js" denglema sync --dry-run
```

Dry run scans today's native Codex usage with the same fast-path used by real uploads and performs no HTTP request.

You can also inspect binding state:

```bash
node src/cli.js denglema status
node src/cli.js denglema status --json
```

## Real onboarding

1. Open 「蹬了吗」 in Feishu.
2. Choose 「绑定新设备」 and copy the pairing code.
3. Tell Codex: `绑定蹬了吗 <pairing-code>`.
4. The skill binds the current native Codex environment. Binding does not upload automatically.
5. To upload the latest local snapshot, say: `上传蹬了吗`.

The local config stores an opaque installation token. Status output never prints that token.
