[Reading 564 lines from start (total: 564 lines, 0 remaining)]

# 蹬了吗 v0.1 技术方案

> 状态：Draft  
> 日期：2026-09-24  
> 目标仓库：`codex-usage-dashboard` + `codex-sync-server`

## 1. 产品定位

「蹬了吗」不是 Codex 管理平台，也不是绩效系统，而是部署在公司内网的团队 vibe coding 观战页。

核心体验：
- 同事摸鱼时打开网页，看今天谁“蹬”得最多、谁当前蹬得最快。
- 页面中央用飞书头像作为骑手头像，小人骑着冒火自行车向前冲。
- 留言以轻量弹幕形式从网页上方飘过，本质是留言板，不要求实时聊天。
- 飞书只承担身份映射、头像和登录体验，不做机器人播报。
- 不采集 prompt、代码内容或对话正文。

v0.1 的产品优先级明确为：
1. 飞书身份与头像。
2. Token 总量与稳定的多 installation 聚合。
3. 骑手动画和榜单。
4. 留言弹幕。
5. 蹬速仅在采样频率足够时作为派生展示；模型分类、项目聚合不阻塞首版。
## 2. 现有代码基础

`codex-usage-dashboard` 已经具备本地 Codex / Claude 日志解析能力，并能生成 snapshot。

当前 snapshot 已包含 `today`、`seven_days`、模型、项目、session 和 burn-rate 等信息。

但「蹬了吗」v0.1 不依赖现有 `tokens_15m` / `tokens_60m` 作为准确统计口径。它们来自本地日志窗口和 session 视角，适合个人 dashboard 观察，不适合作为团队榜单的权威实时速度。

Plugin 的稳定基础口径只采用：
- 当前 installation 当天累计 token。
- 样本观测时间。
- installation 身份。

现有 `merge.js` 可以合并多设备 snapshot，但当前聚合主键是 device，而不是 user。

`codex-sync-server` 当前提供：
- `POST /api/push`
- `GET /api/devices`
- `GET /api/snapshot/:deviceId`
- 文件型 device snapshot 持久化

这些能力可以保留兼容，但「蹬了吗」不应继续以完整 snapshot 上传作为主要多人采集协议。
## 3. 核心架构调整

新的数据链路建议为：

```text
Codex
  │
  │ lifecycle hook
  ▼
Denglema Plugin
  │
  │ usage delta
  ▼
codex-sync-server
  ├── Feishu identity
  ├── pairing / installation token
  ├── usage ingestion
  ├── leaderboard projection
  ├── messages
  └── web frontend
          │
          ▼
      蹬了吗首页
```

关键变化：
- “人”成为榜单主体，device 只作为一个人的 installation。
- 本地不再要求启动常驻 Web/client 进程。
- Plugin 只上传 installation 当天累计 token sample，不上传完整 Codex JSONL 或完整 dashboard snapshot。
- 服务端根据 installation token 得到 user，不允许客户端自行声明榜单身份。
## 4. 飞书身份设计

### 4.1 为什么飞书是首要能力

飞书不是可选登录方式，而是产品体验的一部分：
- 同事无需注册新账号。
- 直接显示飞书头像；展示名继续使用现有用户体系。
- 头像骑自行车能产生更强的团队代入感。
- 公司已开放飞书应用能力，适合做内部应用。

### 4.2 登录流程

```text
Browser
  │ 打开内网页面
  ▼
Denglema Server
  │ 未登录
  ▼
Feishu OAuth
  │ authorization code
  ▼
Denglema Server
  │ 换取用户身份
  │ 获取 Feishu ID / avatar，并映射到内部 user_id
  ▼
Session Cookie
```

服务端身份模型保持内部用户 ID 为权威主键：
- `user_id`：现有系统内部用户 ID，也是榜单聚合主键。
- `feishu_id`：只用于把飞书身份映射到 `user_id`。
- `avatar_url`：飞书头像来源。
- `last_login_at`：身份刷新时间。

Plugin pairing 最终绑定 `user_id`。Plugin 不需要知道、保存或上传 `feishu_id`；飞书也不作为业务主键。昵称等展示字段可以继续由现有用户资料体系提供，v0.1 不要求从飞书同步更多资料。

头像 URL 在登录时刷新；若后续发现 URL 有有效期或内网访问问题，再增加头像代理/缓存。
### 4.3 飞书接入待验证项

