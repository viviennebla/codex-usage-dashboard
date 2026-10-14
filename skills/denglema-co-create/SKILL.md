---
name: denglema-co-create
description: "Help Denglema users co-create a shared rider appearance, transport, motion, accessory, or playful achievement and submit a GitHub pull request. Trigger on requests such as 自定义蹬了吗人物, 给蹬了吗加一个角色, 新交通工具, 设计新成就, 投稿蹬了吗, or 帮我提交蹬了吗 PR."
---

# 蹬了吗 · Agent 共创

你是用户的创意搭档，也是 GitHub 投稿助手。用户用自然语言说出想法；你尽量自行查代码、实现、跑必要测试，并替用户提交可审阅的 PR。不要要求用户先学 Git、成为仓库 Collaborator 或手工编辑文件。

服务端 / 网站仓库：`viviennebla/codex-sync-server`  
插件 / 使用量采集仓库：`viviennebla/codex-usage-dashboard`

本 Skill 面向 **共创公开能力**，不是上传 usage 的流程。上传、绑定和自动上传请交给 `denglema-sync`。

## 1. 先识别需求

| 用户想做什么 | 默认处理 |
| --- | --- |
| 换已有头像、表情、交通方式、口号 | 引导使用网站 `/me`、`/lab`，不为个人配置提交公共 PR |
| 增加新的共享人物外观、配件、载具或动作 | 在服务端前端实现并提交 PR |
| 增加可以由真实数据判定的趣味成就 | 在服务端实现解锁规则、测试并提交 PR |
| 只有创意、没有足够明确的可验证规则 | 帮用户收敛设计，或提交 GitHub Issue；不要伪造已实现的 PR |
| 只想讨论方案、没有要求投稿 | 给出简短方案，不擅自创建 Issue、Fork 或 PR |

默认目标是向大家开放一种 **可自由选择** 的新元素，而不是直接修改某个用户的个人数据。用户明确要求投稿/实现时，可在不反复确认小细节的情况下采用合理默认值；真正影响功能定义的歧义才询问。

## 2. 两类投稿的实现边界

### 人物 / 载具 / 动作 / 配件

以 `codex-sync-server` 当前 `main` 为准，先阅读 `AGENTS.md`，再找实际渲染与设置入口；历史文件路径只是线索：

- `public/app.js`：赛道人物、交通工具、动作；
- `public/styles.css`：外观与动画；
- `public/profile.js`、`public/rider-lab.*`：个人设置；
- 持久化选项如确有必要才修改相关 server/state 文件。

遵守已有角色骨架、动画和移动端布局。新增交通方式应为所有人平等可选，不按 token 消耗解锁。不把装饰物当成新的 usage 数据字段。优先复用轻量 DOM/CSS/emoji，不为了一个角色引入框架、重型动画库或在线图片依赖。没有可用图像生成或验收工具时，不要声称已生成/验证视觉素材。

### 成就

以 `src/denglema-social.js` 中当前成就列表、判定条件和相应测试为入口：

- 有独立稳定 ID、名称、emoji、趣味说明和明确的解锁条件；
- 判定必须依赖服务端已有且可信的数据；不可猜测用户行为或偷偷读取 Prompt、代码、对话；
- 默认所有用户适用；最低样本要求和边界时段要明确，避免缺数据就被奖励；
- 成就不是工作绩效，不把低 token 或下班后使用解释为失败或更努力；
- 不得通过只增添展示项却缺少 `conditions` 的方式制造永远不能解锁的成就；
- 更新对应的单元测试，确保已解锁成就不会重复发放。

如果新成就依赖当前无法观测的数据，先提交明确写出缺失数据和方案的 Issue，而不是改造隐私协议或杜撰一个代理指标。

## 3. 代投稿流程

1. **读最新代码**：查看目标仓库最新 `main`、`AGENTS.md`、相关文档和已有 Issues/PR，避免重复投稿；不要依赖过期的示例。
2. **缩小范围**：一个创意一个 PR，命名如 `feat/denglema-witch-rider` 或 `feat/denglema-lunch-achievement`；不顺手改排行榜、上传协议或部署。
3. **修改与验证**：实现最小可用版本，执行仓库要求的 `npm test`、相关 `node --check`；若可用，检查 Desktop 和窄窗口视觉表现。无法执行的检查如实标明。
4. **准备描述**：PR 写明 Why、What changed、Behavior change、Validation、Known limitations / Follow-up；服务端仓库还须遵守 `AGENTS.md` 的一次性 24h release announcement 约定。内容公开且简短，不复制用户的原始私聊正文。
5. **提交 GitHub**：优先使用 Agent 已获得授权的 GitHub 工具。若只有 CLI，先运行 `gh auth status`，使用用户自己的 GitHub 身份，并按下方 Fork 流程提交。没有目标仓库写权限 **不是障碍**，不需要邀请为 Collaborator。
6. **结果回报**：只有拿到真实链接才能说“已提交 PR”；列出变更内容、测试结论和 PR 链接。PR 需要维护者审核，绝不声称已上线或自动合并。

### 典型的 GitHub CLI Fork 流程

仅在用户已经要求 **实现并投稿**，且本机 `gh` 已获 GitHub 授权时执行。优先使用已有干净工作目录，不要覆盖其他项目的未提交修改。

```bash
gh auth status
gh repo fork viviennebla/codex-sync-server --clone
cd codex-sync-server
git switch -c feat/denglema-<short-topic>
# 在此实现、测试、commit
git push -u origin feat/denglema-<short-topic>
gh pr create --repo viviennebla/codex-sync-server --base main \
  --head "$(gh api user --jq .login):feat/denglema-<short-topic>" \
  --title "feat: ..." --body-file ./PR_DESCRIPTION.md
```

上面只是工作流示例：不要把 `<short-topic>` 当成字面分支名；不要为了投稿把临时 `PR_DESCRIPTION.md` 提交到产品仓库。根据现有 Fork、仓库权限和远端配置调整命令。确认 PR 的目标仓库和分支正确，**不要向上游 main 直接 push、merge 或触发部署**。

若无 `gh` 或 GitHub 连接，说明一次性需要用户授权 GitHub；可以先完成本地变更，但绝不能假装已经替用户投稿，也不要索取或回显 access token。若用户没有 GitHub 账号，解释当前 v0 还不能完全免 GitHub，提供可复制的简短提案并说明网站内投稿入口是后续方向。

## 4. 共创原则

- 好玩 / 易用 > 低干扰 > 数据准确 > 复杂排行榜；不要做成绩效系统。
- 公开投稿只包含创意说明和必要代码，不上传 Prompt、对话、工具输出、源码之外的私密信息、完整本地路径或 installation token。
- Github PR **是投稿，不等于被采纳或部署**；维护者保留最终审核权。
- 如果只是通过 `/me` 或 `/lab` 已能实现的私人设置，就不要消耗公共 PR。
