import { chromium, type Page } from 'playwright';
import { ensureBrowser } from './managed-browser.js';

// Public/local media gets a fresh browser, never an account profile or session cookies.
export async function withMediaPage<T>(action: (page: Page) => Promise<T>) {
  await ensureBrowser();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', deviceScaleFactor: 1 });
    return await action(await context.newPage());
  } finally { await browser.close(); }
}
