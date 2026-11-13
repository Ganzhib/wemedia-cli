[![你的 AI，又在等你派活？淘气工作室 · 给它找点新本事。打开工具箱 ↗](docs/assets/studio-banner.svg)](https://my.feishu.cn/wiki/Tj4ZwTpEUisrg3kojmbcnR9yn1I?create_from=create_doc_to_wiki)

# wm · WeMedia

**wm 是 WeMedia 的缩写，意为「自媒体」。你的 AI 自媒体发布助手。**

把时间留给创作，把发布交给 wm。写好内容，告诉 AI 想发到哪里，wm 帮你接着处理排版、上传图片、保存草稿、提交发表和结果查询。

[看看产品官网](https://ganzhib.github.io/wemedia-cli/) · [开始使用](#开始使用) · [npm 安装包](https://www.npmjs.com/package/@ganzhibin/wemedia-cli) · [淘气工作室工具箱 ↗](https://my.feishu.cn/wiki/Tj4ZwTpEUisrg3kojmbcnR9yn1I?create_from=create_doc_to_wiki)

免费开源 · 在你的电脑上运行 · 搭配能操作本机的 AI 助手使用

## wm 能帮你做什么？

写完一篇文章，真正发出去之前，常常还有排版、配图、切换账号和检查草稿这些工作。wm 把这些操作接起来，让独立创作者、内容运营和写作爱好者更专注于内容本身。

- **一份内容，安排到多个平台。** 提供文章与图片，说明目标平台和账号，让 AI 帮你准备各平台的内容，再按你的安排发布。
- **介绍产品，配图也一起准备。** 让 AI 通过 wm 截取官网页面、绘制架构图，再将正文与图片用于各平台内容。
- **先存草稿，按自己的节奏发表。** 检查排版、封面和图片，准备好了再发。公众号与掘金还支持继续修改已有草稿。
- **发布进度有处可查。** 分别查看每个平台的处理结果。遇到中断，先核对已完成的部分，再处理剩下的工作。
- **账号留在自己的电脑上。** 通过平台登录使用，登录状态保存在本机。需要身份验证时，由你完成扫码。

## 支持哪些平台？

| 平台 | 可以帮你完成 | 使用说明 |
| --- | --- | --- |
| 微信公众号 | 文章排版、正文图片与封面上传、保存和修改草稿、提交发表、查看结果 | 发表与群发不同；平台要求时需管理员扫码验证 |
| 小红书 | 上传图片、发布图文笔记、选择话题、查看自己的笔记和发布结果 | 目前支持图文笔记，暂不支持视频和保存草稿 |
| 掘金 | 文章与图片准备、创建和修改草稿、发表原草稿、管理专栏、查询文章 | 分类、标签和专栏可以交给 AI 查询后设置 |
| 知乎 | 创建专栏文章草稿、上传图片与封面、发表已有草稿、查询文章 | 暂不支持修改已有草稿和列出草稿箱 |

各平台的支持范围不同，账号权限与审核仍由平台决定。提交发表后，需要继续确认实际展示结果。具体进展见 [平台验证记录](LIVE_ACCEPTANCE.md)。

## 试着这样对 AI 说

### 写完了，想让更多人看到

> 使用 wm，把我提供的文章和图片准备到公众号与掘金。先检查内容、排版和目标账号，把预览给我看；等我确认后再发表，并告诉我各平台的结果。

### 准备好了，还想再看一眼

> 使用 wm，把这篇文章和配图保存到公众号草稿箱。先确认目标账号，检查封面和排版，把草稿结果给我查看。这次只存草稿，暂不发表。

### 发现一处细节，想再改改

> 使用 wm，帮我修改公众号里的一篇已有草稿。先让我指定草稿和需要修改的内容，再核对当前版本。按我的要求更新原草稿，完成后给我查看，暂不发表。

给 AI 提供你的实际文章和图片，并说明使用哪个账号。建议从一份草稿开始，熟悉流程后再安排多个平台。

## 开始使用

### 1. 让 AI 帮你安装

把下面这段话复制给能操作本机的 AI 助手：

> 请直接帮我安装并配置 wm（WeMedia，自媒体发布助手）的最新版本，让我之后能用自然语言把文章和图片发布到多个自媒体平台，由 AI 处理内容检查、平台排版、图片上传、草稿或发布及结果回查。我只需完成平台登录，以及平台要求的扫码或安全验证。
>
> 目前已接入：微信公众号（wechat）、小红书（xiaohongshu）、稀土掘金（juejin）、知乎（zhihu）。公众号支持图文草稿与发表，掘金支持 Markdown 草稿与发布，知乎支持文章草稿与发布，小红书支持图文笔记发布；各平台能力不同，小红书目前不支持保存草稿。实际可用功能与限制以安装版本的 schema、平台能力和 Skill 指导为准，不把“已接入”当成当前账号已通过线上验证。
>
> 官网：https://ganzhib.github.io/wemedia-cli/
> 仓库：https://github.com/Ganzhib/wemedia-cli
> npm 包：@ganzhibin/wemedia-cli；安装后的命令：wm。
>
> 请按以下步骤实际操作，不要只给我安装教程：
>
> 1. 检查环境：确认你能操作我的本机终端，而不是仅能操作远程沙箱。检查操作系统、Shell、Node.js、npm，以及已有 wm 的版本和可执行文件位置。需要 Node.js 22.16+，优先使用满足要求且仍受支持的 LTS；已有兼容环境就复用。缺失或版本不符时，优先沿用本机现有的 Node 版本管理器安装兼容 LTS，避免并存多套相互冲突的 Node/npm。若无法操作本机，请明确说明，并让我把本提示词交给具备本机终端能力的 AI，例如 Codex 桌面端或 Claude Code。
>
> 2. 安装或升级：先查询 npm 官方 registry 中该包的 latest 版本与 engines，再执行 npm install -g @ganzhibin/wemedia-cli@latest。遇到权限、网络、registry、Node 版本或命令路径问题，依据实际报错检查 npm prefix、PATH 和版本管理器 shim，修正原因后再执行；不要原样反复重试，不默认使用 sudo、关闭 TLS 校验或覆盖现有环境。若包不可用，先核对官网与仓库的当前安装说明，不臆造替代包名或命令。
>
> 3. 验证安装：运行 wm --version、wm schema --json 和 wm platform list --json，确认实际执行的是刚安装的版本，并能发现上述平台。若显示旧版本或找不到 wm，先定位可执行文件和 PATH 冲突，不将 npm 安装成功等同于配置完成。
>
> 4. 配置 AI 使用指导：先通过 wm skill --help 确认参数，按当前 AI 客户端选择 Skill 目录，检查 wm skill status --json；缺失或需升级时安装内置 wm Skill，必要时使用 --agent 或 --dir。保留已有自定义文件，发生冲突时说明并选择独立目录，不直接覆盖。读取返回目录中的 SKILL.md，再按目标平台读取 references 下的对应指导；保持 wm 作为统一入口，不套用其他平台的字段或操作步骤。
>
> 5. 登录目标平台：先问我准备使用哪些平台，再用 wm account list --json 检查已有绑定，对目标账号运行 wm auth status PLATFORM --account ALIAS --json。尚未绑定时运行 wm auth login PLATFORM --account ALIAS（首次默认别名为 main）；已有绑定失效时按 Skill 使用对应 binding 重新登录，保留账号身份。逐个平台打开登录窗口，浏览器由 wm 准备；引导我扫码或完成平台验证，等待完成后重新核验账号。不索取、展示或导出 Cookie、Token、密码、验证码，也不要求我手工操作日常编辑和发布 UI。登录超时如实报告，等我方便时再继续。
>
> 6. 验证能力：使用 wm platform capabilities PLATFORM --account ALIAS --json 核对所选账号的功能。命令参数以实际 --help 和 schema 为准，PLATFORM、ALIAS 等占位符必须替换为实际值；平台不支持的操作要说明，不用正式发布代替保存草稿。
>
> 7. 最后用中文报告安装版本、运行环境、Skill 路径、各目标平台登录的账号与核验结果，以及尚未完成的事项；给我一条符合已登录平台能力的自然语言使用示例，再询问我要处理的文章或 Markdown 路径、图片、目标平台和账号，以及保存草稿还是正式发布。本次只安装、配置和只读验证，不创建测试文章、不上传素材、不发表或群发。收到明确的内容与操作范围后，再按我的要求执行。

<details>
<summary>我想自行安装</summary>

需要 **Node.js 22.16 或以上版本**。在终端运行：

```bash
npm install -g @ganzhibin/wemedia-cli@latest
wm --version
```

安装或升级都可以使用上面的命令。安装后可以让 AI 读取 wm 使用指导，帮助你准备内容和执行操作。

</details>

### 2. 登录你的平台

告诉 AI 你想使用公众号、小红书、掘金还是知乎，它会引导你打开对应平台完成登录。浏览器由 wm 自动准备，你按页面提示扫码或验证即可。

<details>
<summary>自行登录的命令</summary>

按需要选择平台：

```bash
wm auth login wechat
wm auth login xiaohongshu
wm auth login juejin
wm auth login zhihu
```

</details>

### 3. 交给它第一份内容

准备文章文件、封面和配图，说明目标平台及账号。你可以先要求“保存为草稿，不发表”，检查结果后再决定下一步。

想先试一试内容格式，可以参考 [示例文章](examples/wm-publishing-core.md)。不同平台需要的标题、摘要、分类等信息，可以让 AI 根据你的内容和平台要求补齐。

## 常见问题

**需要懂编程才能用吗？**

可以让能操作本机的 AI 助手帮助安装和使用。你主要负责提供内容、说明目标、登录账号和确认发布。wm 是安装在电脑上的工具，官网用于了解产品。

**wm 会帮我写文章吗？**

文章创作可以交给你的 AI 助手。wm 主要负责已有内容的准备、草稿管理、发布和结果查询。

**是否收费？**

wm 免费开源，采用 MIT 许可证。你使用的 AI 助手或内容平台可能有各自的收费规则。

**发布中断后怎么办？**

让 AI 先检查原任务的结果。wm 会保留已完成的步骤；结果暂时无法确认时，不会自动重复发送。核对清楚后，再继续处理。

## 想了解更多

- [产品官网](https://ganzhib.github.io/wemedia-cli/)：使用场景、支持平台与上手入口。
- [AI 使用与开发接入](docs/AI_USAGE.md)：供 AI 和开发者阅读的操作说明。
- [命令与接口说明](docs/API.md)：查阅具体操作及平台差异。
- [更新记录](docs/CHANGELOG.md)：了解版本变化。
- [问题反馈](https://github.com/Ganzhib/wemedia-cli/issues)：提交使用中遇到的问题或建议，请勿附带账号凭据。

<details>
<summary>参与开发</summary>

从源码安装：

```bash
git clone --branch master https://github.com/Ganzhib/wemedia-cli.git
cd wemedia-cli
npm ci
npm link
```

提交前按 [开发约定](AGENTS.md) 完成检查。实现细节见 [架构说明](docs/ARCHITECTURE.md)，发布流程见 [发布指南](docs/RELEASING.md)。

</details>

## 开源与致谢

wm 基于 [Ganzhib/juejin-cli](https://github.com/Ganzhib/juejin-cli) 派生，保留来源历史和 MIT 许可证。公众号排版使用文颜 core，相关浏览器流程参考并适配了社区开源实现。完整来源、许可与声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

喜欢这个工具，也欢迎逛逛 [淘气工作室的工具箱](https://my.feishu.cn/wiki/Tj4ZwTpEUisrg3kojmbcnR9yn1I?create_from=create_doc_to_wiki)，给你的 AI 找点新本事。
