import type { Capability } from './capability.js';
import type { AccountProfile, AccountScope, CapabilityAvailability, OperationContext, OperationResult, RemoteReference, SessionProfile } from './types.js';
import { CliError } from '../shared/errors.js';

export interface PlatformSession {
  profile: AccountProfile;
  probe(capabilityId: string): Promise<CapabilityAvailability>;
  execute(capabilityId: string, prepared: unknown, context: OperationContext): Promise<
    { effect: 'read'; value: unknown } | { effect: 'remote-write'; value: OperationResult }
  >;
  inspect(capabilityId: string, remote: RemoteReference, prepared: unknown, context: OperationContext): Promise<OperationResult>;
}
export interface Platform {
  id: string; name: string; driver: { id: string; version: string };
  capabilities: ReadonlyMap<string, Capability<never>>;
  login(directory: string): Promise<AccountProfile>;
  withSession<T>(account: AccountScope, action: (session: PlatformSession) => Promise<T>): Promise<T>;
}

export function definePlatform<S extends SessionProfile>(definition: {
  id: string; name: string; driver: { id: string; version: string };
  capabilities: Capability<S>[];
  login(directory: string): Promise<AccountProfile>;
  withSession<T>(account: AccountScope, action: (session: S) => Promise<T>): Promise<T>;
}): Platform {
  const capabilities = new Map<string, Capability<S>>();
  for (const capability of definition.capabilities) {
    if (capabilities.has(capability.id)) throw new Error('Duplicate capability: ' + capability.id);
    capabilities.set(capability.id, capability);
  }
  const get = (id: string) => {
    const capability = capabilities.get(id);
    if (!capability) throw new CliError('UNSUPPORTED', '平台未实现此能力：' + id);
    return capability;
  };
  return {
    id: definition.id, name: definition.name, driver: definition.driver, capabilities,
    login: definition.login,
    withSession: (account, action) => {
      if (account.identity.platformId !== definition.id) throw new CliError('AUTH', '账号绑定与目标平台不一致。');
      return definition.withSession(account, async session => {
        if (session.profile.id !== account.identity.accountId) throw new CliError('AUTH', '会话身份与绑定账号不一致，操作已停止。');
        // Captured typed sessions allow discovery, probing and execution to reuse one verified connection.
        return action({
          profile: session.profile,
          probe: id => get(id).probe(session),
          execute: async (id, prepared, context) => {
            const capability = get(id);
            if (capability.effect === 'remote-write') return { effect: capability.effect, value: await capability.execute({ ...context, session }, prepared) };
            return { effect: capability.effect, value: await capability.execute({ ...context, session }, prepared) };
          },
          inspect: (id, remote, prepared, context) => {
            const capability = get(id);
            if (capability.effect !== 'remote-write' || !capability.inspect) throw new CliError('UNSUPPORTED', '此能力尚未实现结果回查。');
            return capability.inspect({ ...context, session }, remote, prepared);
          },
        });
      });
    },
  };
}
