---
name: wemedia-cli
description: 使用 wm 登录掘金、小红书和微信公众号，预览 Markdown、管理草稿、发布图文并核对跨平台任务。用户提到自媒体、多平台发文、公众号或小红书发布时使用。
---

# 多平台自媒体发布

先执行 `wm platform list --json`、`wm schema --json` 发现当前实现。不要编造能力。`wm platform capabilities PLATFORM --account main --json` 会在已配置账号上验证会话。

首次运行 `wm auth login wechat`、`wm auth login xiaohongshu` 或 `wm auth login juejin`。CLI 自动准备并管理浏览器，用户只需在打开的页面完成扫码或平台强制验证。不要读取、索取、展示或复制 Cookie、密码、Token。无需配置 AppID、IP 白名单或手工安装浏览器扩展。

写入前用 `wm auth status PLATFORM --json` 核对账号。文章通过文件传入，先执行 `wm article preview FILE --platform PLATFORM --json` 检查平台输出。平台覆盖配置放在 frontmatter 的 `platforms.wechat`、`platforms.xiaohongshu`、`platforms.juejin`。小红书需短标题、短文和本地图集；长文章应先由 AI 根据用户需求准备对应短文，不能由 CLI 静默截断。

```bash
wm draft create article.md --platform wechat --json
wm article publish article.md --to juejin:main,wechat:main --json
wm article publish note.md --platform xiaohongshu --json
wm article list --platform xiaohongshu --json
wm draft list --platform wechat --json
wm job get JOB_ID --json
wm job refresh JOB_ID --json
wm job resume JOB_ID --json
```

存草稿的请求止于草稿。用户已明确指定文章、账号和发布目标时执行发布，不重复索要授权。公众号发表不包含群发。小红书当前只开放图文发布和自己的笔记查询，不声称支持持久化草稿。

返回 `submitted` 表示提交已受理，使用任务回查确认实际展示。`unknown` 表示可能已经写入，不能重放；先回查远端状态。`waiting_for_verification` 表示平台要求用户验证，保留任务 ID。不同平台分别记录结果，不自动删除其他平台已完成的文章。默认相同内容与目标复用已有任务，明确要求再发一份时使用 `--new-copy`。

补充输入示例见 [场景与格式](references/scenarios.md)。
