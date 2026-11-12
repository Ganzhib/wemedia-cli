---
name: wm
description: 通过 wm CLI 管理自媒体平台账号、预览内容、保存草稿、发布文章并核对执行结果。用于用户要求多平台发文、平台草稿或自媒体内容管理。
---

# 多平台内容管理

wm 是统一入口。使用 `wm platform list --json` 和 `wm schema --json` 发现已实现的平台及命令，再用 `wm platform capabilities PLATFORM --account main --json` 核对目标能力。未声明的能力不编造，也不根据其他平台的流程推断。

账号未登录时运行 `wm auth login PLATFORM --account main`。CLI 管理浏览器，用户完成扫码或平台强制验证；不要索取、读取或展示 Cookie、Token、密码和验证码。

根据用户指定的账号与操作调用命令。写入前用 `wm auth status PLATFORM --json` 核对身份，用 `wm article preview FILE --platform PLATFORM --json` 检查内容。平台差异来自命令 schema、能力与输入校验；必要时准备平台版本内容，不静默截断原文。

常用命令：

~~~bash
wm draft create article.md --platform PLATFORM --json
wm article publish article.md --to PLATFORM:main --json
wm article list --platform PLATFORM --json
wm draft list --platform PLATFORM --json
wm job get JOB_ID --json
wm job refresh JOB_ID --json
wm job resume JOB_ID --json
~~~

只授权草稿时止于草稿。用户已明确内容、账号和发布目标后执行对应操作，不额外增加机械确认。群发等平台扩展以实际能力为准，不包含在普通发表授权中。

`submitted` 表示受理，按任务回查实际展示；`unknown` 表示可能已写入，先回查且不重放；`waiting_for_verification` 表示平台要求验证，保留任务 ID。分别报告各目标结果，保留其他平台已经完成的内容。

同一内容及目标默认复用已有任务。只有明确要求再发一份时才使用 `--new-copy`。平台输入和自然语言示例见 [内容场景](references/scenarios.md)，仅在准备对应内容时读取。