实施前需要在公司飞书开发者后台确认：
- Web 应用 OAuth redirect URI 的内网域名 / HTTPS 约束。
- 获取基础用户信息和头像所需最小权限。
- 内网服务器是否允许出站访问飞书开放平台 API。
- 应用可见范围是否覆盖预期同事。

原则：
- 只申请基础身份权限。
- 不读取聊天、通讯录扩展信息或其他与「蹬了吗」无关的数据。
- 飞书机器人能力暂不启用。

## 5. Codex Plugin 采集设计

### 5.1 目标

同事安装一次 plugin 后，不需要：
- 常驻运行 `codex-usage-dashboard web`
- 手动 push JSON
- 定时启动额外客户端

Plugin 本地 hook 负责在 Codex 生命周期节点执行轻量同步。
### 5.2 可行性

当前 Codex plugin 支持随包分发 lifecycle hooks。

适合本项目的 hook：
- `Stop`：每个主线程 turn 结束时触发，可用于周期性刷新 usage。
- `SessionEnd`：会话真正结束时触发，用于最终 reconcile。

Hook 输入包含：
- `session_id`
- `transcript_path`
- `cwd`
- `model`
- Stop 额外包含 `turn_id`

注意：
- Codex 官方明确说明 transcript 格式不是稳定接口。
- 因此不能把“解析 transcript 私有结构”作为唯一长期协议。
- 首版可复用当前 dashboard 已有 Codex JSONL 解析逻辑，但应隔离在 usage collector 模块中。
### 5.3 推荐执行策略

v0.1 先不把 hook 作为上传主路径。Plugin 提供一个统一的 `sync` 动作：

```text
用户手动同步 / 后续节流自动触发
  │
  ├─ 增量扫描 Codex usage 数据
  ├─ 得到本 installation 今日累计 token
  └─ PUT/POST usage sample
```

默认先支持手动同步，例如“同步蹬了吗”或 CLI 命令；后续可增加 5~10 分钟级别的无感节流触发，但仍复用完全相同的累计 sample 协议。

`Stop` 是 turn 结束，不是 session 结束；它可以作为未来的本地触发信号，但不等于每个 turn 都发 HTTP。`SessionEnd` 也不作为 v0.1 的可靠上传边界。

本地状态写入 plugin 的 writable data 目录：
- installation config
- parser cursor
- pending retry queue
- last successful upload timestamp

不需要 daemon。
### 5.4 Collector 代码复用

首版不建议重写 token 解析器。

建议把 `codex-usage-dashboard` 中和 UI 无关的解析能力整理为可复用 collector：
- Codex log discovery
- incremental file cache / cursor
- token event extraction
- session deduplication

Plugin 中只保留：
- hook 入口
- collector 调用
- delta 生成
- HTTP upload
- retry queue

后续如果边界稳定，再把 collector 抽成独立 package；v0.1 不为了“架构漂亮”提前拆第三个仓库。

## 6. 飞书账号与本地 Plugin 绑定

Plugin 初次安装时不知道当前使用者是谁，因此需要一次性 pairing。
推荐流程：

```text
1. 用户打开蹬了吗网页
2. 飞书登录
3. 点击「绑定我的 Codex」
4. Server 生成 5 分钟有效 pairing code
5. 页面显示一条复制命令
6. 用户在本地执行 plugin bind
7. Plugin 用 pairing code 换 installation token
8. Server 将 installation 绑定到当前 Feishu user
```

示例：
```bash
node "${PLUGIN_ROOT}/scripts/bind.mjs" ABCD-EFGH
```

实际安装体验可继续优化为 Codex 内的 setup skill，但服务端协议仍保持 pairing code，不把飞书凭据交给本地 plugin。

installation token：
- 每个安装实例独立。
- 服务端只保存 token hash。
- 可在网页撤销某个 installation。
- token 只允许上报该用户 usage，不允许指定其他 user_id。
## 7. Usage 上传协议

v0.1 不上传完整 snapshot，也不要求客户端生成 token delta；上传的是 installation 当天的累计 sample。

建议：
```json
{
  "schema_version": 1,
  "date": "2026-09-24",
  "observed_at": "2026-09-24T06:00:00Z",
  "total_tokens": 482310
}
```

可选字段：
- `model`
- `project_name`

