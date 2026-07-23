# Codex Usage Dashboard

本地 Codex + Claude Code 使用量仪表盘。它会直接读取本机的 JSONL 日志，汇总 token、请求次数、模型、项目、会话、费用估算、速率限制和 Skills/MCP 使用情况，并提供一个零依赖的 Web 页面查看结果。

![Dashboard Screenshot](public/screenshot.png)

## MVP Release

`v0.2.0-mvp` 是一个源码版 MVP release：Codex Usage Dashboard 已经覆盖 usage、cost、rate limits、sources、model / project / session breakdown，以及跨设备 usage snapshot 和 Skill Bundles 同步。当前仓库没有发布 npm 包或二进制安装包，推荐通过 Git tag 拉取源码运行。

## 适合做什么

- 查看今天和历史的 Codex / Claude Code token 消耗、请求次数和缓存命中情况。
- 按模型、项目、会话和运行环境拆分使用量。
- 查看 Codex 当前账号的 rate limit 状态、重置时间和最近会话 burn rate。
- 估算 API 等价费用，并支持按模型覆盖价格表。
- 管理本机、WSL、Claude Code、额外 Codex Home 等多个数据源。
- 通过中心服务器同步多台设备的快照，并在本地合并展示。
- 同步可移植的 Skills Markdown 源目录，比较本地、远端和已安装状态。

## 特性

- **零外部 npm 依赖**：运行时只依赖 Node.js 标准库。
- **双 Agent 数据源**：解析 Codex `sessions` / `archived_sessions` 和 Claude Code `projects` 下的 JSONL 日志。
- **多环境识别**：自动识别 Windows、macOS、Linux 和 Windows 上的 WSL Codex Home。
- **交互式 Web 仪表盘**：包含关键指标、趋势图、月度热力图、模型拆分、项目排行、会话排行、环境统计、Skills & MCP 统计。
- **快照缓存**：Web 服务会缓存最近快照，必要时自动刷新；也可以手动刷新。
- **多设备同步**：支持 push / pull 快照到一个兼容的 Dashboard Server，并在页面中合并远端设备数据。
- **Skills 同步**：支持注册 Skills 源目录、生成 bundle、推送/拉取远端 bundle，并为 Codex 生成安装提示词。
- **费用估算**：内置部分模型价格表，可在 `~/.codex-usage.json` 中覆盖或关闭。

## 快速开始

要求：

- Node.js `>= 20`
- 本机已有 Codex 或 Claude Code 日志

启动 Web 仪表盘：

```bash
node src/cli.js web
```

浏览器打开：

```text
http://127.0.0.1:34777
```

也可以指定端口和绑定地址：

```bash
node src/cli.js web --port 34777 --bind 127.0.0.1
```

## npm 脚本

```bash
npm test
npm start
npm run web
npm run snapshot
npm run cli
npm run push -- --server http://your-server:34777
npm run pull -- --server http://your-server:34777
npm run register -- --path /path/to/.codex --type codex --label work
```

## CLI 命令

| 命令 | 说明 |
| --- | --- |
| `node src/cli.js web [--port 34777] [--bind 127.0.0.1] [--no-wsl]` | 启动本地 Web 仪表盘 |
| `node src/cli.js snapshot [--since YYYYMMDD] [--until YYYYMMDD] [--state state/latest.json]` | 生成快照 JSON |
| `node src/cli.js cli [--since YYYYMMDD] [--until YYYYMMDD] [--no-wsl]` | 在终端打印文本摘要 |
| `node src/cli.js push --server <url> [--device <name>] [--token <token>]` | 把本机快照推送到同步服务器 |
| `node src/cli.js pull --server <url>` | 从同步服务器拉取其他设备快照 |
| `node src/cli.js register --path <dir> --type codex\|claude\|skills [--label <name>]` | 注册自定义数据目录或 Skills 源目录 |

常用筛选参数：

```bash
node src/cli.js web --since 20260701 --timezone Asia/Shanghai
node src/cli.js snapshot --until 20260717 --no-cost
```

