# Rider / Vehicle Pack：供 Agent 查阅的最小代码合同

> 真正的合同在 viviennebla/codex-sync-server 当前代码中。优先读取 docs/denglema-character-frames-v1.md 和 src/rider-assets.js；这个参考页只是开始操作的模板，不能覆盖新版 Schema。

## 登记与文件目录

~~~text
public/riders/frames/
  manifest.json                     # 总注册表
  pixel-cat/
    manifest.json                   # 单角色合同
    heads/neutral.png
    walk/plain/00.png
    walk/plain/01.png

public/riders/vehicles/
  city-scooter/
    manifest.json
    back/00.png                     # 与人物同画布
    back/01.png
    front/00.png                    # 可选，盖在人物前方
    front/01.png
~~~

根 public/riders/frames/manifest.json（schema_version=2）采用：

~~~json
{
  "schema_version": 2,
  "default_preset": "helmet-commuter",
  "presets": {
    "helmet-commuter": "/riders/frames/helmet-commuter/manifest.json",
    "pixel-cat": "/riders/frames/pixel-cat/manifest.json"
  },
  "vehicles": {
    "city-scooter": "/riders/vehicles/city-scooter/manifest.json"
  }
}
~~~

## 角色包 manifest.json（schema_version=1）

**包内**全部使用相对路径。下面用两张帧图说明（应提供真实文件），正式动画可以按需求增加：

~~~json
{
  "schema_version": 1,
  "id": "pixel-cat",
  "label": "像素猫猫",
  "description": "骑着滑板车的猫",
  "canvas": { "width": 128, "height": 100 },
  "heads": {
    "neutral": "heads/neutral.png"
  },
  "emoji_head": {
    "left_percent": 55,
    "top_percent": 16,
    "font_size_px": 39
  },
  "fallback_transport": "walk",
  "transports": {
    "walk": {
      "frames": 2,
      "fps": 8,
      "head_offset": { "x": 0, "y": 0 },
      "layers": {
        "plain": ["walk/plain/00.png", "walk/plain/01.png"]
      }
    },
    "scooter": {
      "frames": 2,
      "fps": 8,
      "vehicle_id": "city-scooter",
      "head_offset": { "x": 0, "y": 0 },
      "layers": {
        "plain": ["scooter/plain/00.png", "scooter/plain/01.png"]
      }
    }
  }
}
~~~

这个示例只展示**结构**；scooter 的 body 应实际绘制为站在滑板车上的姿势，不能简单拿 walk 的帧文件当成完成的 scooter 美术。heads.happy/focused/tired 和 layers.pack 可选，缺省时分别采用 neutral 和 plain。用户更换 Emoji 头只改变显示文本，不会访问 SVG。

## 载具包 manifest.json（schema_version=1）

~~~json
{
  "schema_version": 1,
  "id": "city-scooter",
  "label": "城市滑板车",
  "transport": "scooter",
  "canvas": { "width": 128, "height": 100 },
  "frames": 2,
  "fps": 8,
  "layers": {
    "back": ["back/00.png", "back/01.png"],
    "front": ["front/00.png", "front/01.png"]
  }
}
~~~

载具只为自己的 transport 类型服务，角色必须在对应动作配置里引用已注册的 vehicle_id。动态合成顺序是 **车辆 back → 人物 body → 车辆 front → head PNG 或 Emoji**。

## 导入与校验命令

在 **codex-sync-server** 根目录运行，绝不能误在 codex-usage-dashboard Plugin 根目录执行：

~~~bash
npm ci
npm run riders:import -- /absolute/path/to/pixel-cat
npm run vehicles:import -- /absolute/path/to/city-scooter
npm run riders:validate
npm test
~~~

以上两个 import 是**针对新 ID**；修改已注册 ID 时直接更新仓库文件，避免因“已存在”而失败。

校验包括：JSON 合同/ID/资源注册与引用、FPS、帧数；PNG 文件实际存在、RGBA8、128×100、含透明像素且并非全透明；拒绝绝对路径/路径穿越/符号链接与未登记文件公开访问；限制文件尺寸、包数量与全部资源大小；车辆 ID 和 transport 类型匹配。

可在开发服务的 /rider-preview 验收真实 PNG 合成效果。内容变更通过 PR/CI/merge/部署进入 GET /api/rider-catalog；/me 动态读取目录，不需要维护前端硬编码的角色列表。

## 重要约束

- 公开发布的 PNG 应来自用户拥有权益的原创或有明确许可的素材。
- 图片/动画的创意方案不是已经存在的帧文件；不要为了通过检查而重复同一帧并谎称完成动作。
- 不要修改 Plugin 的 Usage MCP 流程，也不要添加“凭网页身份任意写服务器文件”的端点。
- 若服务器 PR #81 尚未进 main，可依赖其分支在独立开发工作区准备素材，但要如实标注没有正式上线能力；确认 PR 的 base 分支，不直接改 upstream main。