这两个字段 v0.1 可以采集但不作为核心页面依赖。

明确禁止上传：
- prompt
- assistant message
- tool input/output
- source code
- 完整 transcript
- 完整本地路径
### 7.1 幂等、多设备与离线

累计 sample 天然适合幂等：同一个 installation、同一天只以最新累计值为准，重复上传同一个 `total_tokens` 不会重复计数。

服务端聚合规则：
- 每个 installation 独立保存当天最新累计值。
- 一个 `user_id` 可以绑定多个 installation。
- 用户今日总量 = 该用户所有 installation 当天最新累计值之和。
- 同一共享服务器上的不同 Unix 用户分别绑定自己的 installation，不使用 hostname 作为用户身份。
- 新 sample 若累计值小于已有值，默认视为日志重置/数据源变化，不产生负 delta，并记录诊断信息。

内网服务器不可达时，手动同步直接报告失败；后续自动同步阶段再增加轻量 retry/pending 状态。

### 7.2 为什么用累计 sample 而不是 snapshot / delta event

优点：
- Payload 很小。
- 不暴露本机完整统计数据结构。
- 重复同步天然幂等。
- 一天手动上传一次和未来高频自动上传使用同一个协议。
- 多 installation 可以稳定汇总到同一个 `user_id`。

蹬速不作为客户端上传字段。服务端只有在同一 installation 存在两个时间间隔足够短的累计样本时，才计算 `delta_tokens / delta_time`；采样过稀时返回 `null`，不伪造 15m/60m 实时速度。
## 8. 服务端领域模型

v0.1 最小模型：

```text
User
  id                  # 内部 user_id，权威聚合主键
  feishu_id           # 外部身份映射
  avatar_url          # 飞书头像

Installation
  id
  user_id
  token_hash
  name
  created_at
  last_seen_at
  revoked_at

UsageSample
  installation_id
  user_id
  date
  observed_at
  total_tokens

Message
  id
  user_id
  content
  created_at
  is_visible
```

模型和项目字段可以保留为 nullable 扩展，不进入首版核心模型。
## 9. 榜单与骑手状态

首页只需要服务端输出一个 rider projection：

```json
{
  "user_id": "u_123",
  "avatar_url": "...",
  "today_tokens": 4210000,
  "recent_rate_tpm": 34667,
  "rate_observed_at": "...",
  "state": "riding"
}
```

`recent_rate_tpm` 可以为 `null`。它不是固定 15/60 分钟统计，而是由足够接近的连续 sample 派生。

推荐状态：
- `idle`：没有可用近期速度或最新样本已明显过期。
- `riding`：存在可信的近期 sample delta。
- `fast` / `burning`：后续根据近期 sample rate 的相对阈值决定，仅影响视觉。

不要把 token 数直接映射为无限线性速度。
建议：
- 今日累计 token 决定赛道“进度/排名”。
- 有可信 `recent_rate_tpm` 时才驱动蹬腿频率、轮子速度和火焰等级。
- 没有速度数据时仍展示骑手和排名，但不假装正在高速骑行。
- 页面每 10~20 秒轮询即可，不需要 WebSocket。
## 10. Web 首页

首屏优先是“赛场”，不是 BI Dashboard。

建议结构：
```text
┌──────────────────────────────────────────┐
│ 蹬了吗     今日团队已蹬 xxM    n 人在蹬 │
├──────────────────────────────────────────┤
│          留言从顶部缓慢飘过              │
│                                          │
│  👤🚴─────────────                       │
│       👤🔥🚴────────────────             │
│    👤🚴────────                          │
│                                          │
├──────────────────────┬───────────────────┤
│ 今日蹬王             │ 当前蹬速          │
│ 1 ...                │ 1 ...             │
└──────────────────────┴───────────────────┘
```

动画实现优先考虑 DOM/SVG + CSS transform：
- 头像来自飞书。
- 自行车与身体使用统一矢量素材。
- 派生的 recent rate 只改变动画参数，不改变累计排名数据。
- 排名变化做平滑超车，而不是瞬移。
## 11. 留言弹幕

弹幕不是聊天室，不需要 WebSocket。

流程：
- 飞书登录用户在网页提交一句留言。
- Server 保存 Message。
- 页面每 30~60 秒获取最近留言。
- 展示层从页面顶部按节奏随机/按时间飘过。
- 同屏限制数量，避免挡住骑手。