## 数据来源

### Codex

默认读取：

- `${CODEX_HOME}/sessions`
- `${CODEX_HOME}/archived_sessions`
- `${CODEX_HOME}/session_index.jsonl`
- `${CODEX_HOME}/state_5.sqlite`

如果没有设置 `CODEX_HOME`，默认使用 `~/.codex`。在 Windows 上还会自动探测常见 WSL 发行版中的 `.codex` 目录，除非传入 `--no-wsl` 或设置：

```bash
CODEX_USAGE_INCLUDE_WSL=0
```

### Claude Code

默认读取：

- `${CLAUDE_CONFIG_DIR}/projects`
- `~/.claude/projects`
- `~/.config/claude/projects`

### 自定义目录

可以通过命令行注册目录：

```bash
node src/cli.js register --path /mnt/wsl/home/me/.codex --type codex --label "WSL Ubuntu"
node src/cli.js register --path ~/.claude --type claude --label "Claude Local"
node src/cli.js register --path ~/agent-skills --type skills --label "Shared Skills"
```

也可以在 Web 页面点击 **Sources** 管理数据源。

注册信息保存在：

```text
~/.codex-usage.json
```

## Web 页面

启动 `web` 后，本地服务会提供静态页面和 JSON API。主要页面能力包括：

- 顶部指标：今日 token、今日费用、缓存命中率、主速率限制。
- Rate Limits：从 `codex app-server --stdio` 读取当前 Codex 账号速率限制。
- Token Trend：最近使用趋势，可在总览和不同环境之间切换。
- Activity：月度热力图。
- Model Breakdown：按模型展示 token 和请求次数。
- Projects / Top Sessions：按工作区和会话查看消耗。
- Environments：查看不同设备、WSL 或运行环境的聚合情况。
- Skills & MCP：统计 Claude Skill 调用和 Codex 用户 MCP 工具调用。
- Sources：添加、移除和检查数据源。
- Sync：配置远端服务器，分别执行 Usage Data 同步和 Skill Bundles 同步。

## 快照与状态文件

默认写入：

```text
state/latest.json
```

多设备和同步状态会写入：

```text
state/<device-id>.json
state/sync.json
state/skills-bundle.json
state/imported-skills/
```

`state/latest.json` 是本机快照；`state/<device-id>.json` 是从远端拉取或服务器收到的其他设备快照。Web 页面读取本地快照后，会把远端设备快照合并成统一视图。

## 多设备同步

本仓库既可以作为本地仪表盘，也可以作为一个简单的同步服务器使用。服务器端开启 `DASHBOARD_TOKEN` 后，`POST /api/push` 需要 Bearer token。

### 服务器端

```bash
DASHBOARD_TOKEN=your-secret-token node src/cli.js web --bind 0.0.0.0 --port 34777
```

### 设备端推送

```bash
node src/cli.js push --server http://your-server:34777 --device laptop --token your-secret-token
```

也可以用环境变量传 token：

```bash
DASHBOARD_TOKEN=your-secret-token node src/cli.js push --server http://your-server:34777 --device laptop
```

### 设备端拉取

```bash
node src/cli.js pull --server http://your-server:34777
node src/cli.js web
```

合并策略：

- 同一天的 token、请求数、模型使用量会累加。
- 项目和会话按 token 排序保留 Top N。
- 远端模型费用会用当前本地价格表重新计算。
- 过期设备的“今日”数据不会混入今天的视图。
- 速率限制和活动会话等账号相关信息保留本机视角。

## Skills 同步

Usage Data 和 Skill Bundles 是独立同步通道：Usage Data 的 Push/Pull 只处理设备 usage snapshot，不包含 skill bundle 源文件；Skill Bundles 的 Push/Pull 只处理 skill source bundle。

注册一个 `skills` 类型目录后，Dashboard 会把该目录下可移植的 Markdown 文件视为技能源。规则：

