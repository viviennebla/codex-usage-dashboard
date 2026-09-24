[Reading 525 lines from start (total: 525 lines, 0 remaining)]

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
- 飞书只承担身份、昵称、头像和登录体验，不做机器人播报。
- 不采集 prompt、代码内容或对话正文。

v0.1 的产品优先级明确为：
1. 飞书身份与头像。
2. Token 总量与短时间 burn rate。
3. 骑手动画和榜单。
4. 留言弹幕。
5. 模型分类、项目聚合降为次要能力，可复用现有数据但不阻塞首版。
## 2. 现有代码基础

`codex-usage-dashboard` 已经具备本地 Codex / Claude 日志解析能力，并能生成 snapshot。

当前 snapshot 已包含：
- `today`
- `seven_days`
- `models`
- `top_projects`
- `top_sessions`
- `active_session`
- `burn_rate.tokens_15m`
- `burn_rate.tokens_60m`
- `burn_rate.tokens_per_minute_15m`
- `burn_rate.tokens_per_minute_60m`

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
- 插件只上传统计增量，不上传完整 Codex JSONL 或完整 dashboard snapshot。
- 服务端根据 installation token 得到 user，不允许客户端自行声明榜单身份。
## 4. 飞书身份设计

### 4.1 为什么飞书是首要能力

飞书不是可选登录方式，而是产品体验的一部分：
- 同事无需注册新账号。
- 直接显示真实同事昵称和飞书头像。
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
  │ 获取昵称 / avatar / stable user id
  ▼
Session Cookie
```

服务端保存最小用户资料：
- `user_id`：服务端内部 ID
- `feishu_open_id` 或适合当前应用范围的稳定 ID
- `display_name`
- `avatar_url`
- `last_login_at`

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

```text
Stop hook
  │
  ├─ 读取本地 cursor
  ├─ 增量扫描 Codex usage 数据
  ├─ 计算尚未上报的 token delta
  ├─ 写回 cursor
  └─ POST /api/usage/batch
```

Stop hook 建议异步执行，避免阻塞 Codex 正常交互。

SessionEnd 做轻量最终 flush：
- 不重新全量扫描。
- 只提交尚未发送的小量增量。
- 必须在极短时间内结束。

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

v0.1 不上传完整 snapshot，只上传“榜单所需的最小统计增量”。

建议：
```json
{
  "installation_id": "inst_xxx",
  "events": [
    {
      "event_id": "stable-dedup-id",
      "session_id": "thr_xxx",
      "turn_id": "turn_xxx",
      "observed_at": "2026-09-24T06:00:00Z",
      "token_delta": 48231
    }
  ]
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
### 7.1 幂等与离线

`event_id` 必须可稳定去重，避免：
- Hook 重试导致重复计数。
- Codex 崩溃后恢复造成重复上报。
- 网络抖动时重复 POST。

Plugin 维护本地 pending queue：
- 上传成功后删除。
- 内网服务器不可达时保留。
- 下次 Stop / SessionEnd 再发送。

服务端必须以 `event_id` 做幂等。

### 7.2 为什么用 delta 而不是 snapshot

优点：
- Payload 很小。
- 不暴露本机完整统计数据结构。
- 多 installation 自然汇总到一个人。
- 更容易计算 5/15/60 分钟 burn rate。
- 服务端可以直接驱动赛道动画。
## 8. 服务端领域模型

v0.1 最小模型：

```text
User
  id
  feishu_id
  display_name
  avatar_url

Installation
  id
  user_id
  token_hash
  created_at
  last_seen_at
  revoked_at

UsageEvent
  event_id
  installation_id
  user_id
  observed_at
  token_delta

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
  "name": "Feiyan",
  "avatar_url": "...",
  "today_tokens": 4210000,
  "tokens_15m": 520000,
  "tokens_per_minute_15m": 34667,
  "last_activity_at": "...",
  "state": "burning"
}
```

推荐状态：
- `idle`：近期没有 token 增量。
- `riding`：正常有增量。
- `fast`：超过个人或团队近期阈值。
- `burning`：进入高 burn rate，显示冒火效果。

不要把 token 数直接映射为无限线性速度。
建议：
- 今日累计 token 决定赛道“进度/排名”。
- 最近 15 分钟 burn rate 决定动画蹬腿频率、轮子速度、火焰等级。
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
- burn rate 只改变动画参数，不改变数据。
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

留言显示飞书头像和昵称，增强“同事路过赛场留句话”的感觉。

## 12. API 草案

身份：
- `GET /auth/feishu/start`
- `GET /auth/feishu/callback`
- `POST /api/pairing-codes`
- `POST /api/installations/pair`
- `DELETE /api/installations/:id`
采集：
- `POST /api/usage/batch`

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
- 获取昵称与头像。
- pairing code。
- 最小 Codex plugin。
- Stop hook 上报 token delta。
- 服务端能按 user 聚合 today / 15m。

停止条件：两台不同电脑、两个飞书用户可以稳定显示独立 usage。

### Phase B：赛场首页
- rider projection API。
- 飞书头像骑手。
- 今日累计排名。
- 15 分钟 burn rate 动画。
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
2. Server 实现 pairing code 和 `POST /api/usage/batch`。
3. Dashboard repo 内新增 plugin PoC，Stop hook 能读取本地 usage 增量并上报。
4. 首页先显示两个带飞书头像的 rider card：
   - today tokens
   - 15m burn rate
5. 确认真实数据链路稳定后，再开始自行车赛道动画。

这个顺序能优先验证本项目最大的不确定性：
**飞书身份 ↔ 本地 Codex plugin ↔ server user 聚合是否能丝滑打通。**

## 19. 外部能力依据

- OpenAI Agent Plugins 当前支持 skills、MCP server 和 lifecycle hooks。
- Plugin-bundled hooks 安装后需要用户审查并信任才会执行。
- Codex hook 的公共输入包含 session_id、transcript_path、cwd、model。
- Stop 在主线程 turn 结束时触发；SessionEnd 在线程真正结束时触发。
- transcript_path 可用于 hook 读取会话记录，但官方明确提示 transcript 格式不是稳定接口，因此 collector 必须隔离。
- 飞书 Web 登录、用户身份和头像能力在实施时以公司应用后台实际可申请权限为准。

[executed on device: LAPTOP-PJM7MTNJ (fca9fd9f-49e2-4eb2-a94c-13d3459862e7)]