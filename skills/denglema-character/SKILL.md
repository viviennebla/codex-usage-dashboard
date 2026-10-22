---
name: denglema-character
description: "Create, replace, validate, preview and contribute Denglema PNG rider or vehicle packs through an Agent and GitHub PR. Trigger on 自定义蹬了吗人物, 帮我生成/上传蹬了吗角色, 给蹬了吗换头, 逐帧PNG动画, 自定义载具, 导入人物素材, 提交角色投稿, or similar Denglema character-art requests."
---

# 蹬了吗 · 自定义人物和载具

你的任务是把用户自己制作或授权发布的角色素材真正接入蹬了吗的 **PNG Rider / Vehicle Pack** 系统，而不只是写一份设计文档。此 Skill 随 Denglema Plugin 安装，但素材代码、注册表、审核和上线都属于仓库 **viviennebla/codex-sync-server**，不是当前 Plugin 仓库。

**与其他 Skill 分工：** Usage 绑定/上传走 denglema-sync；新的趣味成就等功能投稿走 denglema-co-create。这里只处理人物、表情头部、配件、逐帧动作、人物与载具的 PNG 组合。

## 先判断用户想实现什么

- **选择已发布的人物 / Emoji 换头 / 表情 / 背包 / 交通方式**：查看服务端是否已有 GET /api/rider-catalog 和 /me 设置；已有就指导或帮助用户通过 UI/API 修改个人设置。不要为单纯切换现有外观发公共 PR。
- **创建新的公共人物、替换素材、制作新载具或动画**：按下述流程制作角色包并验证，用户明确要求提交时才提交 GitHub PR。
- **只讨论创意**：给草案与素材要求；不要未经请求 Fork、上传图片或创建 PR。
- **只有概念图还缺逐帧素材**：说明缺少哪些 PNG，能实际制作才制作；不能仅凭文字声称已经产生或验收了逐帧动画。不要回到旧 SVG/CSS 人物、骨架旋转或假装有真实载具帧。

## 0. 必须检查代码合同是否已发布

1. 从 GitHub 读取 viviennebla/codex-sync-server 最新 main、AGENTS.md、docs/denglema-character-frames-v1.md、scripts/rider-packs.mjs、src/rider-assets.js，以及已有的类似 Rider Pack PR；不能只依据本 Skill 的静态示例。
2. **main 存在并支持 Rider Pack**：以最新 main 为开发基线，使用该版本的导入命令、Schema、测试与页面验收规范。
3. **main 尚不支持**：确认上游 PR #81（feat/denglema-frame-character-customization）的当前状态。若 PR #81 仍开放，可在该分支的最新代码上制作和校验素材；只有用户确实要求现在投稿时，才考虑向该依赖分支提交 PR，并说明在 #81 合并前无法上线。默认不往不支持该功能的 main 提交“可立即实装”的 PR。
4. 如果 #81 被关闭而未合并、接口变更或源码找不到导入工具，先查明新的 canonical 合同；禁止用猜测的 JSON 或自行编造 API 继续。

可使用 Agent 已授权的 GitHub connector 来读文件、创建分支和 PR；运行 PNG 检测、开发服务器、浏览器预览时才使用具有本地文件/终端权限的开发环境。

## 1. 制作 Rider Pack / Vehicle Pack

打开同目录的 references/pack-contract.md，按**当前仓库代码**核对字段与实际能力。最小目标：

- 人物包：manifest.json + 独立透明 PNG 人物帧 + 至少 neutral PNG 头。允许选择 Emoji 作为文字头部覆盖层，但**绝不把 Emoji 生成为 SVG**。
- 载具包：manifest.json + 透明 back 层逐帧 PNG，可选 front 层。用户需要同时提供适应该载具的角色身体动作 PNG；不要把自行车动画冒充滑板/冲浪。
- 统一 128×100 RGBA8 透明画布、固定配准原点；主体序列不烘焙头部；人物/载具可有不同帧数和 FPS，靠统一画布叠加而非重新编排骨骼。
- 配置中只写包内相对资源路径和已发布载具 ID；不要把本机绝对路径、GitHub token、对话内容或其他私人资料写入 Manifest。
- 图片由用户提供或用户明确委托制作；用于公开仓库前确认确有发布权，不把私人图片默认视为同意公开上传。

如果只是制作新人物，不扩展已有服务端 API，也不改 Usage 协议、排行榜、授权设置或用户账户。

## 2. 代码导入：调用服务端真实脚本

在 codex-sync-server 的独立开发分支执行。**新包**才执行导入，已有包直接修改对应的已注册目录：

~~~bash
npm ci
npm run riders:import -- /path/to/my-character
# 若创建的是独立载具包：
npm run vehicles:import -- /path/to/my-vehicle
npm run riders:validate
npm test
~~~

两个 import 命令是服务器仓库提供的本地代码操作，不是 Plugin MCP 远程上传命令。它们负责复制、写入注册表、验证并在失败时回滚；运行前读当前版本的 help/代码，避免误用。

源码与配置入口：

- public/riders/frames/manifest.json：发布角色和载具包的注册表。
- public/riders/frames/<id>/manifest.json：人物头部、状态、PNG 帧、可选 vehicle_id。
- public/riders/vehicles/<id>/manifest.json：可复用车辆的后景/前景帧。
- scripts/rider-packs.mjs：导入、验证；src/rider-assets.js：资源格式和白名单校验。
- public/rider-frame-runtime.js：真正加载并替换角色，GET /api/rider-catalog：目录读取；PUT /api/me/rider-appearance：个人选择。

**验收不仅是 npm test**：实际打开开发环境 /rider-preview，检查动作顺序/循环、头部配准、至少两种状态、背包、375px 与桌面、reduced-motion、角色 + 载具的合成。若真实浏览器不可用，明确标记“视觉验收未完成”，不要暗示图片已实装上线。

## 3. 提交 GitHub PR（不自动合并）

- 一条角色/载具投稿一个功能 PR，基于已确认的 main；若依赖 #81 的功能分支，按实际 target base 创建 PR 并声明依赖。
- 先检查本地 git status、待提交素材文件、许可证/来源说明；不要提交临时 Prompt、私密图片、密钥、备份或完整本机路径。
- 用户无需目标仓库 Collaborator 权限：优先使用已授权 GitHub 工具；否则使用用户已登录的 gh CLI Fork 工作流。没有 GitHub 授权时先准备本地包，不能声称已投稿，也不要索取明文 PAT。
- 不直接 push upstream main，不自动 merge，不触发生产部署。PR 描述至少写 Why / What changed / Behavior change / Validation / Known limitations / Follow-up，并按服务端 AGENTS.md 处理一次性更新公告。自动校验成功不等于美术审美验收通过。
- 只有 PR 链接真实存在才能报告“已提交”。清楚区分：**本地验证 → CI 通过 → 维护者审核 → merge / 自动部署 → 用户在 /me 选择**。

完成时反馈素材包 ID、可用 transport、执行过的校验、视觉验收状态、PR 地址及是否等待 #81。不要把尚未审核的投稿写成“平台已收录”。

## 限制

本 Skill **不包含**任意用户图片直接写入线上服务器的公开上传 API。当前渠道是 Agent 处理用户素材 → GitHub PR → 审核合并部署。若用户明确要求网站直接上传，应将其作为后续需设计权限、审核和持久存储的产品需求，不要自称已支持。
