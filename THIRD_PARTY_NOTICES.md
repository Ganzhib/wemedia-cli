# Third-party notices

## autoclaw-cc/xiaohongshu-skills

The account navigation selectors, image-text composer workflow and the documented
`xhs-publish-btn` publish event in `src/platform/xiaohongshu/adapter.ts` are adapted
from commit `b043748282a57e347c52f517dfb59819121134ab` of
https://github.com/autoclaw-cc/xiaohongshu-skills.
The implementation is ported to TypeScript/Playwright, with response-based note IDs,
durable task receipts, account isolation and no successful fallback after timeout.
The complete MIT license is retained in `licenses/xiaohongshu-skills-MIT.txt`.

## JimLiu/baoyu-skills

The WeChat article editor insertion, image placeholder workflow and draft-save
signals in `src/platform/wechat/adapter.ts` are adapted from
`skills/baoyu-post-to-wechat/scripts/wechat-article.ts`, commit
`ca703c2d7c2c4399a1dc0cf82224f8551e05a96d`, at
https://github.com/JimLiu/baoyu-skills.
The implementation uses Playwright-managed profiles, sanitized rendered HTML,
cover selection, readback and task receipts, without external clipboard tools.
The complete MIT license is retained in `licenses/baoyu-skills-MIT.txt`.

## caol64/wenyan-core

WeChat rendering uses the npm dependency `@wenyan-md/core` version 3.0.6 from
https://github.com/caol64/wenyan-core under Apache-2.0. Its license and dependency
notices are distributed with the npm dependency. Browser workflow code is maintained
by this project; the renderer's draft API is not presented as formal publication.

## liuleihang/juejin-skills

The ImageX protocol, AWS SigV4 signing construction, CRC32 upload flow, and
observed upload-host fallback in `src/platform/juejin/imagex.ts` are adapted from:

https://github.com/liuleihang/juejin-skills/blob/main/scripts/upload-images.mjs

The implementation was rewritten in TypeScript with explicit API boundaries,
injected transports, and no automatic request replay. The original license and
additional notice follow unchanged:

MIT License

Copyright (c) 2026 Hone

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## Additional Notice（附加声明）

1. **无关联声明**：本项目与掘金（juejin.cn）、字节跳动及其关联公司无任何隶属、合作或背书关系。
2. **接口风险**：掘金未提供官方公开 API，本项目基于社区抓包核实的非官方接口实现，随时可能因平台变更而失效；因使用本项目产生的一切风险与后果由使用者自行承担。
3. **使用边界**：请遵守目标平台服务条款与社区规范；本项目提供的发布能力默认草稿优先并要求显式确认，不得用于垃圾内容分发、批量灌水或绕过平台风控。
4. **凭据安全**：使用者应妥善保管本地会话凭据（`~/.juejin/session.json`），勿分享、勿提交至任何仓库；因凭据泄露导致的账号损失由使用者自行负责。
