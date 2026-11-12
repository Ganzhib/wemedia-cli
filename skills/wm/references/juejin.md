# 掘金

处理掘金时读取本页，并查询 wm platform capabilities juejin --json。登录使用 wm auth login juejin。当前统一入口注册 draft.create、draft.update、draft.publish、resource.get、content.publish、draft.list、article.list，以及 juejin.category.list、juejin.tag.search、juejin.column.list 扩展；通过 platform exec 调用扩展来确定分类、标签和专栏。

正文保留 Markdown，CLI 通过平台上传协议替换正文图片引用，原文件不变。创建内容需要 50–100 字符的 brief 或 summary、category 和至少一个 tags 项。分类和标签必须使用查询返回的数字字符串 ID；不在认证后进行名称解析。平台上传限制由掘金实现校验，不适用于其他平台。

~~~yaml
platforms:
  juejin:
    category: "替换为分类数字ID"
    tags: ["替换为标签数字ID"]
    brief: 按真实内容撰写五十到一百字的摘要，说明文章解决的问题、实现方法和结果。缺少必要资料时补足资料，不使用占位文本替代摘要，也不在没有正文时创建发布内容。
    columns: []
~~~

columns 是专栏 ID 的数组；只有目标明确时填写。发布流程创建草稿并将同一草稿提交到指定专栏，失败后复用已经保存的步骤和草稿引用。

~~~bash
wm draft create article.md --platform juejin --json
wm article publish article.md --platform juejin --json
wm draft list --platform juejin --json
wm article list --platform juejin --json
~~~

返回提交受理不等于文章已经审核或展示成功。保留任务和远端 ID，按查询结果分别报告。独立 juejin-cli 的旧命令、签到和定时任务不是 wm 已注册能力，不拼接旧命令或调用旧入口。

已有草稿先 resource.get 读取完整快照；draft.update 沿用原草稿 ID，保留未覆盖的分类、标签、摘要及封面。draft.publish 从最新快照继续提交。外部修改触发 CONFLICT，先核对差异再更新。素材缓存按账号及用途隔离，复用前通过原 ImageX URI 回查地址。
