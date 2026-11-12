# wemedia-cli

面向 AI Agent 的多平台文章发布 CLI，规划使用 `wm` 命令。首批接入掘金、小红书和微信公众号，用户完成登录后由 CLI 处理日常后台操作。

当前分支处于开源调研与架构设计阶段，代码仍为 juejin-cli 基线，`wm` 尚未实现。设计与验证记录见 [多平台架构](docs/MULTIPLATFORM_ARCHITECTURE.md) 和 [平台调研](docs/PLATFORM_RESEARCH.md)。

以下保留上游使用说明；其中的包名、安装命令和功能范围仍属于 juejin-cli。

## juejin-cli 基线

面向开发者与 AI Agent 的稀土掘金 CLI。用本地 Markdown 管理文章，支持登录、搜索、图片上传、草稿、专栏、发布，以及签到、抽奖和每日定时任务。TypeScript SDK 与 CLI 共用同一套实现。

## 安装

[安装官网](https://ganzhib.github.io/juejin-cli/) · [GitHub 源码](https://github.com/Ganzhib/juejin-cli) · [npm 包](https://www.npmjs.com/package/@ganzhibin/juejin-cli)

需要 Node.js **22.16+**。安装指南、场景与可复制提示词：[GitHub Pages](https://ganzhib.github.io/juejin-cli/)。

从 npm 安装：

```bash
npm install -g @ganzhibin/juejin-cli@latest
juejin --help
```

或直接运行 `npx --yes @ganzhibin/juejin-cli@latest --help`。官网安装区提供「复制给 AI，帮我装好」，适合把环境检查、安装与登录准备交给本机 Agent。

从 0.2.1 起，已安装 CLI 在业务操作前自动检查并使用最新稳定版；更新保存在用户缓存，无需管理员权限。成功检查结果复用 1 分钟，连续执行命令不反复查询 npm；网络检查最多等待 1.5 秒。下载失败继续使用已有版本，业务命令启动后绝不回退重放。JSON 输出保持干净。固定版本脚本可设置 `JUEJIN_AUTO_UPDATE=0`；源码、CI 和 npx 显式版本不会自动切换。0.2.0 及更早版本需先手动执行上面的安装命令一次。

推送 `main` 自动验收、递增 patch 并发布 npm，同一提交重跑会跳过；官网版本和下载地址以 npm 已发布的 `latest` 为准。配置及故障恢复见 [发布指南](docs/RELEASING.md)。

从源码安装：

```bash
git clone https://github.com/Ganzhib/juejin-cli.git
cd juejin-cli
npm ci
npm link
juejin --help
```

`npm ci` 会自动编译 TypeScript。也可以在项目目录使用 `node dist/cli.js`，无需全局链接。

首次浏览器登录前安装 Chromium：

```bash
juejin auth setup
juejin auth login
juejin auth status --json
```

登录会打开独立的浏览器窗口，等待人工登录，验证成功后保存会话。默认目录为 `~/.config/juejin-cli/`；可用 `JUEJIN_HOME` 或全局 `--home <directory>` 指定。会话文件以 `0600` 权限保存（POSIX）。

已有 Playwright cookies 数组或 storageState JSON 时，也可以导入：

```bash
juejin auth import --file /path/to/storage-state.json
juejin auth logout
```


## 签到、抽奖与每日定时任务

先安装浏览器并登录。签到和抽奖的受保护接口通过后台 Chromium 加载掘金官方页面，由页面正常运行安全 SDK；不提取或伪造签名。状态、记录和余额查询使用已有 HTTP 客户端。会话过期或平台要求人工验证时，重新运行 `juejin auth login`。

```bash
juejin checkin status --json
juejin checkin run --dry-run --json
juejin checkin run --json
juejin checkin stats --json
juejin checkin calendar --json
juejin checkin calendar --previous-month --json
juejin checkin balance --json
juejin checkin cards --json
juejin checkin rules --json
```

`run` 先查询北京时间当天状态，已签到返回 `already_checked_in`，不会重复提交。日历接口提供本月或上月记录；`date` 为 Unix 秒，`status` 的 0/1 表示今日未签/已签，2/3 表示过去未签/已签，4 表示未来。奖励直接使用平台响应，最新数量以 `checkin rules` 为准。

补签需要明确指定北京时间日期，并会消耗补签卡：

```bash
juejin checkin supplement 2026-11-11 --dry-run --json
juejin checkin supplement 2026-11-11 --json
```

日期必须在最近 30 天内且早于今天；平台预览会继续核对该日期和补签卡。固定日期示例请换成需要补签的实际日期。程序不自动购买补签卡。

每日自动签到由系统调度器启动，每次执行一次 `checkin run --json`，不需要常驻 CLI 进程：

```bash
# 预览；不安装任务
juejin checkin schedule enable --at 09:00 --name daily --dry-run --json
# 选择启用；同一会话目录、同名任务会更新，不会重复创建
juejin checkin schedule enable --at 09:00 --name daily --json
juejin checkin schedule status --name daily --json
juejin checkin schedule disable --name daily --json
```

时间采用**电脑本地时区**，结果中的 `timezone` 可核对；签到日界线仍采用北京时间。macOS 使用当前用户 launchd，Windows 使用当前交互用户任务计划程序，Linux 使用 systemd 用户 timer。电脑需要联网、用户环境可用；Linux 用户管理器未运行时不会触发。系统支持的唤醒/错过时间补执行仍需机器恢复运行。启用定时任务前使用长期保留的全局安装或源码目录，任务使用安装时记录的 Node 与 CLI 路径。

任务只签到，不补签、不抽奖。每个任务的日志位于结果返回的 `log` 路径，`disable` 会保留日志。账号会话过期时日志记录错误，任务不会尝试自动登录或重放失败写入。要立即签到，请运行 `checkin run`。

```bash
juejin lottery status --json
juejin lottery lucky --json
juejin lottery history --page 1 --json
juejin lottery rules --json
juejin lottery draw --dry-run --json
juejin lottery draw --count 1 --allow-spend --json
juejin lottery draw --count 10 --allow-spend --json
juejin lottery dip HISTORY_ID --json
juejin lottery lucky-draw --dry-run --json
juejin lottery lucky-draw --json
```

平台单抽优先使用免费机会，免费机会与付费单抽共用同一接口。预览不是锁定价格或免费机会；另一个设备可能先消耗免费次数，因此执行单抽或十连抽都需要显式 `--allow-spend`。成本来自平台配置；幸运抽奖消耗已积累幸运值，沾喜气使用平台规定的次数。中奖历史只展示奖品元数据，不输出收件人、电话或地址。领取实物、填写地址和购买道具仍通过官方网页处理。

所有写入复用账户写锁和操作回执。超时后先查 `history` 和今日状态/中奖记录，再决定是否重试；定时任务不会在一次失败后立即重试。网页接口及活动规则可能变化，工具不绕过平台验证。

## Agent Skill 自动安装

0.2.0 同时内置 `juejin-cli` 写作技能和 `drawio-skill` 绘图技能，安装到同一个 Agent 技能根目录，内容均来自 npm 包，无需再次下载技能仓库。写作指南采用本地参考文件和可自由组织的空白骨架。draw.io 脚本需要 Python 3，PNG 导出需要另装 draw.io Desktop；CLI 不会自动安装系统软件。

```bash
juejin skill status --name drawio-skill --json
juejin skill install --name drawio-skill
```

Skill 随 CLI 的 npm 包一起下载，内容与当前 CLI 版本对应，不额外从 GitHub 拉取不匹配的最新版。安装脚本会自动安装到 `~/.agents/skills/juejin-cli/`，供 Codex 与 Cursor 发现；检测到 `~/.claude/` 时，也会安装到 Claude Code 的技能目录。使用 npx 或禁用安装脚本时，首次运行 CLI 会自动补装。

```bash
juejin skill status --json
juejin skill install --agent claude --json
juejin skill install --agent cursor --json
juejin skill install --dir /path/to/skills --json
```

安装器会识别本包管理的版本并按需更新；已有自定义或手动修改过的同名 Skill 会保留。设置 `JUEJIN_AUTO_INSTALL_SKILL=0` 可关闭自动安装，`JUEJIN_SKILLS_DIR` 可指定 skills 根目录。新安装的 Skill 未出现在 Agent 中时，重新开启会话。

Skill 包含草稿、专栏、发布和热点选题示例，源码见 [skills/juejin-cli](skills/juejin-cli)。

## 发布到专栏

从 0.2.0 起支持目录级发布：先按本地 [技术写作指南](skills/juejin-cli/references/technical-writing.md) 整理文章，可选用 [空白 frontmatter 骨架](skills/juejin-cli/templates/article.md)，将待发布 `.md` 文件放在同一目录第一层。

```bash
juejin article publish-directory ./prepared --column COLUMN_ID --dry-run --json
juejin article publish-directory ./prepared --column COLUMN_ID --json
```

所有文章会先预检，再逐篇创建草稿和发布到同一专栏。目录内的 `.juejin-batch.json` 保存进度，重复执行跳过已完成项；写入结果未知时停止，先通过 `history` 和远端状态核对。不要删除进度文件后盲目重试。修改文章或配置后，请先核对旧任务，再使用独立发布目录。

先创建专栏或查看已有专栏，再创建文章草稿，最后把已有草稿发布到指定专栏：

```bash
# 新建专栏，可先 --dry-run 检查；封面既支持本地路径，也支持 URL
juejin column create --title "AI 工程实践" --intro "记录 AI 工具与工程化实践" --cover ./cover.png --json

# 列出自己的专栏，包含审核状态；取得 column.column_id
juejin column list --json

# 从本地 Markdown 创建草稿，取得 draft_id
juejin draft create ./examples/article.md --json

# 修改同一份草稿，省略的元数据沿用已有值
juejin draft update <draft-id> ./examples/article.md --json

# 发布已有草稿，并传入专栏 ID。多个 ID 使用逗号分隔
juejin article publish --draft <draft-id> --columns <column-id> --json
```

专栏新建或修改后可能需要审核。发布返回 `status: "submitted"` 表示接口接受提交，文章实际展示情况需通过网页或查询接口核对。

`article publish` 不传 `--columns` 时提交空的 `column_ids`，表示本次不指定专栏。重新发布已有文章时，如需保留其专栏归属，请显式传入原专栏 ID。

专栏的其他命令：

```bash
juejin column get <column-id> --json
juejin column articles <column-id> --limit 20 --cursor 0 --json
juejin column update <column-id> --intro "更新后的简介" --json
juejin column update <column-id> --cover ./new-cover.png --json
juejin column list --user <user-id> --limit 20 --json
```

## Markdown 格式

```markdown
---
title: 我的技术文章
brief: 这里填写五十到一百字的文章摘要，介绍文章要解决的问题、主要实现方法与读者能获得的结果。CLI 会检查摘要长度，并在上传图片或创建草稿之前报告输入问题。
category: 前端
tags:
  - 前端
  - TypeScript
cover: ./images/cover.png
---

# 我的技术文章

正文。

![架构图](./images/architecture.png)
```

- 参数优先级：CLI 参数 → frontmatter → 已有草稿值；新文章缺少标题时从首个一级标题提取。
- 分类支持名称、slug 或 ID；标签支持精确名称或 ID。名称查询会遍历标签接口的服务端分页。
- 摘要使用 50–100 字的输入约束；不会自动改写标题、摘要和正文。
- 本地正文图片和封面在写草稿前上传至掘金 ImageX，图片路径相对于 Markdown 文件。所有本地文件先验证，再开始上传。单张图片上限 5 MiB。
- 支持 Markdown 行内图片和引用式图片。通过语法树定位改写，代码示例和普通文本中的同名路径保持原样。同一文件在一次草稿操作内只上传一次。
- 原始 Markdown 文件不被改写；HTTP(S) 图片 URL 原样保留。HTML `<img>` 不属于本地图片自动上传范围。

创建或更新前可用 `--dry-run` 查看解析后的提交内容和本地图片路径。它会调用分类、标签等读取接口，但不会上传图片、创建草稿或发布。

```bash
juejin draft create ./examples/article.md --dry-run --json
juejin image upload ./images/cover.png --json
```

## 查询命令

```bash
juejin category list --json
juejin tag list --limit 20 --cursor 0 --json
juejin tag search "React" --json
juejin hot --category frontend --limit 10 --json
juejin recommend --limit 10 --cursor 0 --json
juejin article search "TypeScript" --sort newest --limit 10 --json
juejin article get <article-id> --format markdown
juejin article list --page 1 --limit 20 --json
juejin draft list --page 1 --limit 20 --json
juejin draft get <draft-id> --json
```

公开文章、热榜、分类标签和公开专栏查询无需登录。自己的文章、草稿、创作者专栏列表及所有写操作需要登录。

## AI 调用与错误处理

所有命令支持全局 `--json`：成功时 stdout 输出一行 `{"ok":true,"data":...}`；失败时 stderr 输出一行 `{"ok":false,"error":{"code":...,"message":...,"details":...}}`，同时返回非零退出码。默认模式使用缩进 JSON；`article get --format markdown` 在未启用 `--json` 时直接输出正文。

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 本地运行错误 |
| 2 | 参数或文件内容错误 |
| 3 | 缺少有效本地会话 |
| 4 | 平台业务错误、HTTP 错误或协议变化 |
| 5 | 网络请求未完成，写操作结果可能未知 |
| 6 | 同一会话目录已有写操作进行中 |

网络和 HTTP 请求**不自动重试**。创建草稿、发布、创建/修改专栏前后，会在会话目录的 `operations.jsonl` 追加操作回执，记录 ID 与阶段。超时或失败时先查询回执及远端状态，再决定是否重试。

```bash
juejin history --limit 20 --json
```

写操作共用本地排他锁；如果进程被强制杀死，确认原进程退出后可手动删除会话目录中的 `write.lock`。该锁只协调使用同一目录的 CLI 进程，网页编辑与其他设备仍需由使用者协调。

SDK 用法见 [AI 与 SDK 使用说明](docs/AI_USAGE.md)。首版交付 CLI 和 SDK，MCP 服务尚未实现。

Agent 可按需发现命令，无需提前加载全部帮助：

```bash
juejin schema --json
juejin schema article publish --json
juejin schema column create --json
```

结果包含参数、必填项、默认值与枚举，直接从命令注册信息生成。

## 开发与验证

```bash
npm ci
npm run check
npm test
npm run build
npm run smoke
npm run check:package
npm run build:site
npm run release:check
```

离线测试覆盖协议字段、19 位 ID 精度、写请求不重试、会话权限、并发锁、操作回执、图片上传链路、Markdown 改写和 JSON 输出。`smoke` 额外访问公开接口，不使用登录凭据，也不执行远程写操作。

GitHub Actions 在 Node 22 和 24 上运行类型检查、离线测试与真实归档安装检查。后者从 tgz 安装 CLI，验证可执行入口、Skill 安装及首次运行补装。登录、真实图片上传、创建草稿、创建/修改专栏和发布需要在自己的账号上进一步验证；离线测试通过不等于这些写入已实测成功。接口依据与验证状态见 [API 记录](docs/API.md)。

## 实现与许可

项目按职责分层：`src/cli/` 注册业务命令并统一输出，`src/services/` 编排草稿、专栏和发布流程，`src/platform/juejin/` 封装平台协议，`src/runtime/` 管理会话、写锁和 Skill，`src/content/` 处理 Markdown。`src/cli.ts` 仅作为可执行入口。

结构参考飞书官方 CLI 的命令、共享运行时、输出与技能分发边界，保持单 npm 包。目录树、依赖规则和扩展方式见 [架构设计](docs/ARCHITECTURE.md)；在自己电脑上首次发布与后续自动发布见 [发布指南](docs/RELEASING.md)。`npm run release:check` 会生成已经通过真实安装检查的归档，保存在 `release/`，不会登录或发布 npm。

本项目使用社区整理及掘金网页当前使用的非官方接口，接口可能变化。会话文件等同账号凭据，请保存在本机，不放入仓库或 AI 对话。

MIT。ImageX 上传与签名参考了 `liuleihang/juejin-skills`，保留其许可及附加声明，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
