# 小红书与微信公众号发布能力调研

调研日期：2026 年 11 月 12 日。目标项目为 wemedia-cli，命令名规划为 wm。用户完成扫码登录后，日常上传、排版、选封面、保存草稿、发布与结果查询均由 CLI 完成；普通用户无需申请开发者凭据、配置 IP 白名单、手动安装浏览器扩展或操作后台表单。

首选方案是复用 juejin-cli 的工程基础，建立平台无关的发布核心。微信公众号使用文颜核心库排版、浏览器适配器操作后台；小红书先验证可由 CLI 管理的本地发布引擎，再接入统一任务与回执。正式发布过程中平台要求的身份验证仍由用户完成，CLI 保留任务并在验证后继续。

## 开源项目比较

下表中的提交为本次读取的源码快照，不代表功能均已通过本项目账号实测。

| 项目 | 源码中的能力与依赖 | 许可证记录 | 接入决定 |
| --- | --- | --- | --- |
| [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) | Go 与浏览器引擎，提供 HTTP 和 MCP；图文、视频、话题、可见性、预约发布；有 macOS arm64 二进制 | Apache-2.0 | 小红书发布引擎优先候选。通过本地 HTTP 接口复用，由 wm 管理安装、进程和登录，不让用户部署 Docker |
| [autoclaw-cc/xiaohongshu-skills](https://github.com/autoclaw-cc/xiaohongshu-skills) | Python、Chrome 扩展 Bridge；填写、正式话题、暂存草稿和发布分离 | MIT | 复用流程和选择器经验；手工安装扩展不符合默认体验，原安装流程不直接暴露给用户 |
| [chang-zy/xiaohongshu-skill](https://github.com/chang-zy/xiaohongshu-skill) | 上一个项目的独立下游；JSON CLI、话题节点验证、草稿与发布控制 | MIT | 补充参考。README 的实际验证止于发布页填写，明确没有验证最终点击发布 |
| [white0dew/XiaohongshuSkills](https://github.com/white0dew/XiaohongshuSkills) | Python 与 Chrome CDP，图文、视频、预览、多账号；README 标明目前仅测试 Windows | MIT | CDP 流程参考，不能直接视为本机 macOS 已验证的默认后端 |
| [jackwener/xhs-cli](https://github.com/jackwener/xhs-cli) | Python 与 camoufox，命令和 JSON 输出完整；发布可能需要另行登录创作者中心 | Apache-2.0 | CLI 设计参考；额外浏览器运行时与登录作用域需要验证 |
| [caol64/wenyan-cli](https://github.com/caol64/wenyan-cli) / [wenyan-core](https://github.com/caol64/wenyan-core) | Node.js 排版、代码高亮、图片处理、主题与公众号草稿 API；API 路径要求 AppID、AppSecret、IP 白名单 | Apache-2.0 | 直接使用 core 的渲染能力。API 驱动作为可选增强，不作为普通用户首次配置要求 |
| [JimLiu/baoyu-skills](https://github.com/JimLiu/baoyu-skills/tree/main/skills/baoyu-post-to-wechat) | TypeScript 与 Chrome CDP；公众号文章、贴图、API 与浏览器草稿；正文粘贴、图片上传、保存结果检测 | 仓库 MIT，第三方内容保留各自许可 | 微信浏览器工作流主要参考。提取所需模块，消除 Bun、手工 Profile 配置和无关技能依赖 |
| [doocs/md](https://github.com/doocs/md) | 微信 Markdown 编辑器与独立渲染包 | WTFPL | 排版备选。首期使用已验证的文颜 core，避免并存两套渲染器 |
| [xwh5/multi-publisher](https://github.com/xwh5/multi-publisher) | TypeScript 多平台适配器、浏览器登录、渲染、草稿与发布命令 | MIT | 多平台边界参考。公众号 API 路径仍需开发者凭据，不能把平台数量当作全部已验收能力 |
| [liushunqiu/auto-wechat](https://github.com/liushunqiu/auto-wechat) | Playwright 后台操作、原创、合集、封面、草稿、发表与扫码等待 | README 声明 MIT；本次仓库树未见 LICENSE，元数据未识别许可 | 仅参考流程。成功判断有明确缺口，不作为可直接复用的发布引擎 |

## 微信公众号的复用结论

### 渲染可直接使用 Node.js 核心库

文颜 CLI 实际依赖独立 npm 包 @wenyan-md/core；该包公开了渲染、微信协议和 Node 包装器入口。采用 npm 依赖比复制整个 CLI 更方便维护版本和调用契约。[包导出定义](https://github.com/caol64/wenyan-core/blob/b1c9edc7c13b8a5e110d29266aa849dfbc4dc6ef/package.json)

已在独立临时目录中安装并验证 @wenyan-md/core 3.0.12，配套 jsdom 27.4.0、form-data-encoder 4.1.0、formdata-node 6.0.3。安装关闭 lifecycle scripts，测试未调用账号接口。通过 @wenyan-md/core/wrapper 导入 renderStyledContent，中文标题与正文、内联样式、代码块渲染、图片引用保留均通过断言，生成 1339 字符 HTML。

文档示例使用 @wenyan-md/core/node，但 3.0.12 的 npm exports 没有这个入口；本次实测可用的入口是 @wenyan-md/core/wrapper。实现时以已安装包的导出和类型为准。[Node 渲染文档](https://github.com/caol64/wenyan-core/blob/b1c9edc7c13b8a5e110d29266aa849dfbc4dc6ef/docs/node.md)

### 默认通过浏览器完成后台操作

普通用户只需扫码登录。wm 管理专属浏览器 Profile、启动与关闭、登录探测、上传、编辑器填充、封面和保存操作。自动化可以运行有界面浏览器；用户无需点击后台按钮，不把全程无头运行作为功能正确性的前提。

宝玉的 wechat-article.ts 提供正文焦点控制、HTML 粘贴、图片上传和草稿保存检测。保存时读取 appmsgid、按钮状态及失败提示，比单纯点击保存更适合复用。[浏览器草稿流程](https://github.com/JimLiu/baoyu-skills/blob/ca703c2d7c2c4399a1dc0cf82224f8551e05a96d/skills/baoyu-post-to-wechat/scripts/wechat-article.ts)

文颜的 publishArticle 实际请求 draft/add；宝玉 API 脚本同样以 draft/add 为最终目标。这些流程只能作为草稿能力的依据。正式发表、结果回查和群发需分别实现与验收，不能将 media_id 当作公开文章地址。[文颜协议](https://github.com/caol64/wenyan-core/blob/b1c9edc7c13b8a5e110d29266aa849dfbc4dc6ef/src/wechat.ts)，[宝玉 API 流程](https://github.com/JimLiu/baoyu-skills/blob/ca703c2d7c2c4399a1dc0cf82224f8551e05a96d/skills/baoyu-post-to-wechat/scripts/wechat-api.ts)

auto-wechat 的代码表明发布可能要求管理员扫码；它在扫码超时后仍返回 True，设置封面未确认时也返回 True。因此不能直接接受其布尔返回值作为成功回执。wm 必须单独表示等待验证、提交受理、结果未知与最终成功。[需要修正的返回路径](https://github.com/liushunqiu/auto-wechat/blob/1344f7e1a31ac1c91d2a868f013380aff89abefb/src/auto_wechat/browser_engine.py)

### 官方 API 保留为可选驱动

已有开发者凭据及接口权限的账号可以选择 API 驱动；不要求普通用户为使用 CLI 开通开发者模式。固定 IP 服务与第三方授权平台属于后续可选部署方式。运行中的任务固定使用已选择驱动，浏览器提交超时后不能自动切换 API 再次发送。

## 小红书的复用结论

### 优先验证 CLI 管理的本地发布引擎

xiaohongshu-mcp 在 MCP 之外公开了 /api/v1/login/status、/api/v1/login/qrcode、/api/v1/publish、/api/v1/publish_video 等 HTTP 接口，适合由 TypeScript 适配器调用。当前 release 为 v2.7.4，提供 macOS Apple Silicon 二进制；用户的电脑满足该架构。[HTTP 协议](https://github.com/xpzouying/xiaohongshu-mcp/blob/bb6fa2e208719ee634fec37881be29d3aa4699b3/docs/API.md)，[路由定义](https://github.com/xpzouying/xiaohongshu-mcp/blob/bb6fa2e208719ee634fec37881be29d3aa4699b3/routes.go)，[release](https://github.com/xpzouying/xiaohongshu-mcp/releases/tag/v2.7.4)

如果采用该引擎，wm 负责固定版本下载与校验、进程启动、健康检查、账号目录、端口与访问令牌、退出清理。用户不手工启动服务。图片路径必须是引擎进程能访问的本地路径，远端引擎不能直接使用客户端文件绝对路径。

### 发布成功需要独立回查

发布代码检查正文长度、原创、可见性等，再点击新版或旧版发布按钮；当前成功检测以离开发布页为信号。service.go 的成功响应包含标题、内容和图片数，未包含可用于稳定回查的笔记 ID。因此其“发布完成”应作为 UI 侧提交完成证据，不能直接转换为 wm 的最终 published。[发布流程](https://github.com/xpzouying/xiaohongshu-mcp/blob/bb6fa2e208719ee634fec37881be29d3aa4699b3/xiaohongshu/publish.go)，[返回结果](https://github.com/xpzouying/xiaohongshu-mcp/blob/bb6fa2e208719ee634fec37881be29d3aa4699b3/service.go)

Bridge 方案能分离填写、暂存和发布；但当前 save_as_draft 在点击暂存并等待后记录成功，没有返回稳定草稿标识。必须增加草稿回读，不能把预览页填好或暂存按钮点击等同持久化草稿成功。[暂存与发布实现](https://github.com/autoclaw-cc/xiaohongshu-skills/blob/b043748282a57e347c52f517dfb59819121134ab/scripts/xhs/publish.py)

会话需要同时验证小红书主站与创作者中心。近期 [PR 913](https://github.com/xpzouying/xiaohongshu-mcp/pull/913) 修正创作者中心会话判断，说明仅凭主站 Cookie 存在不足以证明发布可用。实际验证时固定引擎版本，核对该问题是否已解决。

## 验收顺序

1. 本地安装后仅执行 wm auth login，用户扫码；CLI 返回真实账号与后台能力，不要求用户寻找 Cookie、AppSecret 或扩展目录。
2. 对两个平台分别验证一次真实登录、会话重用及登录失效恢复。验证主站与创作者后台的账号一致性。
3. 纯本地生成文章与平台渲染预览；缺少图片、元数据或权限时，在上传前报告具体问题。
4. 在获得指定测试内容的写入授权后，分别验证上传与草稿保存，并由 CLI 回读标题、正文、图片和账号。不能用按钮点击成功替代回读。
5. 在获得明确发布授权后，验证正式发表、平台审核与链接回查。公众号群发另行验收。
6. 对提交后的断网、CLI 退出、驱动崩溃和扫码超时验证恢复路径。结果未确认的写操作不自动重发。

本次完成了源码、协议与发布记录检查，以及文颜本地渲染验证；没有使用小红书或公众号真实账号登录、上传、存草稿、发表或群发。默认浏览器驱动的选择仍须通过以上账号验收。

## 源码快照

| 仓库 | 本次 main 或默认分支提交 |
| --- | --- |
| Ganzhib/juejin-cli | aca672cdcf88ff770c55dfe9bd9934c43bc328e2 |
| xpzouying/xiaohongshu-mcp | bb6fa2e208719ee634fec37881be29d3aa4699b3 |
| autoclaw-cc/xiaohongshu-skills | b043748282a57e347c52f517dfb59819121134ab |
| white0dew/XiaohongshuSkills | 6819a0404bed3dd099541f9dc415c1f35e0ae712 |
| jackwener/xhs-cli | 3577f20045a86d7015e02a7c6f869f2520ad7164 |
| caol64/wenyan-core | b1c9edc7c13b8a5e110d29266aa849dfbc4dc6ef |
| caol64/wenyan-cli | 08b5174443cb7dbfbae4592d89a02a6fdad8af31 |
| JimLiu/baoyu-skills | ca703c2d7c2c4399a1dc0cf82224f8551e05a96d |
| doocs/md | cb2e4217641b91ec141808859c6f1ecd4830c61e |
| liushunqiu/auto-wechat | 1344f7e1a31ac1c91d2a868f013380aff89abefb |
| xwh5/multi-publisher | d033a8cfcf71bcf01c53a160d976c9913c8da388 |
