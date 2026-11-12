# 内容格式与场景

公共元数据为 title、brief 或 summary、author、cover、tags。各平台可以覆盖这些字段。图片路径相对 Markdown 文件；公众号和小红书使用本地图片，CLI 负责上传。掘金支持指定专栏 columns。

```yaml
---
title: 浏览器自动化实践
author: 作者
cover: ./cover.png
platforms:
  wechat:
    theme: default
    summary: 本文介绍浏览器自动化的实际流程。
  xiaohongshu:
    title: 浏览器自动化实践
    content: 根据文章准备的短文，不超过一千字。
    images:
      - ./cover.png
    tags:
      - 编程
  zhihu:
    declaration: ai_assisted
  juejin:
    category: "替换为查询返回的分类数字ID"
    tags: ["替换为查询返回的标签数字ID"]
    brief: 摘要需要按真实文章撰写，长度为五十到一百字。说明文章解决的问题、主要方法和实践结果，缺少必要资料时应向作者补充确认，不以占位文本替代真实摘要。
    columns: []
---
```

自然语言：把我的 Markdown 保存为公众号草稿，配图一起上传，完成后返回任务和草稿 ID。

自然语言：将确认过的文章发布到掘金和公众号，分别报告完成阶段；有平台失败时保留其他平台结果。

示例中的掘金分类、标签必须先通过注册查询取得真实数字字符串 ID，替换说明字段后才执行。完整文章和本地配图示例见仓库 examples/wm-publishing-core.md；不要公开发表空模板。
