import type { RecoveryState, StepRecovery } from './workflow.js';
import type { Capability } from './capability.js';
import type { AccountProfile, AccountScope, CapabilityAvailability, OperationContext, RemoteObservation, RemoteReference, SessionProfile } from './types.js';
import { CliError } from '../shared/errors.js';

export interface PlatformSession {
  profile: AccountProfile;
  probe(capabilityId: string): Promise<CapabilityAvailability>;
  read(capabilityId: string, input: unknown, context: OperationContext): Promise<unknown>;
  executeStep(capabilityId: string, handlerId: string, input: unknown, dependencies: unknown, context: OperationContext): Promise<unknown>;
  recoverStep(capabilityId: string, handlerId: string, input: unknown, dependencies: unknown, state: RecoveryState, context: OperationContext): Promise<StepRecovery>;
  inspect(capabilityId: string, remote: RemoteReference, prepared: unknown, context: OperationContext): Promise<RemoteObservation>;
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
          read: (id, input, context) => {
            const capability = get(id);
            if (capability.effect !== 'read') throw new Error('A write capability requires a workflow');
            return capability.execute({ ...context, session }, input);
          },
          executeStep: (id, handlerId, input, dependencies, context) => {
            const capability = get(id);
            if (capability.effect !== 'remote-write') throw new Error('A read capability has no workflow');
            const handler = capability.handlers.get(handlerId);
            if (!handler) throw new CliError('UNSUPPORTED', '工作流处理器不存在。');
            return handler.execute({ ...context, session }, input, dependencies);
          },
          recoverStep: async (id, handlerId, input, dependencies, state, context) => {
            const capability = get(id);
            if (capability.effect !== 'remote-write') throw new Error('A read capability has no recovery');
            const handler = capability.handlers.get(handlerId)!;
            if (!handler.recover) return { verdict: 'indeterminate', evidence: { source: 'driver', message: '此步骤没有可用的回查证据。' } };
            return handler.recover({ ...context, session }, input, dependencies, state);
          },
          inspect: (id, remote, prepared, context) => {
            const capability = get(id);
            if (capability.effect !== 'remote-write' || !capability.inspect) throw new CliError('UNSUPPORTED', '此能力尚未实现结果回查。');
            return capability.inspect({ ...context, session }, remote, prepared);
          },
        });
      }).catch(error => {
        if (error instanceof CliError && error.code === 'AUTH') throw new CliError('AUTH', error.message, {
          ...error.details, reason: 'authentication_required', required_identity: account.identity, required_action: 'login',
          next_action: { command: 'wm', args: ['auth', 'login', definition.id, '--binding', account.identity.bindingId] },
        });
        throw error;
      });
    },
  };
}
