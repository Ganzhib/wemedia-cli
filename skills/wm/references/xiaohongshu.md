# 小红书

处理小红书时读取本页，并查询 wm platform capabilities xiaohongshu --json。登录使用 wm auth login xiaohongshu；主站身份与创作者中心会话都参与流程。主站已经登录不保证创作者中心可用。

当前开放 content.publish 和 article.list。只支持图文，不支持视频或可回查的持久化草稿，不能把填写页面或上传图片报告为已发布。

标题最多 20 个 Unicode 码点，正文为 1–1000 个码点，图片为 1–18 张本地文件，话题最多 10 个。为长文章准备平台短文，保留原文；不要由 CLI 静默截断。话题必须成为平台正式话题节点，单纯写入井号文字不算完成。

~~~yaml
platforms:
  xiaohongshu:
    title: 为这个平台准备的短标题
    content: 对应的短文正文
    images: [./cover.png, ./detail.png]
    tags: [编程]
    visibility: 公开可见
~~~

可见范围由实际 schema 枚举决定。不要将用户要求的私密发布替换为公开。图片顺序、短文和话题是平台版本内容的一部分。

~~~bash
wm article preview article.md --platform xiaohongshu --json
wm article publish article.md --platform xiaohongshu --json
wm article list --platform xiaohongshu --json
~~~

发布使用站内编辑器及真实提交响应，不提取或伪造签名。submitted 表示平台受理，笔记 ID 用于后续回查；列表暂时没有此 ID 可能是审核或展示延迟，不能据此再次发布。
