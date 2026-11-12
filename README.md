# wemedia-cli

面向 AI Agent 的多平台文章发布 CLI，命令名为 **wm**。用户完成平台扫码登录后，CLI 负责日常排版、上传、选封面、保存草稿、发表和结果查询，无需自行配置 AppID、IP 白名单、浏览器扩展或外部服务。

基于 [Ganzhib/juejin-cli](https://github.com/Ganzhib/juejin-cli) 派生，保留来源历史和 MIT 许可证。公众号排版使用文颜 core；浏览器流程分别适配宝玉和小红书开源实现，来源与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

当前开发版本为 0.2.0-alpha.2。账号和任务格式直接替换旧结构，不读取旧布局或自动搬迁数据。账号继续使用第一批建立的身份绑定。

## 当前能力

| 平台 | 已实现入口 | 明确边界 |
| --- | --- | --- |
| 掘金 | 登录、草稿、图文发布、自己的文章/草稿查询、指定专栏 | 发布受理与最终展示分别记录 |
| 小红书 | 主站与创作者中心登录、图文上传/发布、正式话题、自己的笔记查询、按 ID 回查 | 暂未开放视频与浏览器草稿；笔记 ID 以真实发布响应为准 |
| 微信公众号 | 扫码登录、文颜排版、正文图片、封面、草稿保存与回读、正式发表、草稿和发表记录查询 | 发表不包含群发；平台要求管理员扫码时等待验证 |

公共核心通过开放的能力注册表描述输入、输出、副作用与验收级别，支持账号身份隔离、平台能力发现、源文件与图片指纹、持久化任务、跨平台部分失败、步骤回执和恢复。结果未知的写入不会自动重发，已完成步骤不会重复执行。

真实账号验收和浏览器测试边界见 [实现与验收记录](LIVE_ACCEPTANCE.md)。代码实现不等于所有账号上的线上发表均已验证。

## 从源码安装

需要 Node.js 22.16+，推荐兼容的 LTS。当前版本从源码安装；尚未发布 npm 安装包。

```bash
git clone https://github.com/Ganzhib/wemedia-cli.git
cd wemedia-cli
npm ci
npm link
wm --version
wm platform list --json
```

安装包只包含名为 wm 的 Skill，默认目录为 ~/.agents/skills/wm/。安装器保留已有自定义文件，不扫描或兼容旧 Skill 目录。浏览器在首次登录时自动准备。无需事先运行 Playwright 安装命令。

```bash
wm auth login xiaohongshu
wm auth login wechat
wm auth login juejin
wm auth status --json
```

首次扫码由用户完成。登录后由 CLI 操作后台。平台可能在后续发表时额外要求管理员验证，此时 CLI 保留任务并提示验证，不会绕过身份校验。

同一平台账号可使用多个别名，并共享会话与锁。可用 `wm account alias wechat main work` 添加别名；使用 `--account work` 选择目标。账号目录位于 `~/.config/wemedia-cli/accounts/<bindingId>/`，别名索引位于 `aliases/<platform>/`，可用 `WM_HOME` 或 `--home` 覆盖。Cookie 和浏览器 Profile 只保存在本机，不写入回执或 Git 仓库。

## 预览与发布

```bash
# 只在本地解析和排版，不登录、不上传
wm article preview article.md --platform wechat --output preview.json --json
wm article publish article.md --to juejin:main,wechat:main --dry-run --json

# 冻结内容和目标，审阅实际产物后执行
wm article plan article.md --to wechat:main --intent draft --json
wm plan inspect PLAN_ID --json
wm plan run PLAN_ID --json

# 保存公众号草稿
wm draft create article.md --platform wechat --json

# 发布到指定平台账号
wm article publish article.md --to juejin:main,wechat:main --json
wm article publish note.md --platform xiaohongshu --json

# 读取平台内容
wm article list --platform xiaohongshu --limit 20 --json
wm draft list --platform wechat --json
```

相同内容修订、实际平台产物、操作和目标复用已有计划与任务。源文件位置、账号别名、目标顺序及 CLI 版本不参与计划身份。正文和本地图片按摘要保存；执行旧计划不再读取原文件，修改或移走原稿不会改变旧计划。HTTP(S) 图片仅冻结 URL，不宣称冻结远端字节。明确再发一份时传 `--new-copy`。

## Markdown 格式

公共字段可由 `platforms.<platform>` 覆盖，命令行参数优先级最高。图片路径相对于 Markdown 文件；公众号和小红书使用本地图片，CLI 自动上传。小红书长文需要事先准备短文，CLI 不会静默截断。

```yaml
---
title: 浏览器自动化实践
author: 作者
cover: ./images/cover.png
platforms:
  wechat:
    theme: default
    summary: 介绍浏览器自动化的工程实践。
  xiaohongshu:
    title: 浏览器自动化实践
    content: 针对小红书准备的短文正文。
    images: [./images/cover.png]
    tags: [编程]
  juejin:
    category: 前端
    tags: [前端]
    brief: 按真实内容撰写五十到一百字的摘要，说明文章解决的问题、实现方法和实践结果。将登录、内容准备、远程提交与结果核对分别处理，帮助读者理解自动化工具的职责与限制。
    columns: []
---
```

元数据后继续撰写 Markdown 正文。公众号使用主题 HTML，小红书使用平台短文和图集，掘金保留 Markdown。原始文件不会被远端图片地址覆盖。

## 任务与错误恢复

写命令返回 `job_id` 和各目标实际完成阶段。`draft_saved` 是已保存草稿，`submitted` 是平台受理，`published` 是已取得发表证据；`unknown` 表示写入可能发生，不能重放。

```bash
wm job get JOB_ID --json
wm job refresh JOB_ID --json
wm job resume JOB_ID --json
```

`resume` 跳过已确认步骤，遇到未确认写入停止。先用 `refresh` 回查有远端标识的结果。草稿存在不能证明此前发表未发生，因此不会据此重复点击发表。更改源文件、图片或驱动版本后需创建新计划。

## 给 AI 的使用示例

> 使用 wm，把我的 Markdown 保存到公众号草稿箱。先核对账号，预览平台排版，检查封面和本地图片；只存草稿，返回任务和草稿 ID。

> 使用 wm，将确认过的文章发到掘金和公众号，分别报告每个平台的完成阶段。发生超时时保留任务，先回查，不要重复发送。

Agent 使用 `wm schema --json` 读取真实命令定义，使用 `wm platform capabilities PLATFORM --json` 检查驱动和登录情况。平台没有声明的能力不会伪造成功。

## 开发

```bash
npm run check
npm test
npm run test:browser
npm run build
npm run check:package
```

浏览器测试拦截全部请求，不接触真实平台写接口。归档检查从实际 tgz 安装，验证 wm 入口、依赖、schema、认证边界和 Skill。来源基线的协议与回归测试仍保留。

[架构说明](docs/ARCHITECTURE.md) · [完整设计](docs/MULTIPLATFORM_ARCHITECTURE.md) · [SDK 与 AI 使用](docs/AI_USAGE.md) · [开源调研](docs/PLATFORM_RESEARCH.md)

后续通用核心契约见 [设计方案](docs/rfcs/0001-generic-publishing-core.md)，开发顺序与完成条件见 [实施计划](docs/PUBLISHING_CORE_IMPLEMENTATION.md)。

平台选项使用 frontmatter 或 `--options options.json`，不在通用 CLI 中固定分类、专栏或话题参数。扩展能力通过 `wm platform exec PLATFORM CAPABILITY --input input.json --json` 调用，读写共用同一身份和会话路径。例如掘金的分类、标签与专栏查询属于其独立能力。

`wm` Skill 内按需加载公众号、小红书和掘金的独立平台指导。公共执行器没有平台 ID 或内容格式枚举；平台仍保留自己的字段、限制、渲染和工作流。
