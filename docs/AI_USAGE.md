# AI 与 SDK 使用

先查询 wm platform list 和 wm schema，再按能力的实际输入输出调用。平台特性由能力 schema 和 wm Skill 的平台参考文档表达。通用命令不固定某个平台的字段。

~~~bash
wm account list --json
wm platform capabilities wechat --account main --json
wm article preview article.md --platform wechat --capability draft.create --json
wm draft create article.md --platform wechat --json
wm platform exec juejin juejin.category.list --json
wm platform exec juejin juejin.tag.search --input tag-query.json --json
~~~

tag-query.json 可包含 {"keyword":"TypeScript"}。平台选项放在 frontmatter 的 platforms.PLATFORM 或通过 --options FILE 传入 JSON。JSON 成功结果在 stdout 的 data，失败结果在 stderr，使用非零退出码。

用户只授权存草稿时不发表。用户已经明确内容、账号和发表目标后，不重复请求同一授权。CLI 执行时在同一个会话内自动验证平台账号，不必为每次写入额外启动 auth status。

## SDK

~~~ts
import { PublishingService, defaultRegistry } from '@ganzhibin/wemedia-cli';

const service = new PublishingService('/absolute/path/wemedia-home', defaultRegistry());
const job = await service.create(
  'draft.create',
  { file: '/absolute/path/article.md', options: { author: '作者' } },
  ['wechat:main'],
);
const result = await service.run(job.id);
~~~

账号需先通过 wm auth login 建立。create 在写入前准备所有目标，绑定真实身份；run 不从别名重新选择账号。SDK 使用者检查每个目标的状态，不能把函数返回当作所有平台均已发布。

读取或通用能力调用使用 service.invoke(platformId, alias, capabilityId, input)。返回 effect 区分只读值和写入任务，写入仍经过相同的账号锁、探测及持久化回执。

## 平台实现

definePlatform 提供真实登录和 withSession 生命周期。readCapability、writeCapability 从输入、输出和准备产物 schema 推导处理器参数。平台的具体会话对象在工厂内部保留类型，公共服务只使用受验证的能力会话。

读取处理器只接收 account、session 和已经解析的输入；写入处理器还接收 artifacts、uploads 和 remember。单次写入用 writeCapability，复合流程用 workflowCapability 编译步骤，再用 stepHandler 提供有类型的输入、依赖和输出。步骤记录由公共执行器负责，不由平台手动包裹回执。注册时必须提供实际处理器，公共服务不会生成空实现。

## 冻结计划

article plan FILE --to PLATFORM:main --intent draft/publish 创建计划；plan inspect ID 展示实际平台产物及资产摘要；plan run ID 从快照执行。通用能力使用 plan create CAPABILITY --to TARGETS --input JSON，同样调用 PlanningService。

SDK 可调用 service.planning.create，保存 plan.id，稍后 service.start(plan.id) 建立任务并 service.run(job.id)。准备器使用 PreparationContext.capture/source/asset/output 捕获文本或二进制内容；执行时通过 context.artifacts 读取或定位快照。不要把原始绝对路径放入 prepared payload。源路径只保留在计划输入中作为来源信息，不进入去重键。

## 操作与内容记录

任务结果返回 operation_id。相同目标的其他计划共用该权威记录；任务摘要被删除或损坏不触发远端重发。publication list/get 查询本地远端引用与修订关联，publication rebuild 从操作记录重建索引。它们不宣称刚刚在线确认远端内容。

job refresh 保存带时间的 observation，和历史执行结果分开报告。索引或日志失败出现在 diagnostics；应修复本地存储或重建索引，不因此使用 --new-copy 重发。

stepHandler 的 recover 接收类型化输入、依赖和本步骤的 references/verification。返回 effect_confirmed 时 value 必须满足该处理器输出；最终步骤还必须达到能力完成条件。not_applied 需要明确对应这次操作的证据。不可确认时返回 indeterminate，不能用草稿存在或标题匹配替代发表证据。直接写能力可在 writeCapability 提供相同的 recover。

auth login PLATFORM --binding BINDING_ID 恢复指定真实身份；与 --account 登录不同，它不会移动别名。Verification 只保存种类、阶段、策略与安全资源标识，不保存 Cookie、验证码或带 Token 的后台 URL。

公开 SDK 只导出新契约。旧单平台命令树与转接导出已删除，旧任务和账号文件不参与新流程。


## 资源版本与内容来源

resource get KIND ID --platform PLATFORM --output base.json 将完整快照保存到文件（不是 stdout 的 ok/data 包装）。draft update FILE --base base.json 更新原草稿；draft publish --base base.json 从已有草稿发表。具体平台支持范围仍以注册契约为准。

CONFLICT 的 details 包含 expected_version、actual_version、changes 和 current。AI 应核对具体字段差异，再决定如何合并本地文章；不得自动把 current 替换为 base 后覆盖用户的远端修改。公众号多篇图文使用 selector JSON {"item_index":"1"}；未明确子项时拒绝更新，整组变化均触发冲突。

plan diff 比较两份冻结计划的字段、正文和资产顺序；plan export 导出 PreparedVariant.outputs 保存的实际正文产物。远端上传地址在实际执行后才出现，本地预览保留冻结的资产引用，不假造最终 CDN 地址。

publication 的 ID 由真实身份与稳定资源引用派生。同一资源的创建、更新、发表形成 revisions 链，素材引用不参与内容分组。publication refresh 通过稳定账号身份调用 resource.get，并将最新状态或读取错误保存为独立观察，不改写历史执行成功。索引删除后查询仍从操作记录派生。

素材复用使用 context.uploads.use(artifact, purpose, protocol, schema, hooks)。提供实际有效期时遵循 expiresAt；没有有效期或已到期时调用 revalidate，仅明确失效才重新上传。缓存投影写失败只产生 diagnostics，不能抹掉已确认的上传回执。平台不得自行猜测通用 TTL。
