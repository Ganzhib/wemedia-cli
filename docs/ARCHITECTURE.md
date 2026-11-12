# 多平台发布的实现结构

当前实现为 0.2 第一批能力契约与账号身份。唯一可执行入口为 src/wm.ts，公共命令位于 cli/wm-program，内置平台只在 platform/builtins 装配。

## 调用链

~~~text
wm CLI / SDK
  → PublishingService（准备、持久化写入、只读调用、回查）
  → AccountRepository.use（按真实身份锁定并读取当前会话代次）
  → Platform.withSession（连接一次、验证身份、复用会话）
  → 注册能力（probe → execute / inspect）
  → 各平台真实协议或浏览器流程
~~~

核心不再持有固定 draft/publish 接口、平台格式枚举或要求每个平台实现的列表全集。能力通过开放字符串 ID 注册，可声明 read 或 remote-write；读取和写入使用同一平台注册表。

## 契约所有权

core/capability 的工厂从同一份 Zod schema 推导处理器输入类型、输入边界校验和 JSON Schema。读取默认值在进入处理器前应用；成功的内部结果依靠类型契约，不重复逐字段验证。能力自行声明输入、输出、准备产物、探测、成功状态和真实处理器。

服务只保存不透明的准备产物，不解释标题、Markdown、封面、分类或话题。Markdown 准备和源文件完整性校验位于 content/document，由文本平台选择使用；二进制平台可使用自己的契约。内容快照与完整发布计划属于下一批工作。

## 身份与会话

AccountIdentity 由 platformId、平台 accountId 和确定的 bindingId 组成。别名仅索引身份，不能成为凭据或锁的所有者。任务保存身份快照；别名重绑不会将既有任务转发到其他账号。

登录先在私有临时目录建立会话，身份确认后关闭浏览器，在账号锁内保存新会话代次，再提交别名。错误账号和失败登录不能覆盖既有会话。同一真实账号的多个别名共享锁和当前会话代次。

~~~text
accounts/<bindingId>/account.json
accounts/<bindingId>/sessions/<sessionId>/
aliases/<platform>/<alias>.json
tasks/<jobId>/job.json
~~~

新布局只通过登录建立。旧账号目录和旧任务格式不扫描、不读取、不迁移；历史文件不覆盖。

## 平台个性化

平台目录持有自己的选项 schema、内容准备、驱动与请求字段。公众号保留 HTML 排版、正文图、封面和保存回读；小红书保留短文、图集、话题、可见范围和创作者会话探测；掘金保留摘要、分类、标签、专栏和上传协议。

Skill 保留 wm 总入口，同时按平台加载 references/wechat、xiaohongshu、juejin。平台知识不混进核心，也不会因统一入口而丢失。

## 执行与验证

每个写能力都由服务包裹持久化步骤，避免自定义处理器遗漏回执后被重放。驱动还可以记录上传、草稿和提交等内部步骤。已完成步骤复用；网络或进程异常保留 unknown，显式业务拒绝才允许继续尝试。

当前仍沿用单机任务快照。独立的跨任务操作记录、资产快照、步骤级权威回查和完整验证恢复按 [实施计划](PUBLISHING_CORE_IMPLEMENTATION.md) 后续批次实现。

测试通过新账号和能力路径调用实际 HTTP 构造器与真实浏览器处理器，所有发布请求在测试中拦截。另有不带草稿能力的自定义平台、二进制载荷、资源种类、别名重绑、跨别名并发和连接关闭测试。线上验收与模拟页面验证分别记录。
