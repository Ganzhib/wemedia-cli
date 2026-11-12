# 多平台发布的实现结构

当前实现为 0.2 第二批内容快照与计划。唯一可执行入口为 src/wm.ts，公共命令位于 cli/wm-program，内置平台只在 platform/builtins 装配。

## 调用链

~~~text
wm CLI / SDK
  → PlanningService（共享捕获、修订、平台产物、冻结计划）
  → PublishingService（从计划执行、持久化写入、只读调用、回查）
  → AccountRepository.use（按真实身份锁定并读取当前会话代次）
  → Platform.withSession（连接一次、验证身份、复用会话）
  → 注册能力（probe → execute / inspect）
  → 各平台真实协议或浏览器流程
~~~

核心不再持有固定 draft/publish 接口、平台格式枚举或要求每个平台实现的列表全集。能力通过开放字符串 ID 注册，可声明 read 或 remote-write；读取和写入使用同一平台注册表。

## 契约所有权

core/capability 的工厂从同一份 Zod schema 推导处理器输入类型、输入边界校验和 JSON Schema。读取默认值在进入处理器前应用；成功的内部结果依靠类型契约，不重复逐字段验证。能力自行声明输入、输出、准备产物、探测、成功状态和真实处理器。

服务只保存不透明的准备产物，不解释标题、Markdown、封面、分类或话题。Markdown 导入位于 content/document，由文本平台选择使用；二进制平台通过 PreparationContext 捕获自己的内容。ObjectStore 以摘要发布完整字节并在读取边界检查完整性。产物保存稳定资产引用，进入驱动后才解析为本机对象路径。

## 身份与会话

AccountIdentity 由 platformId、平台 accountId 和确定的 bindingId 组成。别名仅索引身份，不能成为凭据或锁的所有者。任务保存身份快照；别名重绑不会将既有任务转发到其他账号。

登录先在私有临时目录建立会话，身份确认后关闭浏览器，在账号锁内保存新会话代次，再提交别名。错误账号和失败登录不能覆盖既有会话。同一真实账号的多个别名共享锁和当前会话代次。

~~~text
accounts/<bindingId>/account.json
accounts/<bindingId>/sessions/<sessionId>/
aliases/<platform>/<alias>.json
objects/<digest><extension>
revisions/<revisionId>.json
variants/<variantId>.json
plans/<planId>.json
jobs/<jobId>/job.json
~~~

新布局只通过登录建立。旧账号目录和旧任务格式不扫描、不读取、不迁移；历史文件不覆盖。

## 平台个性化

平台目录持有自己的选项 schema、内容准备、驱动与请求字段。公众号保留 HTML 排版、正文图、封面和保存回读；小红书保留短文、图集、话题、可见范围和创作者会话探测；掘金保留摘要、分类、标签、专栏和上传协议。

Skill 保留 wm 总入口，同时按平台加载 references/wechat、xiaohongshu、juejin。平台知识不混进核心，也不会因统一入口而丢失。

## 执行与验证

每个写能力都由服务包裹持久化步骤，避免自定义处理器遗漏回执后被重放。驱动还可以记录上传、草稿和提交等内部步骤。已完成步骤复用；网络或进程异常保留 unknown，显式业务拒绝才允许继续尝试。

当前仍沿用单机任务回执。独立的跨任务操作记录、步骤级权威回查和完整验证恢复按 [实施计划](PUBLISHING_CORE_IMPLEMENTATION.md) 后续批次实现。

## 内容与计划

PreparationContext 在同一准备批次复用文件捕获。ContentRevision 记录导入器、原始产物、资产与元数据；PreparedVariant 保存实际输出、摘要及渲染记录；PublishPlan 冻结输入、修订、平台产物、真实账号、驱动和当前能力执行入口。计划与产物只创建不覆盖，新任务格式不读取旧 tasks 布局。

计划身份采用稳定 JSON 序列化，排除账号别名、目标顺序、来源路径与驱动/CLI 版本。实际产物或修订变化才改变业务输入。相同内容在新驱动下仍找到旧计划，恢复时核对固定的驱动，不静默重编译或重发。公共快照层不继承任一平台的图片限制。

测试通过新账号和能力路径调用实际 HTTP 构造器与真实浏览器处理器，所有发布请求在测试中拦截。另有不带草稿能力的自定义平台、二进制载荷、资源种类、别名重绑、跨别名并发和连接关闭测试。线上验收与模拟页面验证分别记录。
