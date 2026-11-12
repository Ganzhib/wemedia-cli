import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, errors, type BrowserContext, type Page } from 'playwright';
import { installBrowser } from './browser.js';
import { CliError } from '../shared/errors.js';

export async function navigatePlatform(page: Page, url: string): Promise<void> {
  await navigation(() => page.goto(url, { waitUntil: 'domcontentloaded' }), new URL(url).hostname);
}

export async function reloadPlatform(page: Page): Promise<void> {
  await navigation(() => page.reload({ waitUntil: 'domcontentloaded' }), new URL(page.url()).hostname);
}

async function navigation(action: () => Promise<unknown>, host: string): Promise<void> {
  try { await action(); }
  catch (error) {
    const knownNavigationFailure = error instanceof errors.TimeoutError || (error instanceof Error && /net::ERR_|NS_ERROR_|Target page, context or browser has been closed/.test(error.message));
    if (!knownNavigationFailure) throw error;
    // Authenticated editor URLs contain tokens. Report only the host, never the navigation URL.
    throw new CliError('NETWORK', '浏览器无法连接平台，请检查本机网络后重新发起读取；写入不会自动重试。', { host });
  }
}

let preparation: Promise<void> | undefined;
export async function ensureBrowser(): Promise<void> {
  preparation ??= (async () => {
    try { await access(chromium.executablePath()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      process.stderr.write('正在准备登录浏览器…\n');
      await installBrowser();
    }
  })();
  await preparation;
}

export async function withAccountBrowser<T>(account: { directory: string }, action: (context: BrowserContext, page: Page) => Promise<T>): Promise<T> {
  await ensureBrowser();
  const context = await chromium.launchPersistentContext(join(account.directory, 'browser-profile'), {
    headless: false, viewport: { width: 1440, height: 1000 },
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(20_000);
    return await action(context, page);
  } finally { await context.close(); }
}
