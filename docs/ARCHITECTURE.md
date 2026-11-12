# 多平台发布的实现结构

wm 的命令入口是 src/wm.ts，命令树与内置平台装配位于 src/cli/wm-program.ts。CLI、SDK 和 Skill 共用同一组实际处理器，schema 从 Commander 命令树生成。

```text
cli/wm-program → services/publishing → core/types 与 platform adapter
                                        ├─ platform/juejin
                                        ├─ platform/xiaohongshu
                                        └─ platform/wechat

content/document：元数据、源文件指纹和平台资产清单
runtime/accounts：平台及账号隔离
runtime/storage：原子保存、持久化与文件锁
runtime/managed-browser：受管理浏览器、导航错误与关闭生命周期
```

公共 content 和 runtime 不导入具体平台协议。掘金原有的会话、写作服务、签到和浏览器传输已迁至 platform/juejin，公共图片处理不再受到掘金上传限制约束。

平台通过 operations 注册写能力，通过 lists 注册读能力。注册表直接描述这些处理器，不维护第二份能力列表。新增平台需实现其适配器并在 composition root 注册，无需修改公共任务调度。

PublishingService 先准备全部目标，再按平台账号锁执行。写入步骤开始前持久化 running，结束后保存结果；意外退出后 running 被视为 unknown。成功步骤可在恢复时复用，明确业务拒绝可以通过显式 resume 再执行，网络和程序错误不会自动重放。源文件及图片摘要改变后旧任务拒绝继续。

账号元数据、浏览器 Profile、任务计划与回执使用独立目录和私有权限。业务账号 ID 与用户别名分别保存。日常操作重新验证账号，不能把同名别名下的另一个账号当作原账号。

公众号使用文颜 core 3.0.6 渲染、DOMPurify 清理进入已登录编辑器的 HTML，再通过平台编辑器上传图片和保存。选择未引入 Mermaid 依赖的版本，避免将与当前图文流程无关的运行时和已知问题带入安装包。小红书将已调研的浏览器流程移植到 Playwright，保留站内安全 SDK，通过真实响应获取笔记 ID，不提取或伪造签名。

设计目标与后续扩展说明见 [完整设计](MULTIPLATFORM_ARCHITECTURE.md)，账号验证与写入验收边界见 [验收记录](../LIVE_ACCEPTANCE.md)。
