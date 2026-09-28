# 蹬了吗 Codex Plugin 安装与绑定

## 统一入口

公开分享入口：

```text
https://vimo-dev-server.taila62aff.ts.net/
```

公开地址现在直接进入蹬了吗赛道。第一次使用填写昵称和 emoji，并保存一次性展示的恢复码；换浏览器时用恢复码恢复同一个 rider，不依赖飞书或其他第三方登录。


## 从 GitHub Marketplace 安装

要求：Codex CLI 支持 `plugin marketplace`，并且本机已安装 Node.js 20 或更高版本。

```bash
codex plugin marketplace add viviennebla/codex-usage-dashboard
codex plugin add denglema@denglema
codex plugin list
```

安装完成后重新启动 Codex。首次启动时，如果当前 native Codex environment 尚未绑定，Plugin 会自动打开统一入口的绑定模式，并打开蹬了吗网页完成绑定。该提示只自动展示一次。Plugin 同时会在 Codex 使用期间自动维护一份本地 latest snapshot；最多每小时刷新一次，不会自动上传。

## 绑定当前 Codex 环境

1. 打开蹬了吗网页。
2. 点击「绑定新设备」，生成一次性 pairing code。
3. 在当前 Codex 中说：`绑定蹬了吗 <pairing-code>`。
4. Plugin 使用 pairing code 为当前 native Codex environment 创建独立 installation。
5. 首次绑定成功后会自动上传当前已有的 latest snapshot 一次，不重新扫描日志；后续手动上传时说：`上传蹬了吗`。

Pairing code 默认 5 分钟过期，并且成功使用一次后立即失效。

## 多设备 / 多环境

每个 native Codex environment 都是一个独立 installation，因此需要各自生成一个新的 pairing code：

```text
同一个蹬了吗网页身份
  ├─ Windows Codex  → pairing code A → installation A
  ├─ WSL Codex      → pairing code B → installation B
  └─ macOS Codex    → pairing code C → installation C
```

这些 installation 都绑定到同一个蹬了吗网页身份对应的 internal user ID，服务端按用户聚合 usage，所以排行榜仍然只显示一个人。

Windows Plugin 不扫描 WSL 的 Codex Home；WSL Plugin 也不扫描 Windows。这样可以避免重复统计。

## 日常使用

普通使用不需要手工扫描：

- Plugin runtime 在 Codex 使用期间最多每小时生成一份新的本地 snapshot；
- 只保留 latest snapshot；
- 新的 pending snapshot 可以触发本机通知；
- 不会自动上传；
- 用户明确说 `上传蹬了吗` 时，上传当前 latest snapshot，不重新扫描日志。

上传字段包括 leaderboard date、observation timestamp、cumulative token total，以及按 model 和 workspace basename 聚合的 token breakdown。不会上传 prompt、代码、完整项目路径、thread 名或完整对话。

## 开发分支验证

尚未合并到 `main` 时，可显式指定 Git ref：

```bash
codex plugin marketplace add viviennebla/codex-usage-dashboard --ref feat/denglema-plugin-upload
codex plugin add denglema@denglema
```

本地 marketplace 调试仍可使用：

```bash
codex plugin marketplace add .
```

本地 source 仅用于开发，不是同事的正式安装流程。
