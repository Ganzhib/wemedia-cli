import { chromium } from 'playwright';
import { JuejinHttp } from './http.js';
import { SessionStore } from './session.js';

// Growth endpoints require the official page's security SDK. Use its normal fetch path, without extracting or forging signatures.
export async function withBrowserHttp<T>(session: SessionStore, action: (http: JuejinHttp) => Promise<T>, pageKind: 'signin' | 'lottery' = 'signin'): Promise<T> {
  const cookies = await session.load();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addCookies(cookies);
    const page = await context.newPage();
    // Each activity initializes its own protected request context; use the matching official page.
    await page.goto('https://juejin.cn/user/center/' + pageKind, { waitUntil: 'load', timeout: 30_000 });
    const browserFetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      url.searchParams.set('aid', '2608');
      url.searchParams.set('spider', '0');
      const response = await page.evaluate(async request => {
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (request.body !== undefined) headers['Content-Type'] = 'application/json';
        const result = await fetch(request.url, {
          method: request.method, body: request.body, headers,
          credentials: 'include', signal: AbortSignal.timeout(30_000),
        });
        return { status: result.status, body: await result.text() };
      }, { url: url.href, method: init!.method!, body: init!.body as string | undefined });
      // Keep text intact so JuejinHttp can preserve 19-digit numeric IDs.
      return new Response(response.body, { status: response.status });
    };
    return await action(new JuejinHttp({ fetch: browserFetch }));
  } finally {
    await browser.close();
  }
}
