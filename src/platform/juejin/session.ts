import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Cookie } from 'playwright';
import { z } from 'zod';
import { parseInput } from '../../core/capability.js';
import { CliError } from '../../shared/errors.js';
import { JuejinHttp } from './http.js';

export function cookieHeader(cookies: Cookie[]): string {
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

function isJuejinDomain(domain: string): boolean {
  return domain === 'juejin.cn' || domain.endsWith('.juejin.cn');
}

export interface UserProfile { user_id: string; user_name: string }

export class SessionStore {
  readonly path: string;
  constructor(readonly home: string) {
    this.path = join(home, 'session.json');
  }

  async load(): Promise<Cookie[]> {
    let content: string;
    try {
      content = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      throw new CliError('AUTH', '尚未登录，请运行 wm auth login juejin。');
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
}

const cookiesSchema = z.array(z.object({
  name: z.string(), value: z.string(), domain: z.string(), path: z.string(), expires: z.number(),
  httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(['Strict', 'Lax', 'None']),
  partitionKey: z.string().optional(),
}));

export function parseCookies(content: string): Cookie[] {
  let value: unknown;
  try { value = JSON.parse(content); }
  catch { throw new CliError('INPUT', '会话文件必须为有效的 Cookie 数组 JSON。'); }
  const cookies = parseInput(cookiesSchema, value).filter(cookie => isJuejinDomain(cookie.domain) && (cookie.expires <= 0 || cookie.expires > Date.now() / 1000));
  for (const cookie of cookies) {
    if (/[\r\n;]/.test(cookie.name) || /[\r\n;]/.test(cookie.value)) throw new CliError('INPUT', 'Cookie 含非法字符。');
  }
  if (!cookies.some(cookie => cookie.name === 'sessionid' || cookie.name === 'sessionid_ss')) throw new CliError('AUTH', '未找到有效的掘金会话，请重新登录。');
  return cookies;
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
