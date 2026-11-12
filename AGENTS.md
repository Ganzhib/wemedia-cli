# Development conventions

- Trace the shared mechanism and affected call chain before changing behavior. Keep platform requests, authentication, selectors and types in `src/platform/<platform>/`; common content and runtime modules must not import concrete platform implementations.
- `src/wm.ts` is the wm executable entry. Register commands and assemble built-in adapters in `src/cli/wm-program.ts`. Do not instantiate a process-global command tree. `src/cli.ts` and the original command modules remain for upstream regression coverage.
- `src/services/publishing.ts` owns cross-platform tasks, account locks and durable step receipts. Put content parsing and asset discovery in `src/content/`, storage, browser lifecycle and Skill installation in `src/runtime/`, and platform workflows inside each adapter. Juejin's original writing service stays under `src/platform/juejin/`.
- Generate command metadata from the same Commander definitions via `schema`; do not maintain a second command schema by hand. Use the package root from `src/package.ts` when locating bundled assets.
- Trust typed successful platform responses. Handle business error codes and nullable `data` at the HTTP boundary; validate user files and command arguments at their input boundaries.
- Never automatically replay writes after an exception or timeout. Preserve operation receipts and return existing draft/column IDs on failures.
- Keep account cookies local, out of logs, fixtures, commits and upload-host requests. Offline tests must use fabricated credentials.
- JSON mode emits one JSON document on stdout for success or stderr for failure. Diagnostic messages go to stderr.
- Branch names: `ganzhibin/<feature|bugfix|hotfix|refactor|chore|docs|test>/<english-description>`. Check current and existing branches before creation.
- Commit messages: `<type>(<scope>): <中文描述>`, using `feat`, `fix`, `refactor`, `chore`, `docs`, or `test` according to the actual change.
- Run `npm run check`, `npm test`, and `npm run build` before committing. Public network smoke tests are opt-in (`npm run smoke`); they perform no authenticated writes.
- Run `npm run test:browser` after browser workflow changes and `npm run check:package` after executable, dependency or Skill packaging changes. Browser fixtures intercept all requests; authenticated publication requires explicit content and destination authorization.
- Default onboarding requires only platform login. The CLI owns browser setup and all routine UI operations. Do not require users to extract cookies, configure developer credentials, install an extension manually, or start a separate service.
- Preserve the upstream attribution in `THIRD_PARTY_NOTICES.md` when editing ImageX signing/upload code.
