# 构建与 npm 发布

当前包名为 @ganzhibin/wemedia-cli，二进制为 wm。源码安装使用 npm ci 和 npm link。发布前运行类型检查、测试、构建和真实归档安装检查。

```bash
npm run check
npm test
npm run test:browser
npm run check:package
npm pack
```

check:package 在临时目录从实际 tgz 安装，验证依赖、wm 入口、schema、认证边界及 Skill 首次运行补装。它不会登录或向平台写入。打包文件白名单包括 dist、skills、licenses、docs、README 和第三方声明，不包括账号 Profile 与任务目录。

首次发布由 npm 包所有者登录 npm 后运行 `npm publish --access public --tag alpha`，并完成动态验证码验证。在 npm 包设置中，添加 GitHub Actions Trusted Publisher：账号 `Ganzhib`、仓库 `wemedia-cli`、工作流文件 `publish.yml`，允许 `npm publish`。

后续更新 `package.json` 和 `package-lock.json` 中的版本并推送到 `main` 或 `master`。`.github/workflows/publish.yml` 会先运行发布检查，仅在 npm 尚无该版本时发布。两个分支共用串行发布队列；同步同一版本时会跳过已发布的版本。预发布版本使用版本后缀对应的标签，例如 `alpha`；不带预发布后缀的版本使用 `latest`。发布使用 GitHub OIDC，不需要仓库保存 npm token。请在 npm registry 核对版本和标签后再通知使用者。
