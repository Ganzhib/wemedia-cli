import { operationResultSchema } from '../src/core/types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TestContext } from 'node:test';
import { z } from 'zod';
import { stepHandler } from '../src/core/workflow.js';
import { definePlatform } from '../src/core/platform.js';
import { readCapability, writeCapability, workflowCapability } from '../src/core/capability.js';
import type { CapabilityContext, OperationResult } from '../src/core/types.js';
import { AccountRepository } from '../src/runtime/accounts.js';
import { readJson, writeJson } from '../src/runtime/storage.js';
import { PlatformRegistry } from '../src/core/registry.js';
import { PublishingService } from '../src/services/publishing.js';

export interface TestSession { profile: { id: string; name: string }; directory: string }
const payloadSchema = z.strictObject({ body: z.string().min(1) });
export function platformFixture(id: string, execute: (context: CapabilityContext<TestSession>, payload: z.infer<typeof payloadSchema>) => Promise<OperationResult>, settings: {
  inspect?: () => Promise<OperationResult>; observedId?: string; upload?: () => Promise<{ id: string }>;
} = {}) {
  const counts = { sessions: 0, closes: 0 };
  const platform = definePlatform<TestSession>({
    id, name: id, driver: { id: id + '.test', version: '2' },
    login: async directory => { const profile = { id: id + '-id', name: id }; await writeJson(join(directory, 'profile.json'), profile); return profile; },
    withSession: async (account, action) => {
      counts.sessions++;
      const profile = (await readJson<TestSession['profile']>(join(account.directory, 'profile.json')))!;
      try { return await action({ profile: { ...profile, id: settings.observedId ?? profile.id }, directory: account.directory }); }
      finally { counts.closes++; }
    },
    capabilities: [
      settings.upload ? workflowCapability<TestSession>()({
        id: 'newsletter.send', description: 'Send newsletter', acceptance: { offline: true, liveRead: false, liveWrite: false },
        input: payloadSchema, prepared: payloadSchema, output: operationResultSchema, successStates: ['published'], prepare: async input => input, preflight: async () => undefined,
        compile: input => ({ id: 'newsletter.send', version: '1', resultStep: 'send', steps: [
          { id: 'upload', handler: 'upload', version: '1', needs: [], input: {} },
          { id: 'send', handler: 'send', version: '1', needs: ['upload'], input },
        ] }),
        handlers: {
          upload: stepHandler<TestSession>()({ version: '1', effect: 'remote-write', input: z.strictObject({}), dependencies: z.strictObject({}), output: z.object({ id: z.string() }), execute: settings.upload }),
          send: stepHandler<TestSession>()({ version: '1', effect: 'remote-write', input: payloadSchema, dependencies: z.object({ upload: z.object({ id: z.string() }) }), output: operationResultSchema, execute }),
        },
      }) : writeCapability<TestSession>()({
        id: 'newsletter.send', description: 'Send a newsletter', acceptance: { offline: true, liveRead: false, liveWrite: false },
        input: payloadSchema, prepared: payloadSchema, output: operationResultSchema, successStates: ['published'], prepare: async input => input,
        preflight: async () => undefined, execute, ...(settings.inspect ? { inspect: settings.inspect } : {}),
      }),
      readCapability<TestSession>()({
        id: 'newsletter.metrics', description: 'Metrics', acceptance: { offline: true, liveRead: false, liveWrite: false },
        input: z.strictObject({}), output: z.object({ total: z.number(), enabled: z.boolean() }),
        execute: async () => ({ total: 0, enabled: false }),
      }),
    ],
  });
  return { platform, counts };
}
export async function fixture(t: TestContext, platforms: ReturnType<typeof platformFixture>[]) {
  const home = await mkdtemp(join(tmpdir(), 'wm-core-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const accounts = new AccountRepository(home);
  for (const { platform } of platforms) await accounts.login(platform.id, 'main', directory => platform.login(directory));
  const registry = new PlatformRegistry(platforms.map(entry => entry.platform));
  return { home, accounts, registry, service: new PublishingService(home, registry) };
}
