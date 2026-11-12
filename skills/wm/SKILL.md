---
name: wm
description: 通过 wm CLI 管理自媒体平台账号、草稿、发布和回执；用于公众号、小红书、掘金、知乎或其他已接入平台的内容管理与多平台发文。
---

# 多平台内容管理

wm 是统一入口。使用 `wm platform list --json` 和 `wm schema --json` 发现已实现的平台及命令，再用 `wm platform capabilities PLATFORM --account main --json` 核对目标能力。未声明的能力不编造，也不根据其他平台的流程推断。

根据目标平台按需加载独立指导，不将某个平台的字段或限制套到其他平台：

- [微信公众号](references/wechat.md)：排版、正文图片、封面、草稿回读及发表验证。
- [小红书](references/xiaohongshu.md)：图文、短文、正式话题、可见范围与审核回查。
- [掘金](references/juejin.md)：Markdown、分类标签、摘要和专栏。
- [知乎](references/zhihu.md)：专栏编辑器、自动保存、图片与创作声明。

其他平台以注册能力及 schema 为准。平台知识分开维护，账号、任务和错误处理共用 wm。

正文与配图在发布前通过公共 `wm content` 命令准备，适用于所有已接入平台，无需平台账号：

~~~bash
wm content write article.md --input source.md --json
wm content screenshot https://example.com --output assets/website.png --json
wm content diagram-schema --json
wm content diagram architecture.json --output assets/architecture.png --json
~~~

截图支持 `--selector` 截取指定元素和 `--full-page` 截取整页；架构图输入以 `diagram-schema` 输出为准，不自行复制维护 schema。输出文件不覆盖已有文件，回执包含路径、字节数和 SHA-256。先准备正文与图片，再建立发布计划，让计划捕获完整素材快照。图片按目标平台的内容格式引用，封面及平台限制仍以该平台能力为准；公共素材命令不代表各平台拥有相同的发表能力。

账号未登录时运行 `wm auth login PLATFORM --account main`。CLI 管理浏览器，用户完成扫码或平台强制验证；不要索取、读取或展示 Cookie、Token、密码和验证码。

根据用户指定的账号与操作调用命令，用 `wm account list --json` 选择本机绑定，用 `wm article preview FILE --platform PLATFORM --json` 检查内容。CLI 在每次执行时自动核验在线身份；需要诊断认证时再调用 auth status，避免为同一次写入重复启动验证会话。平台差异来自命令 schema、能力与输入校验；必要时准备平台版本内容，不静默截断原文。

平台选项使用 frontmatter 的 platforms.PLATFORM 或 --options JSON 文件。自定义能力通过 wm platform exec PLATFORM CAPABILITY --input FILE --json 调用，同样检查副作用范围。新账号绑定直接通过登录建立，不读取或迁移旧布局。

常用命令：

~~~bash
wm draft create article.md --platform PLATFORM --json
wm article publish article.md --to PLATFORM:main --json
wm article list --platform PLATFORM --json
wm draft list --platform PLATFORM --json
wm article plan article.md --to PLATFORM:main --intent draft --json
wm plan inspect PLAN_ID --json
wm plan diff OLD_PLAN_ID NEW_PLAN_ID --json
wm plan export PLAN_ID --directory ./preview --json
wm plan run PLAN_ID --json
wm resource get draft DRAFT_ID --platform PLATFORM --output base.json --json
wm draft update article.md --platform PLATFORM --base base.json --json
wm draft publish --platform PLATFORM --base base.json --json
wm publication list --json
wm publication refresh PUBLICATION_ID --json
wm job get JOB_ID --json
wm job refresh JOB_ID --json
wm job resume JOB_ID --json
~~~

只授权草稿时止于草稿。用户已明确内容、账号和发布目标后执行对应操作，不额外增加机械确认。群发等平台扩展以实际能力为准，不包含在普通发表授权中。

`submitted` 表示受理，按任务回查实际展示；`unknown` 表示可能已写入，先回查且不重放；`waiting_for_verification` 表示平台要求验证，保留任务 ID。分别报告各目标结果，保留其他平台已经完成的内容。

根据 required_action 和 next_action 的参数数组处理恢复。账号失效时按 binding 重新登录，不能因为别名变化而换账号重发。execution_status 描述执行阶段，status 保留该次业务结果，observation 是带时间的远端观察或读取错误；后续删除或审核拒绝不等于原提交从未发生。缺少证据时不要用 --new-copy 绕过未知状态。

需要分开审阅与执行时，先建立计划并 inspect 实际平台产物，再运行 plan run。计划保存正文及本地素材快照，修改或移走原稿不改变旧计划。相同修订、实际产物及目标默认复用已有计划与任务。只有明确要求再发一份时才使用 `--new-copy`。平台输入和自然语言示例见 [内容场景](references/scenarios.md)，仅在准备对应内容时读取。

已有草稿的更新与发表使用 resource.get 返回的完整快照作为 base；不要手工拼凑版本摘要。CONFLICT 返回远端变化和当前快照，先核对差异，再按用户意图准备新计划。公众号多篇图文必须明确 selector.item_index；整组版本变化会阻止对子项的更新。平台没有注册 draft.update 时直接说明范围。publication 的 revisions 保留同一资源的修订来源，observation 独立记录远端状态或读取错误。