- 递归扫描 `.md` 文件。
- 忽略 `AGENTS.md`、`README.md`、`CHANGELOG.md`、`LICENSE.md`、`SKILL_BUNDLE.md`、隐藏文件和下划线开头文件。
- 每个 Markdown 文件名对应一个 skill 名称。
- 完整 bundle 会保留目录结构，并忽略 `.git`、`node_modules`、`.DS_Store`。

注册技能源：

```bash
node src/cli.js register --path ~/agent-skills --type skills --label "Shared Skills"
```

在 Web 页面进入 **Sync -> Skill Bundles** 后，可以：

- 比较本地、远端和已安装的技能状态。
- 使用 `Push Local Bundle` 将完整本地 skill source bundle 推送到远端。
- 使用 `Pull Remote Bundle` 先读取完整远端 bundle、预览本地差异，再拉取到本地技能源目录。
- Pull 支持 `Overwrite` / `Merge`，两者执行前都会预览新增和覆盖项：`Merge` 只应用远端相对本地的新增/更新差异并保留本地额外文件；`Overwrite` 会让本地技能源目录匹配远端 bundle，因此还会预览并删除本地多出来的文件。
- 勾选列表项只用于 `Copy Install Prompt`，让 Codex 按 `SKILL_BUNDLE.md` 规则安装或更新选中的本地技能；已安装的技能也可以勾选生成 prompt。

### Skill / Plugin 同步设计草案

下一版同步 UI 不应该只在 pull 侧区分 `merge` / `overwrite`，否则 push 和 pull 的语义不对称。建议先按两个维度建模，再落 UI：

- **资源类型**：`Skill` 和 `Plugin` 分开选择、分开展示状态、分开执行同步。
- **同步方向**：`Push` 和 `Pull` 都应显式选择方向，不把方向隐藏在同一个按钮里。
- **应用策略**：Pull 已支持 `Merge` 和 `Overwrite`。`Merge` 表示只应用远端新增/更新差异并保留目标端额外文件；`Overwrite` 表示目标端目录应与远端 bundle 精确匹配。
- **确认边界**：Pull `Merge` 和 `Overwrite` 执行前都会展示将新增和覆盖的文件摘要；`Overwrite` 还会展示将删除的本地文件，并要求确认。
- **服务端能力**：远端 API 需要声明支持哪些资源类型和策略，前端只展示服务端明确支持的动作。
- **冲突处理**：当 skill/plugin 名称不同但功能重叠时，不能自动合并或覆盖，应在生成 prompt 或执行计划中报告冲突并等待人工选择。

## 费用估算

默认启用费用估算。内置价格表覆盖部分 OpenAI 和 DeepSeek 模型，并会把一些 Codex 产品模式暂按 GPT-5.5 价格估算。

可以在 `~/.codex-usage.json` 中覆盖价格：

```json
{
  "version": 1,
  "directories": [],
  "pricing": {
    "updated_at": "2026-07-17T00:00:00.000Z",
    "models": {
      "my-model": {
        "inputUSDPerMTok": 1,
        "cacheReadUSDPerMTok": 0.1,
        "cacheCreationUSDPerMTok": 1,
        "outputUSDPerMTok": 5
      }
    },
    "fallbacks": {
      "codex": "gpt-5.5"
    }
  }
}
```

关闭费用估算：

```bash
node src/cli.js web --no-cost
```

或在配置中设置：

```json
{
  "pricing": {
    "enabled": false
  }
}
```

## 配置参考

