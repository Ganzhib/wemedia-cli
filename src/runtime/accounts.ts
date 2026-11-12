import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import type { AccountProfile } from '../core/types.js';
import { CliError } from '../shared/errors.js';
import { readJson, writeJson, withFileLock } from './storage.js';

export function wmHome(): string { return resolve(process.env.WM_HOME ?? join(homedir(), '.config', 'wemedia-cli')); }

export function validateName(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw new CliError('INPUT', '名称须为 1–64 位小写英文、数字或连字符。');
  return value;
}

export class AccountStore {
  readonly directory: string;
  constructor(readonly home: string, readonly platform: string, readonly alias = 'main') {
    this.directory = join(home, 'accounts', validateName(platform), validateName(alias));
  }
  lock<T>(action: () => Promise<T>): Promise<T> { return withFileLock(join(this.directory, 'write.lock'), action); }
  profile(): Promise<AccountProfile | undefined> { return readJson(join(this.directory, 'account.json')); }
  save(profile: AccountProfile): Promise<void> { return writeJson(join(this.directory, 'account.json'), profile); }
  async verify(profile: AccountProfile): Promise<AccountProfile> {
    const expected = await this.profile();
    if (expected && expected.id !== profile.id) {
      throw new CliError('AUTH', '当前登录账号与此别名绑定的账号不同，请使用新别名重新登录。', { expected: expected.name, actual: profile.name });
    }
    return profile;
  }
}

export async function listAccounts(home: string): Promise<{ platform: string; alias: string; profile: AccountProfile }[]> {
  const root = join(home, 'accounts');
  let platforms;
  try { platforms = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const accounts = [];
  for (const platform of platforms.filter(entry => entry.isDirectory())) {
    const aliases = await readdir(join(root, platform.name), { withFileTypes: true });
    for (const alias of aliases.filter(entry => entry.isDirectory())) {
      const profile = await new AccountStore(home, platform.name, alias.name).profile();
      if (profile) accounts.push({ platform: platform.name, alias: alias.name, profile });
    }
  }
  return accounts;
}
