# 构建与归档验证

当前包名为 @ganzhibin/wemedia-cli，二进制为 wm。源码安装使用 npm ci 和 npm link。发布前运行类型检查、测试、构建和真实归档安装检查。

```bash
npm run check
npm test
npm run test:browser
npm run check:package
npm pack
```

check:package 在临时目录从实际 tgz 安装，验证依赖、wm 入口、schema、认证边界及 Skill 首次运行补装。它不会登录或向平台写入。打包文件白名单包括 dist、skills、licenses、docs、README 和第三方声明，不包括账号 Profile 与任务目录。

源仓库自动发布 npm 和 Pages 的工作流已移除。此项目尚未发布 npm；创建发布凭据和上传 npm 需要单独安排，普通代码提交只运行 CI。