| 参数 / 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `--port` | `34777` | Web 服务端口 |
| `--bind` | `127.0.0.1` | Web 服务绑定地址 |
| `--since` | 无 | 起始日期，支持 `YYYYMMDD` 或可解析日期字符串 |
| `--until` | 无 | 截止日期，支持 `YYYYMMDD` 或可解析日期字符串 |
| `--timezone` | 系统时区 | 日聚合使用的时区 |
| `--state` | `state/latest.json` | 快照输出路径 |
| `--state-dir` | `state` | 设备快照和同步状态目录 |
| `--no-cost` | false | 禁用费用估算 |
| `--no-wsl` | false | 跳过 WSL Codex Home 自动探测 |
| `--token` | 无 | push 或 Web 同步操作使用的认证 token |
| `DASHBOARD_TOKEN` | 无 | Web 接收 push / skill bundle 时使用的 Bearer token |
| `CODEX_HOME` | `~/.codex` | Codex Home；可用系统路径分隔符注册多个 |
| `CLAUDE_CONFIG_DIR` | 自动探测 | Claude Code 配置根目录；可用 `,` 或 `;` 分隔多个 |
| `CODEX_USAGE_INCLUDE_WSL` | `1` | 设置为 `0` 可关闭 WSL 自动探测 |
| `CODEX_USAGE_CODEX_BIN` | `codex` | 读取 rate limit 时使用的 Codex 可执行文件 |

## 本地 API

常用端点：

| 端点 | 说明 |
| --- | --- |
| `GET /api/snapshot` | 返回当前本机快照与已拉取设备快照的合并摘要 |
| `POST /api/refresh` | 重新扫描本地日志并刷新快照 |
| `GET /api/details?section=projects\|sessions\|skills` | 延迟加载明细列表 |
| `GET /api/limits` | 快速刷新 Codex rate limit |
| `GET /api/sources` | 列出注册、自动发现和远端数据源 |
| `POST /api/sources` | 注册数据源 |
| `DELETE /api/sources?path=...&type=...` | 移除数据源 |
| `GET /api/devices` | 列出服务器保存的设备快照 |
| `POST /api/push` | 接收设备快照，启用 `DASHBOARD_TOKEN` 时需要认证 |
| `GET /api/snapshot/:deviceId` | 获取某个设备快照 |
| `POST /api/sync` | 从远端服务器拉取全部设备 |
| `POST /api/sync-status` | 比较本机和远端同步状态 |
| `POST /api/push-to-remote` | 从 Web 页面触发本机推送 |
| `GET /api/skills/local` | 扫描本地 Skills 源目录和 Agent 安装状态 |
| `POST /api/skills/compare` | 比较本地、远端、导入和已安装 Skills |
| `POST /api/skills/push` | 推送选中的 Skills bundle |
| `POST /api/skills/pull` | 拉取远端 Skills bundle |
| `POST /api/skills/install-prompt` | 生成 Codex 安装提示词 |

## 项目结构

```text
public/
  index.html       Web 页面
  app.js           前端渲染、图表、同步和 Sources 管理
  styles.css       样式
src/
  cli.js           CLI、Web 服务和 API 路由
  loader.js        加载 Codex + Claude 报告并统一聚合
  ccusage.js       Codex JSONL 解析器
  claude.js        Claude Code JSONL 解析器
  snapshot.js      快照结构和派生指标
  merge.js         多设备快照合并
  pricing.js       费用估算
  sources.js       数据源发现、注册和诊断
  sync.js          远端设备同步
  skills-sync.js   Skills bundle 扫描、比较、推送和拉取
  status.js        Codex rate limit 状态读取
  state.js         快照读写
test/
  *.test.js        Node 内置 test runner 测试
state/
  *.json           本地运行时生成的快照和同步状态
```

## 开发与验证

运行测试：

```bash
npm test
```

生成快照：

```bash
node src/cli.js snapshot
```

终端摘要：

```bash
node src/cli.js cli
```

检查帮助：

```bash
node src/cli.js --help
```

## 注意事项

- 仪表盘只解析本地日志，不会主动上传数据；只有执行 push 或在 Web 页面触发同步时才会访问远端服务器。
- 费用是按本地 token 日志和价格表推算的 API 等价估算，不等同于账单。
- Rate limit 读取依赖本机可用的 `codex app-server --stdio`，失败时仪表盘仍可展示日志统计。
- 如果 Codex 或 Claude 日志格式变化，解析器会尽量跳过无法识别的行，但可能需要更新代码和测试。
