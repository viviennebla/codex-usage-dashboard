# 蹬了吗 Agent 接入与 Codex Plugin

## 统一入口

公开入口：

```text
https://vimo-dev-server.taila62aff.ts.net/
```

蹬了吗服务端本身不依赖 Codex。Codex、Cursor、Claude Code 或其他 Agent Harness 只要能产出 Denglema schema v2 usage sample，都可以接入同一个 rider 和排行榜。

## 推荐接入方式

### Codex

Codex 使用本仓库自带的 portable Plugin / MCP adapter：

```bash
codex plugin marketplace add viviennebla/codex-usage-dashboard
codex plugin add denglema@denglema
```

网页点击「接入这个 Agent」后，Codex 用户可复制 WSL/macOS/Linux 或 Windows 一键命令。

一键命令自动完成：

```text
安装/更新 Plugin
→ pairing
→ 保存 installation credential
→ fresh collect
→ schema v2
→ 第一次上传
```

首次接入完成后，Codex 会询问是否允许自动更新。只有用户明确选择后才会启用，可选：

```text
关闭 / 每 1 小时 / 每 3 小时（推荐） / 每 6 小时 / 每天
```

也可以随时对 Codex 说：

```text
每 3 小时自动上传蹬了吗
关闭蹬了吗自动上传
上传蹬了吗
```

自动上传只在 Codex Plugin/MCP 运行期间生效；手动上传始终保留。

### Cursor / Claude Code / 其他 Agent

如果当前 harness 可以使用 Agent Skills，可以直接复用：

```text
skills/denglema-sync/SKILL.md
```

网页「接入这个 Agent」中选择「其他 Agent」，复制生成的 Agent Prompt 给当前 harness。

Agent Prompt 已经包含一次性 pairing code 和 Usage Contract。当前 Agent 需要：

1. 识别自己当前的 harness；
2. 使用该 harness 自己可信的 usage API / 日志 / 状态源；
3. 交换 installation token；
4. 在本机私有保存 connection；
5. 生成 schema v2；
6. 上传第一次快照。

以后仍然只需要说：

```text
上传蹬了吗
```

如果 harness 没有可信的累计 token 来源，Skill 必须明确说暂时无法可靠采集，不能猜数字。

## Denglema Usage Contract

协议是 harness-agnostic 的，Canonical 版本在：

<https://github.com/viviennebla/codex-sync-server/blob/main/docs/denglema-usage-contract.md>

核心 schema：

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
  ]
}
```

其中：

- `total_tokens` 是当前 installation 当天累计 token，不是当前会话 token；
- `harness` 例如 `codex`、`cursor`、`claude-code`；
- `projects[].name` 只允许 workspace basename；
- model/project 明细拿不到时传空数组，不猜测。

## 多设备 / 多 Agent

同一个网页 rider 可以绑定多个 installation：

```text
同一个蹬了吗 rider
├─ Windows Codex   → installation A
├─ WSL Codex       → installation B
├─ Cursor          → installation C
└─ Claude Code     → installation D
```

服务端按 rider 聚合，所以赛道仍然只显示一个人。

不同 harness 必须各自读取自己的 usage 数据源，不要跨 harness 重复扫描同一份日志。

## 日常使用

正常上传：

- 优先复用当前 adapter 的 latest snapshot；
- 没有 latest snapshot 的 harness 可以读取一次自己的原生 usage 数据；
- 生成当天累计 schema v2；
- 上传到同一个 Denglema server；
- 不上传 prompt、代码、完整路径、thread/chat 名、tool 内容或 transcript。

Codex Plugin 会在使用期间最多每小时维护一份本地 latest snapshot。自动上传默认关闭，用户可明确授权 `1h / 3h / 6h / 1d` 周期；到期时只上传 pending snapshot。普通 `上传蹬了吗` 不重新扫描 Codex JSONL。

通知策略：

- 自动上传已开启：不弹普通 pending snapshot 提醒；
- 自动上传关闭：每天最多提醒一次；
- 自动上传失败：发送失败提醒，本地 snapshot 保留并稍后重试。

## Plugin 包结构

Codex adapter 使用 portable Agent Plugins 布局：

```text
codex-usage-dashboard/
├─ plugin.json
├─ mcp.json
└─ skills/
   └─ denglema-sync/
      └─ SKILL.md
```

`.codex-plugin/plugin.json` 和 `.mcp.json` 不应重新加入。

## Codex Plugin 更新

版本检查只属于 Codex Plugin adapter。

检测到新版后：

```bash
codex plugin marketplace upgrade denglema
codex plugin add denglema@denglema
```

Cursor / Claude Code 等 harness 不应该收到 Codex Plugin 更新提示。

## 开发分支验证

Codex adapter 未合并到 `main` 时：

```bash
codex plugin marketplace add viviennebla/codex-usage-dashboard --ref <branch>
codex plugin add denglema@denglema
```

本地 marketplace 调试：

```bash
codex plugin marketplace add .
```
