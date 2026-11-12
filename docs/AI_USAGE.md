# AI 与 SDK 使用

AI 优先读取 wm schema 和 platform list。未声明的操作不尝试拼接私有接口。用户只授权存草稿时不发表；用户已明确给出文章、账号和发表目标时，不重复请求同一授权。

```bash
wm schema article publish --json
wm platform list --json
wm auth status wechat --json
wm article preview article.md --platform wechat --json
wm draft create article.md --platform wechat --json
```

JSON 成功结果位于 stdout 的 data。失败使用非零退出码，结构化错误位于 stderr。任务失败的 details 包含 job_id 和目标完成阶段。交互式登录或管理员验证会在 stderr 提示人工动作，凭据不会回显。

```ts
import { PublishingService, defaultRegistry } from '@ganzhibin/wemedia-cli';

const service = new PublishingService('/absolute/path/to/wemedia-home', defaultRegistry());
const plan = await service.create('/absolute/path/article.md', ['wechat:main'], 'draft');
const result = await service.run(plan.id);
```

SDK 调用返回每个平台的状态；CLI 会将未完成目标映射为非零退出码。SDK 使用者也必须检查目标状态。不要捕获写入异常后立刻重试，先查询 job get / refresh。新平台实现遵守同一锁、步骤与回执契约。

upstream 的 JuejinClient、DraftService 等导出保留用于底层协议访问；需要完整跨平台生命周期时使用 PublishingService。
