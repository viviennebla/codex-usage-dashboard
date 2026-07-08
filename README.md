# Codex Usage Dashboard

本地 Codex + Claude Code 使用量监控仪表盘，支持多设备数据同步。

![Dashboard Screenshot](public/screenshot.png)

## 功能

- **Token 趋势图** — DeepSeek 风格柱状图（token）+ 折线图（API 请求数），hover 显示详细数值
- **月度热力图** — GitHub 风格日历热力图，按月切换，展示每日 token 消耗分布
- **模型分解** — 每个模型的 token 消耗 + API 调用次数双柱对比图
- **Skill 统计** — Claude Code 中各 skill 的调用频率排行
- **速率限制** — 带时间进度标记的用量条，直观展示消耗速度是否超前
- **多设备同步** — 通过中心服务器跨设备合并使用数据

## 快速开始

```bash
# 要求 Node.js >= 20，无需 npm install（零外部依赖）

# 启动本地仪表盘
node src/cli.js web --port 34777
```

浏览器打开 `http://127.0.0.1:34777`。

## CLI 命令

| 命令 | 说明 |
|------|------|
| `node src/cli.js web [--port 34777]` | 启动 Web 仪表盘 |
| `node src/cli.js snapshot [--since YYYYMMDD]` | 生成快照文件到 `state/latest.json` |
| `node src/cli.js cli [--since YYYYMMDD]` | 终端文本摘要 |
| `node src/cli.js push --server <url> [--token <token>]` | 推送本地快照到同步服务器 |
| `node src/cli.js pull --server <url>` | 从同步服务器拉取所有设备数据 |
| `node src/cli.js register --path <dir> --type codex\|claude` | 手动注册 agent 数据目录 |

## 多设备同步

### 架构

```
┌──────────────┐     push      ┌─────────────────┐     pull      ┌──────────────┐
│  设备 A       │ ───────────▶  │  Sync Server     │ ◀───────────  │  设备 B       │
│  (笔记本)     │               │  (ECS / VPS)     │               │  (台式机)     │
│  本地快照     │               │  存储所有设备快照  │               │  本地快照     │
└──────────────┘               └─────────────────┘               └──────────────┘
```

### 合并策略

当仪表盘加载时，会自动合并本地数据与从服务器拉取的设备数据：

- **按日期合并**：同一天的 token 求和，不同天追加
- **模型合并**：相同模型的 token 和 API 请求数累加
- **Skill 合并**：相同 skill 的调用次数和 token 累加
- **Session / Project 合并**：跨设备合并后按 token 量排序取 Top N
- **设备特有数据**（速率限制、活动会话等）保留本地值

### 合并流程详解

```
1. 设备 A 执行 push → 服务器存储 state/device-a.json
2. 设备 B 执行 pull → 下载 state/device-a.json 到本地 state/
3. 设备 B 打开仪表盘 → GET /api/snapshot 时：
   a. 加载本地 Codex + Claude 数据 → 生成本地快照
   b. 读取 state/ 下所有设备快照
   c. mergeSnapshots() 合并本地 + 设备 A 的快照
   d. 返回合并后的统一视图
```

### 部署同步服务器

参见配套仓库 `codex-sync-server`（零依赖 Node.js HTTP 服务）。

```bash
# 1. 在 VPS 上启动服务端
git clone <codex-sync-server>
cd codex-sync-server
DASHBOARD_TOKEN=your-secret-token node src/server.js

# 2. 在每台设备上推送本地数据
node src/cli.js push --server http://your-server:34777 --token your-secret-token

# 3. 在其他设备上拉取并查看合并数据
node src/cli.js pull --server http://your-server:34777
node src/cli.js web
```

在仪表盘页面也可以点击 **Sync**（自动拉取全部）或 **Config Sync**（选择设备、按时间戳确认）按钮手动触发同步。

## 手动注册 Agent 目录

如果 Codex 或 Claude Code 的数据存放在非默认位置（如 WSL 中），可以手动注册：

```bash
node src/cli.js register --path /mnt/wsl/.codex --type codex --label "WSL Ubuntu"
node src/cli.js register --path /mnt/wsl/home/user/.claude/projects --type claude --label "WSL Claude"
```

也可以在仪表盘页面点击 **Sources** 按钮进行图形化管理。

## 数据来源

- **Codex**：读取 `${CODEX_HOME}/sessions` 下的 JSONL 文件
- **Claude Code**：读取 `~/.claude/projects/` 和 `~/.config/claude/projects/` 下的 JSONL 文件
- 自动发现 + 手动注册的目录合并去重

## 配置

| 环境变量 / 参数 | 说明 | 默认值 |
|------|------|--------|
| `--port` | 仪表盘端口 | 34777 |
| `--bind` | 绑定地址 | 127.0.0.1 |
| `--since` | 起始日期 (YYYYMMDD) | 全部 |
| `--timezone` | 时区（如 `Asia/Shanghai`） | 系统时区 |
| `--token` | 推送认证 token | 无 |
| `DASHBOARD_TOKEN` | 服务端认证 token | 无（不开启认证） |
| `CODEX_HOME` | Codex 数据目录 | `~/.codex` |
| `CLAUDE_CONFIG_DIR` | Claude 配置目录 | `~/.claude` |

## 分享给他人

1. 将本仓库发送给对方
2. 对方只需安装 Node.js >= 20，无需 `npm install`
3. 如需同步功能，需要部署自己的 Sync Server 或共享同一个服务器地址和 token
4. 首次运行 `node src/cli.js web` 即可看到本地数据
