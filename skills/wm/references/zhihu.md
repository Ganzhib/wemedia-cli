# 知乎

先读取 `wm schema --platform zhihu --json`。知乎是 wm 的一个平台注册项，使用同一账号绑定、内容快照、计划和步骤恢复；不需要额外安装知乎 Skill。

`wm auth login zhihu` 打开受管理浏览器，用户完成扫码和平台强制验证。以 `/api/v4/me` 的稳定 `id` 绑定账号；个人主页 `url_token` 只用于导航，变化不应更换账号。

当前能力包括 `draft.create`、`content.publish`、`draft.publish`、`resource.get`、`article.list`。未注册 `draft.update` 或草稿列表，不能凭其他平台能力推断存在。标题最多 100 字；正文保留 Markdown 渲染后的 HTML，本地图片通过原生编辑器上传，封面单独设置。AI 辅助文章可设置 `platforms.zhihu.declaration: ai_assisted`，由 CLI 选择平台创作声明。

草稿分配监听实际 POST 响应，立即保存返回 ID。正文粘贴由原生富文本编辑器处理，完成后读取服务器已保存内容；不能把填写后的 DOM 或固定等待当作草稿已保存。图片按原位置替换为上传地址，封面不自动成为正文配图。

只存草稿时使用 `wm draft create FILE --platform zhihu --json`。从已有草稿发表前，用 `wm resource get draft ID --platform zhihu --output base.json --json` 读取版本，再用 `wm draft publish --platform zhihu --base base.json --json`。有外部编辑冲突时返回差异，不直接覆盖或新建副本。

发表与公开状态通过原文章 ID 回查。请求不确定时保留任务，先 `job refresh`，再按证据 `job resume`；没有公开结果不等于未发表。浏览器测试与真实账号线上验收分别记录，当前证据见仓库根目录 LIVE_ACCEPTANCE.md。
