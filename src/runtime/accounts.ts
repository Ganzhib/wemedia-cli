import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { AccountBinding, AccountIdentity, AccountProfile, AccountScope } from '../core/types.js';
import { accountBindingSchema, accountIdentitySchema } from '../core/types.js';
import { parseInput } from '../core/capability.js';
import { CliError } from '../shared/errors.js';
import { readJson, writeJson, withFileLock } from './storage.js';

export function wmHome(): string { return resolve(process.env.WM_HOME ?? join(homedir(), '.config', 'wemedia-cli')); }
export function validateName(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw new CliError('INPUT', '名称须为 1–64 位小写英文、数字或连字符。');
  return value;
}
function identityFor(platformId: string, accountId: string): AccountIdentity {
  const bindingId = createHash('sha256').update(JSON.stringify([platformId, accountId])).digest('hex').slice(0, 32);
  return { bindingId, platformId, accountId };
}

export class AccountRepository {
  constructor(readonly home: string) {}
  private directory(bindingId: string) { return join(this.home, 'accounts', bindingId); }
  private aliasFile(platformId: string, alias: string) { return join(this.home, 'aliases', validateName(platformId), validateName(alias) + '.json'); }
  async resolve(platformId: string, alias = 'main'): Promise<AccountIdentity> {
    const identity = await this.find(platformId, alias);
    if (!identity) throw new CliError('AUTH', '账号别名尚未登录，请运行 wm auth login ' + platformId + ' --account ' + alias);
    return identity;
  }
  async find(platformId: string, alias = 'main'): Promise<AccountIdentity | undefined> {
    const value = await readJson(this.aliasFile(platformId, alias));
    if (value === undefined) return undefined;
    const identity = parseInput(accountIdentitySchema, value);
    if (identity.platformId !== platformId) throw new CliError('INPUT', '账号别名记录的平台不匹配。');
    return identity;
  }
  async binding(identity: AccountIdentity): Promise<AccountBinding> {
    const value = await readJson(join(this.directory(identity.bindingId), 'account.json'));
    if (!value) throw new CliError('AUTH', '账号绑定不存在，请重新登录。');
    const binding = parseInput(accountBindingSchema, value);
    if (binding.identity.bindingId !== identity.bindingId || binding.identity.platformId !== identity.platformId || binding.identity.accountId !== identity.accountId) throw new CliError('AUTH', '保存的账号身份与目标不一致。');
    return binding;
  }
  use<T>(identity: AccountIdentity, action: (account: AccountScope) => Promise<T>): Promise<T> {
    return withFileLock(join(this.directory(identity.bindingId), 'write.lock'), async () => {
      // Resolve the current session generation only after acquiring the stable account lock.
      const binding = await this.binding(identity);
      return action({ identity, directory: join(this.directory(identity.bindingId), 'sessions', binding.sessionId) });
    });
  }
  async login(platformId: string, alias: string, authenticate: (directory: string) => Promise<AccountProfile>): Promise<AccountBinding> {
    const file = this.aliasFile(platformId, alias);
    return withFileLock(file + '.lock', async () => {
      const expected = await this.find(platformId, alias);
      const sessionId = randomUUID();
      const staging = join(this.home, 'login', sessionId);
      await mkdir(staging, { recursive: true, mode: 0o700 });
      try {
        const profile = await authenticate(staging);
        if (expected && profile.id !== expected.accountId) throw new CliError('AUTH', '此别名已绑定另一个账号，请使用新别名登录。');
        const identity = identityFor(platformId, profile.id);
        return await withFileLock(join(this.directory(identity.bindingId), 'write.lock'), async () => {
          const sessions = join(this.directory(identity.bindingId), 'sessions');
          await mkdir(sessions, { recursive: true, mode: 0o700 });
          await rename(staging, join(sessions, sessionId));
          // A fresh generation is committed atomically; failed authentication never overwrites a working session.
          const binding: AccountBinding = { schema: 2, identity, name: profile.name, sessionId };
          await writeJson(join(this.directory(identity.bindingId), 'account.json'), binding);
          await writeJson(file, identity);
          return binding;
        });
      } finally { await rm(staging, { recursive: true, force: true }); }
    });
  }
  async alias(platformId: string, source: string, alias: string, replace = false): Promise<AccountIdentity> {
    const identity = await this.resolve(platformId, source);
    const file = this.aliasFile(platformId, alias);
    return withFileLock(file + '.lock', async () => {
      if (!replace && await readJson(file)) throw new CliError('INPUT', '目标别名已存在；明确重绑时使用 --replace。');
      await writeJson(file, identity);
      return identity;
    });
  }
  async list(): Promise<{ platform: string; alias: string; binding: AccountBinding }[]> {
    const root = join(this.home, 'aliases');
    let platforms;
    try { platforms = await readdir(root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const accounts = [];
    for (const platform of platforms.filter(entry => entry.isDirectory())) {
      const aliases = await readdir(join(root, platform.name));
      for (const file of aliases.filter(file => file.endsWith('.json'))) {
        const alias = file.slice(0, -5);
        const identity = await this.resolve(platform.name, alias);
        accounts.push({ platform: platform.name, alias, binding: await this.binding(identity) });
      }
    }
    return accounts;
  }
}
