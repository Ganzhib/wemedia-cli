import { readFile } from 'node:fs/promises';
import { installBrowser } from '../../runtime/browser.js';
import { login, parseCookies, verifySession } from '../../platform/juejin/session.js';
import type { CommandContext } from '../context.js';

export function registerAuth(context: CommandContext): void {
  const auth = context.program.command('auth').description('管理本地登录会话');
  auth.command('setup').description('安装当前 CLI 版本使用的 Chromium').action(async () => {
    await installBrowser(!context.globals().json);
    context.emit({ browser: 'chromium', installed: true });
  });
  auth.command('login').description('打开浏览器登录（先运行 juejin auth setup）').action(async () => {
    const session = context.session();
    context.emit(await session.withWriteLock(() => login(session)));
  });
  auth.command('status').description('向掘金验证当前会话').action(async () => {
    context.emit(await verifySession(await context.session().load()));
  });
  auth.command('import').description('导入 Playwright Cookie/StorageState JSON 并验证').requiredOption('--file <path>', '会话文件').action(async (options: { file: string }) => {
    const session = context.session();
    context.emit(await session.withWriteLock(async () => {
      const cookies = parseCookies(await readFile(options.file, 'utf8'));
      const profile = await verifySession(cookies);
      await session.save(cookies);
      return profile;
    }));
  });
  auth.command('logout').description('删除本地会话').action(async () => {
    const session = context.session();
    await session.withWriteLock(() => session.clear());
    context.emit({ logged_out: true });
  });
}