API：
- `GET /api/messages?limit=50`
- `POST /api/messages`
- 可选：管理员隐藏留言。

留言显示飞书头像与现有用户展示名，增强“同事路过赛场留句话”的感觉。

## 12. API 草案

身份：
- `GET /auth/feishu/start`
- `GET /auth/feishu/callback`
- `POST /api/pairing-codes`
- `POST /api/installations/pair`
- `DELETE /api/installations/:id`
采集：
- `POST /api/usage/sample`

页面：
- `GET /api/riders`
- `GET /api/leaderboard?period=today`
- `GET /api/leaderboard?period=week`
- `GET /api/messages`
- `POST /api/messages`

兼容接口：
- 现有 `POST /api/push`、device snapshot API 暂不删除。
- 个人 dashboard 仍可继续使用旧同步链路。
- 团队「蹬了吗」优先使用新的 usage ingestion。

## 13. 持久化策略

v0.1 不强制引入数据库。

可以继续保持零依赖服务端，新增 persistence adapter：
- users / installations：JSON 状态文件。
- usage：按日期 append-only JSONL。
- message：append-only JSONL。
- event_id 去重：当天内存 Set + 持久化索引/重放恢复。

当使用人数、历史查询或并发明显增加后再切 SQLite/Postgres。
业务层不要直接依赖文件路径，避免后续迁移困难。
## 14. 安全与隐私

即使是公司内网，也不要依赖“内网天然可信”。

必须满足：
- 飞书身份由服务端 OAuth 得到，不能由前端声明。
- usage ingestion 使用 installation token。
- installation token 不等于网页登录 session。
- token 可撤销，并只允许写 usage。
- 留言必须由网页登录 session 提交。
- 不接受客户端传入 display_name/avatar 作为权威身份。
- 不上传 prompt、代码、tool 内容或完整路径。
- 页面明确标注：Just for fun，不用于绩效评估。

## 15. v0.1 实施阶段

### Phase A：身份与采集 PoC
- 飞书 OAuth 登录。
- 获取 Feishu ID 与头像，并映射到内部 `user_id`。
- pairing code。
- 最小 Codex plugin。
- Plugin 手动 `sync` 上传 installation 当天累计 sample。
- 服务端能按 `user_id` 聚合多个 installation 的当天累计值。

停止条件：两台不同设备、两个飞书身份可以稳定绑定到各自内部 `user_id`；同一个用户的多个 installation 能正确求和且重复同步不重复计数。

### Phase B：赛场首页
- rider projection API。
- 飞书头像骑手。
- 今日累计排名。
- 有足够采样密度时使用 `recent_rate_tpm` 驱动动画；否则仅展示累计排名。
- 火焰等级。
- 10~20 秒轮询。

停止条件：真实使用 Codex 时，页面能明显看到骑手加速和排名变化。

### Phase C：留言弹幕
- 留言 API。
- 飞书身份提交。
- 顶部飘过展示。
- 基础隐藏/删除能力。

### Phase D：兼容与打磨
- plugin 离线 retry。
- event 幂等。
- installation 撤销。
- Windows / WSL / Linux 安装验证。
- README 安装流程。

## 16. 暂不进入 v0.1

- 飞书机器人群播报。
- WebSocket 实时聊天。
- 复杂成就系统。
- 复杂项目排行榜。
- 模型使用偏好分析。
- 成本管理。
- 绩效/效率评分。
- 团队管理后台。
- 为了数据层提前拆分多个新仓库。

## 17. 仓库策略

本项目继续使用 GitHub。

理由：
- 当前两个仓库已经公开托管在 GitHub。
- 「蹬了吗」是个人/开源 vibe coding 项目，不依赖公司 GitLab 的发布流水线。
- Codex plugin 后续也更适合通过 GitHub 分发、安装和协作。
- 公司内部只部署 server instance 和配置 Feishu app，不需要把源代码迁入公司 GitLab。

建议暂时维持：
- `viviennebla/codex-usage-dashboard`：collector、个人 dashboard、Denglema plugin。
- `viviennebla/codex-sync-server`：身份、usage ingestion、排行榜、留言和团队 Web。

## 18. 当前建议的第一步

先做一个很薄的 vertical slice，不先做完整骑车视觉：

