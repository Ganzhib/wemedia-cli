# 微信公众号

处理公众号内容时读取本页，并查询 wm platform capabilities wechat --json 和 wm schema。登录使用 wm auth login wechat，身份是公众号而非扫码者的微信昵称。

当前能力为 draft.create、content.publish、draft.list、article.list。普通发表不包含群发，更新既有草稿尚未注册。不存在的能力不能通过重复创建来模拟。

Markdown 渲染为经过清理的 HTML；正文图片与封面使用本地文件，由 CLI 上传和选择。标题最多 64 个 Unicode 码点。可以设置 title、author、summary 或 brief、cover、images、theme，实际字段与约束以能力 schema 为准。未指定封面时使用首张正文图片；没有可用封面会在写入前报错。

~~~yaml
platforms:
  wechat:
    author: 作者
    summary: 文章摘要
    cover: ./cover.png
    theme: default
~~~

先预览，再按用户目标调用草稿或发表。保存流程包含正文、图片、封面以及保存后的内容回读。管理员扫码是平台的独立身份要求，不能当成普通按钮跳过。

~~~bash
wm article preview article.md --platform wechat --capability draft.create --json
wm draft create article.md --platform wechat --json
wm draft list --platform wechat --json
wm article publish article.md --platform wechat --json
~~~

草稿 ID 与文章公开链接分别处理。草稿存在不能证明一次发表未发生；发表响应丢失时保留任务并回查，不能重新创建或再次点击发表。
