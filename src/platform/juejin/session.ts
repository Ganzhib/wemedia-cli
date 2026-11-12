import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Cookie } from 'playwright';
import { CliError } from '../../shared/errors.js';
import { JuejinHttp } from './http.js';
import { withFileLock } from '../../runtime/storage.js';

export function defaultHome(): string {
  return process.env.JUEJIN_HOME ?? join(homedir(), '.config', 'juejin-cli');
}

export function cookieHeader(cookies: Cookie[]): string {
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

function isJuejinDomain(domain: string): boolean {
  return domain === 'juejin.cn' || domain.endsWith('.juejin.cn');
}

export interface UserProfile { user_id: string; user_name: string }

export class SessionStore {
  readonly path: string;
  constructor(readonly home = defaultHome()) {
    this.path = join(home, 'session.json');
  }

  async load(required = true): Promise<Cookie[]> {
    let content: string;
    try {
      content = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (required) throw new CliError('AUTH', '尚未登录，请运行 juejin auth login。');
      return [];
    }
    return parseCookies(content);
  }

  async save(cookies: Cookie[]): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(cookies, null, 2), { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async clear(): Promise<void> { await rm(this.path, { force: true }); }

  withWriteLock<T>(action: () => Promise<T>): Promise<T> {
    return withFileLock(join(this.home, 'write.lock'), action);
  }

}

export function parseCookies(content: string): Cookie[] {
  let source: unknown;
  try { source = JSON.parse(content); }
  catch { throw new CliError('INPUT', '会话文件必须为 Playwright cookies 数组或 storageState JSON。'); }
  const cookies = Array.isArray(source) ? source : (source as { cookies?: unknown } | null)?.cookies;
  if (!Array.isArray(cookies)) throw new CliError('INPUT', '会话文件缺少 cookies 数组。');
  const result: Cookie[] = [];
  for (const cookie of cookies) {
    // Imported files are untrusted input; only platform cookies may reach the API host.
    if (typeof cookie?.name !== 'string' || typeof cookie.value !== 'string' || typeof cookie.domain !== 'string') {
      throw new CliError('INPUT', 'Cookie 必须包含 name、value、domain 字符串。');
    }
    if (!isJuejinDomain(cookie.domain)) continue;
    if (/[\r\n;]/.test(cookie.name) || /[\r\n;]/.test(cookie.value)) throw new CliError('INPUT', 'Cookie 含非法字符。');
    if (cookie.expires > 0 && cookie.expires <= Date.now() / 1000) continue;
    result.push({
      name: cookie.name, value: cookie.value, domain: cookie.domain,
      path: cookie.path ?? '/', expires: cookie.expires ?? -1,
      httpOnly: cookie.httpOnly ?? false, secure: cookie.secure ?? true, sameSite: cookie.sameSite ?? 'Lax',
    });
  }
  if (!result.some(cookie => cookie.name === 'sessionid' || cookie.name === 'sessionid_ss')) {
    throw new CliError('AUTH', '未找到有效的掘金 sessionid，请重新登录。');
  }
  return result;
}

export async function verifySession(cookies: Cookie[]): Promise<UserProfile> {
  return new JuejinHttp({ cookie: cookieHeader(cookies) }).data<UserProfile>('/user_api/v1/user/get');
}

export async function login(store: SessionStore, timeoutMs = 300_000): Promise<UserProfile> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('https://juejin.cn/login', { waitUntil: 'domcontentloaded' });
    process.stderr.write('请在浏览器中完成掘金登录。\n');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!browser.isConnected() || page.isClosed()) throw new CliError('AUTH', '登录窗口已关闭，会话未保存。');
      const cookies = await context.cookies(['https://juejin.cn', 'https://api.juejin.cn']);
      if (cookies.some(cookie => cookie.name === 'sessionid' || cookie.name === 'sessionid_ss')) {
        const profile = await verifySession(cookies);
        await store.save(cookies);
        return profile;
      }
      await delay(1000);
    }
    throw new CliError('AUTH', '等待登录超时，会话未保存。');
  } finally {
    await browser.close();
  }
}