1. Server 接 Feishu OAuth，网页能显示“你好 + 飞书头像”。
2. Server 实现 pairing code 和 `POST /api/usage/sample`。
3. Dashboard repo 内新增 Plugin：`bind` 一次绑定，`sync` 可重复上传当天累计 usage；自动 hook deferred。
4. 首页先显示两个带飞书头像的 rider card：
   - today tokens
   - 可选 recent rate（采样不足时为空）
5. 确认真实数据链路稳定后，再开始自行车赛道动画。

这个顺序能优先验证本项目最大的不确定性：
**飞书身份 ↔ 本地 Codex plugin ↔ server user 聚合是否能丝滑打通。**

## 19. 外部能力依据

- OpenAI Agent Plugins 当前支持 skills、MCP server 和 lifecycle hooks；v0.1 仅使用 Plugin + Skill/本地脚本，MCP 与自动 hook 均 deferred。
- Plugin-bundled hooks 安装后需要用户审查并信任才会执行。
- Codex hook 的公共输入包含 session_id、transcript_path、cwd、model。
- Stop 在主线程 turn 结束时触发；SessionEnd 在线程真正结束时触发。
- transcript_path 可用于 hook 读取会话记录，但官方明确提示 transcript 格式不是稳定接口，因此 collector 必须隔离。
- 飞书 Web 登录、用户身份和头像能力在实施时以公司应用后台实际可申请权限为准。

## 20. Plugin 上传性能基线

2026-09-24 使用真实高强度 Codex Home 做了扫描基准。

压力样本：
- 507 个 JSONL。
- 总大小约 2.83 GB。
- 原 lightweight parser 全量扫描约 22 秒，峰值 RSS 约 780 MB。
- 仅增加 event `since` 过滤仍约 21 秒，因为 507 个文件仍全部打开和解析。

“按 session 创建日期筛最近一周”不可作为正确性口径：
- 最近 7 天真实有活动：127 个文件，约 585 MB。
- 按创建日期筛只命中 121 个文件，并漏掉 8 个长寿命 session。
- 最大漏项为 8 月 17 日创建、9 月 17 日仍有活动的约 203.5 MB session。

推荐 fast-path：
1. Plugin 只统计榜单时区“今天”的累计 Codex token，不为上传生成完整 dashboard snapshot。
2. 在解析前使用 `activitySince` 做文件级候选预筛。
3. 文件 mtime 新于边界时直接保留。
4. mtime 较旧时只读取尾部小块，检查最近事件 timestamp；无法可靠解析尾部时保守地保留该文件。
5. 候选文件内部仍使用 event timestamp 作为最终统计口径，文件元数据不直接决定 token 归属。

实测：
- 最近 7 天：507 文件 / ~21 秒 → 118 文件 / ~4.4 秒，事件结果一致。
- 历史真实活跃日 2026-09-21：507 文件 / ~20 秒 → 2 文件 / ~0.9 秒。
- 该日两种路径均得到 197 个 usage event、26,923,583 tokens。

因此 v0.1 Plugin 的默认上传不提供“全历史扫描”，而只上传“当前榜单日累计值”。历史周/月榜由服务端累积每日 sample 生成，不要求客户端每天重扫过去一周。

### 20.1 时区边界

Server pairing 会下发统一 leaderboard timezone。Plugin 将该时区当天 00:00 转为绝对 UTC instant，再同时用于：
- `since`：event 级最终过滤。
- `activitySince`：session 文件级预筛。

不能直接把 `YYYY-MM-DD` 传给现有 parser 作为 UTC 日期边界，否则 UTC+8 等时区会在本地午夜附近漏算。

### 20.2 多环境扫描边界

Denglema Plugin 与个人 Dashboard 的 source discovery 语义不同。

Plugin 必须满足：
- 一个 installation 只统计当前运行环境的 native `CODEX_HOME` / 默认 `~/.codex`。
- Windows installation 不自动发现 WSL Codex Home。
- 不读取 Dashboard 中注册的其他 Codex 目录。
- WSL、Windows、远程 Linux server 分别安装/绑定时，各自产生独立 installation，由服务端按 `user_id` 求和。

否则 Windows 自动扫描 WSL、同时 WSL 又自行上传时，会造成同一份日志重复计数。

[executed on device: LAPTOP-PJM7MTNJ (fca9fd9f-49e2-4eb2-a94c-13d3459862e7)]