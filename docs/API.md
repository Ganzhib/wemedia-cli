# 接口依据与验证记录

当前 wm 能力通过 `wm schema --json` 与 `wm platform list --json` 查询；以下保留掘金底层协议的历史依据，不是通用核心的接口全集。

记录日期：2026-11-11。以下是掘金网页接口，不是平台承诺兼容的开放 SDK。

## 公开读取

| 方法 | 路径 | 参数来源 |
| --- | --- | --- |
| GET | `/tag_api/v1/query_category_briefs` | 当前分类列表响应 |
| POST | `/tag_api/v1/query_tag_list` | `cursor`、`limit`，响应使用 `data[].tag` |
| POST | `/recommend_api/v1/article/recommend_all_feed` | 当前网页适配器，筛选文章类型 2/14 |
| POST | `/search_api/v1/search` | `key_word`、`cursor`、`limit`、`sort_type`、`search_type:0` |
| GET | `/content_api/v1/content/article_rank` | `category_id`、`type:hot` |
| POST | `/content_api/v1/article/detail` | `article_id`、`req_from:0`、`client_type:2608`、`forbid_count:true`、`is_pre_load:true` |
| GET | `/content_api/v1/column/detail` | `column_id` |
| POST | `/content_api/v1/column/self_center_list` | `user_id`、`audit_status:2`、`cursor`、`limit` |
| POST | `/content_api/v1/column/articles_cursor` | `column_id`、`cursor`、`limit`、`sort:0` |

`npm run smoke` 当前验证本地平台发现与能力 schema，不访问这些历史接口。分页命令返回服务端 cursor / has_more；标签名称搜索按返回游标翻页。

文章详情当前不能只传 `article_id`，否则返回参数错误。网页 preload 请求的 `req_from:0` 会返回 Markdown；`req_from:1` 在本次验证中仅返回元数据，正文为空。CLI 使用已验证的 preload 请求，并设置 `forbid_count:true` 避免查询增加阅读计数。

## 登录后的接口

| 操作 | 路径 | 协议要点 |
| --- | --- | --- |
| 验证当前用户 | `/user_api/v1/user/get` | GET，Cookie |
| 自己的文章 | `/content_api/v1/article/list_by_user` | POST，`page_no` / `page_size`，状态过滤为 null |
| 草稿列表 | `/content_api/v1/article_draft/list_by_user` | POST，`page_no` / `page_size` / `keyword` |
| 草稿详情 | `/content_api/v1/article_draft/detail` | POST，`draft_id`，读取 `data.article_draft` |
| 创建草稿 | `/content_api/v1/article_draft/create` | POST，`mark_content`，`edit_type:10` |
| 更新草稿 | `/content_api/v1/article_draft/update` | POST，ID 字段为 `id` |
| 发布文章 | `/content_api/v1/article/publish` | POST，`draft_id`、`column_ids`、`encrypted_word_count:0` |
| 自己的专栏 | `/content_api/v1/column/author_center_list` | POST，`audit_status:null` / `page_no` / `page_size` / `keyword` |
| 新建/修改专栏 | `/content_api/v1/column/publish` | POST，`column_id`、`title`、`content`、`cover`；创建 ID 为字符串 `"0"` |

专栏接口与参数直接核对了当前创作者页面 `https://juejin.cn/creator/content/column` 加载的脚本：`dd598f2.js`（接口封装）、`842a65f.js`（专栏管理列表）、`b590eaf.js`（新建/修改专栏表单）。当前表单规定标题不超过 50 字，简介不超过 150 字；创建返回 data 为专栏 ID，修改也可能进入审核。

草稿与图片链路参考 [liuleihang/juejin-skills](https://github.com/liuleihang/juejin-skills)，文章发布的项目间字段描述存在差异。首版采用该项目近期使用的 `encrypted_word_count:0`；这部分需要账号实测，不能以离线测试替代平台成功证明。

## 图片

`imagex/v2/gen_token` → ImageX `ApplyImageUpload` → TOS POST 文件体（CRC32）→ ImageX `CommitImageUpload` → `imagex/v2/get_img_url`。

ImageX 使用临时凭据与 AWS SigV4；上传主机只接收临时上传授权，不接收掘金账号 Cookie。所有阶段均不自动重试。离线集成测试覆盖整条请求链，实际服务端接受情况需要登录后进一步验证。

## 验证边界

- 离线测试验证请求字段、错误边界、精度、Markdown 改写与输出协议。
- 公开读取由 smoke 脚本验证。
- 尚未以真实账号执行登录、传图、草稿写入、专栏新建/修改或文章发布。没有生成或发布任何测试文章。
- MCP、评论/沸点写入、专栏删除与文章排序不在当前版本范围。

## 签到与抽奖（2026-11-12）

协议核对来源为官方签到页和抽奖页实际加载的 `dd598f2.js`、`0525240.js` 与 `795bd59.js`。规则直接由 `get_rules_text` / `lottery_config/rules_text` 获取，奖励不写死在命令中。

| 方法 | 路径 | 用途及参数 |
| --- | --- | --- |
| GET | `/growth_api/v1/get_today_status` | 已登录今日状态，data 为 boolean |
| GET | `/growth_api/v1/get_counts` | `cont_count` / `sum_count` |
| GET | `/growth_api/v1/get_by_month` | 本月日历 |
| GET | `/growth_api/v1/get_by_near` | 上月日历，不能当成任意月份查询 |
| GET | `/growth_api/v1/get_cur_point` | 矿石余额，data 为 number |
| GET | `/growth_api/v1/get_cur_supp` | 补签卡数量，data 为 number |
| POST | `/growth_api/v1/check_in` | `{}`，返回 `incr_point` / `sum_point` |
| POST | `/growth_api/v1/get_by_supp` | 补签预览，`date` 为北京时间目标日的 Unix 秒 |
| POST | `/growth_api/v1/check_in_supp` | 补签，`{date}` |
| GET | `/growth_api/v1/lottery_config/get` | `lottery` / `free_count` / `point_cost` |
| POST | `/growth_api/v1/lottery/draw` | 单抽，`{}`；免费与付费共用 |
| POST | `/growth_api/v1/lottery/ten_draw` | 十连抽，`{}` |
| POST | `/growth_api/v1/lottery_history/obj_by_page` | `page_no`、`got_channel:"1"`，data 内 `lottery_histories` / `count` |
| POST | `/growth_api/v1/lottery_lucky/my_lucky` | 查询幸运值 |
| POST | `/growth_api/v1/lottery_lucky/dip_lucky` | `lottery_history_id` |
| POST | `/growth_api/v1/lottery_lucky/lucky_draw` | 幸运值抽奖 |

`v2/get_today_status` 在未登录时也可能返回成功和 `check_in_done:false`。CLI 使用要求登录的 v1 查询，不把 v2 成功响应当作已认证。

已登录真实只读验证覆盖今日状态、连续/累计天数、本月与上月日历、矿石余额、补签卡、幸运值、中奖记录。抽奖配置的直连请求实际返回 HTTP 200 空响应；使用官方抽奖页面的正常安全 SDK 环境可以读取。运行时按领域加载对应官方页面，再通过页面 fetch 请求，原始响应文本交回同一个 JuejinHttp 解析；不复制安全令牌或实现签名算法，不在失败后切换传输重发写入。

中奖历史接口原始响应包含收件信息，SDK 显式投影奖品字段。离线夹具仅使用虚构账号和奖品数据。真实签到、补签或抽奖的执行结果应单独记录，不能从只读和离线通过推断。
