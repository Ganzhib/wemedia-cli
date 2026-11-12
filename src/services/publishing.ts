import { randomUUID, createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { AccountScope, OperationContext } from '../core/types.js';
import { accountIdentitySchema, outcomeSchema, remoteReferenceSchema } from '../core/types.js';
import type { PlatformRegistry } from '../core/registry.js';
import { parseInput } from '../core/capability.js';
import { AccountRepository, validateName } from '../runtime/accounts.js';
import { readJson, withFileLock, writeJson } from '../runtime/storage.js';
import { CliError } from '../shared/errors.js';

const stepSchema = z.object({ phase: z.enum(['running', 'done', 'rejected', 'unknown', 'waiting_for_verification']), value: z.unknown().optional() });
const targetSchema = z.object({
  identity: accountIdentitySchema, alias: z.string(), driver: z.object({ id: z.string(), version: z.string() }),
  prepared: z.unknown(), steps: z.record(z.string(), stepSchema), status: z.union([z.literal('planned'), z.literal('running'), outcomeSchema]),
  remote: remoteReferenceSchema.optional(), message: z.string().optional(),
  data: z.json().optional(),
});
const jobSchema = z.strictObject({ schema: z.literal(2), id: z.string().regex(/^[a-f0-9]{32}$/), createdAt: z.string(), capabilityId: z.string(), targets: z.array(targetSchema) });
export type PublishJob = z.infer<typeof jobSchema>;
export type TargetJob = z.infer<typeof targetSchema>;
export type StepRecord = z.infer<typeof stepSchema>;
const uncertain = (steps: TargetJob['steps']) => Object.values(steps).some(step => ['running', 'unknown', 'waiting_for_verification'].includes(step.phase));

export function parseTarget(value: string) {
  const parts = value.split(':');
  if (parts.length > 2) throw new CliError('INPUT', '目标格式应为 platform:account。');
  return { platform: validateName(parts[0]), alias: validateName(parts[1] ?? 'main') };
}
function jobName(value: string): string {
  if (!/^[a-f0-9]{32}$/.test(value)) throw new CliError('INPUT', '无效任务 ID。');
  return value;
}
function readContext(account: AccountScope): OperationContext {
  return { account, step: async () => { throw new Error('Read capability cannot start a write step'); }, remember: async () => { throw new Error('Read capability cannot record a write'); } };
}

export class PublishingService {
  readonly accounts: AccountRepository;
  constructor(readonly home: string, readonly registry: PlatformRegistry) { this.accounts = new AccountRepository(home); }
  private file(id: string) { return join(this.home, 'tasks', jobName(id), 'job.json'); }
  private save(job: PublishJob) { return writeJson(this.file(job.id), job); }
  async get(id: string): Promise<PublishJob> {
    const value = await readJson(this.file(id));
    if (!value) throw new CliError('INPUT', '找不到当前格式的任务：' + id);
    const job = parseInput(jobSchema, value);
    if (job.id !== id) throw new CliError('INPUT', '任务 ID 不匹配。');
    return job;
  }
  async prepare(capabilityId: string, input: unknown, targets: string[]) {
    if (!targets.length) throw new CliError('INPUT', '至少指定一个目标平台。');
    const prepared: { platform: string; alias: string; prepared: unknown }[] = [];
    for (const value of [...new Set(targets)]) {
      const target = parseTarget(value);
      if (prepared.some(entry => entry.platform === target.platform && entry.alias === target.alias)) continue;
      const capability = this.registry.capability(target.platform, capabilityId);
      prepared.push({ ...target, prepared: await capability.prepare(input) });
    }
    return prepared;
  }
  async create(capabilityId: string, input: unknown, destinations: string[], newCopy = false): Promise<PublishJob> {
    const prepared = await this.prepare(capabilityId, input, destinations);
    const targets: TargetJob[] = [];
    for (const target of prepared) {
      const capability = this.registry.capability(target.platform, capabilityId);
      if (capability.effect !== 'remote-write') throw new CliError('INPUT', '只读能力无需创建写入任务。');
      const identity = await this.accounts.resolve(target.platform, target.alias);
      if (targets.some(entry => entry.identity.bindingId === identity.bindingId)) continue;
      targets.push({ identity, alias: target.alias, driver: { ...this.registry.get(target.platform).driver }, prepared: target.prepared, steps: {}, status: 'planned' });
    }
    const identity = targets.map(({ identity, prepared }) => ({ identity, prepared })).sort((a, b) => a.identity.bindingId.localeCompare(b.identity.bindingId));
    const id = createHash('sha256').update(JSON.stringify({ capabilityId, targets: identity, nonce: newCopy ? randomUUID() : '' })).digest('hex').slice(0, 32);
    return withFileLock(join(this.home, 'tasks', id + '.lock'), async () => {
      if (await readJson(this.file(id))) return this.get(id);
      const job: PublishJob = { schema: 2, id, createdAt: new Date().toISOString(), capabilityId, targets };
      await this.save(job);
      return job;
    });
  }
  private async event(job: PublishJob, target: TargetJob, stage: string, phase: string) {
    await appendFile(join(this.home, 'tasks', job.id, 'events.jsonl'), JSON.stringify({
      time: new Date().toISOString(), binding_id: target.identity.bindingId, stage, phase,
    }) + '\n', { mode: 0o600 });
  }
  private context(job: PublishJob, target: TargetJob, account: AccountScope): OperationContext {
    return {
      account, remember: async remote => { target.remote = remote; await this.save(job); },
      step: async <T>(name: string, action: () => Promise<T>): Promise<T> => {
        const previous = target.steps[name];
        if (previous?.phase === 'done') return previous.value as T;
        if (previous && ['running', 'unknown', 'waiting_for_verification'].includes(previous.phase)) throw new CliError('UNKNOWN', '上次写入尚未确认，不会重发。', { job_id: job.id, step: name });
        target.steps[name] = { phase: 'running' };
        await this.save(job);
        await this.event(job, target, name, 'started');
        let value: T;
        try { value = await action(); }
        catch (error) {
          let phase: StepRecord['phase'] = 'unknown';
          if (error instanceof CliError && error.details?.outcome === 'rejected') phase = 'rejected';
          if (error instanceof CliError && error.code === 'VERIFICATION') phase = 'waiting_for_verification';
          target.steps[name] = { phase };
          await this.save(job);
          await this.event(job, target, name, phase);
          throw error;
        }
        target.steps[name] = { phase: 'done', value };
        try { await this.save(job); await this.event(job, target, name, 'confirmed'); }
        catch { throw new CliError('UNKNOWN', '远端步骤已完成，本地回执保存异常，请勿重复提交。', { job_id: job.id, step: name }); }
        return value;
      },
    };
  }
  async run(id: string): Promise<PublishJob> {
    return withFileLock(join(this.home, 'tasks', jobName(id) + '.lock'), async () => {
      const job = await this.get(id);
      // Validate all pending payloads before the first session or write, without rereading completed sources.
      for (const target of job.targets) {
        const platform = this.registry.get(target.identity.platformId);
        const capability = this.registry.capability(platform.id, job.capabilityId);
        if (capability.effect !== 'remote-write') throw new CliError('INPUT', '任务引用的能力不是写入能力。');
        if (capability.successStates.some(state => state === target.status)) continue;
        if (platform.driver.id !== target.driver.id || platform.driver.version !== target.driver.version) throw new CliError('INPUT', '任务驱动版本已改变，请先核对原任务。');
        target.prepared = parseInput(capability.preparedSchema, target.prepared);
        await capability.preflight(target.prepared);
      }
      for (const target of job.targets) {
        const platform = this.registry.get(target.identity.platformId);
        const capability = this.registry.capability(platform.id, job.capabilityId);
        if (capability.effect !== 'remote-write') throw new CliError('INPUT', '任务引用的能力不是写入能力。');
        if (capability.successStates.some(state => state === target.status)) continue;
        if (uncertain(target.steps)) { target.status = 'unknown'; target.message = '存在未确认的写入，请先运行 wm job refresh。'; await this.save(job); continue; }
        try {
          await this.accounts.use(target.identity, account => platform.withSession(account, async session => {
            const availability = await session.probe(job.capabilityId);
            if (availability.state === 'unavailable') throw new CliError('AUTH', availability.reason);
            target.status = 'running'; delete target.message;
            await this.save(job);
            const context = this.context(job, target, account);
            // The outer receipt protects even a custom capability which performs a single direct write.
            const result = await context.step('capability.execute', async () => {
              const result = await session.execute(job.capabilityId, target.prepared, context);
              if (result.effect !== 'remote-write') throw new Error('Write capability returned a read result');
              return result.value;
            });
            target.status = result.status; target.remote = result.remote; target.message = result.message; target.data = result.data;
            await this.save(job);
          }));
        } catch (error) {
          target.status = uncertain(target.steps) ? 'unknown' : 'rejected';
          if (error instanceof CliError && error.code === 'UNKNOWN') target.status = 'unknown';
          if (error instanceof CliError && error.code === 'VERIFICATION') target.status = 'waiting_for_verification';
          target.message = error instanceof Error ? error.message : String(error);
          await this.save(job);
        }
      }
      return job;
    });
  }
  async invoke(platformId: string, alias: string, capabilityId: string, input: unknown, newCopy = false) {
    const capability = this.registry.capability(platformId, capabilityId);
    if (capability.effect === 'remote-write') return { effect: capability.effect, value: await this.run((await this.create(capabilityId, input, [platformId + ':' + alias], newCopy)).id) } as const;
    const prepared = await capability.prepare(input);
    const identity = await this.accounts.resolve(platformId, alias);
    const value = await this.accounts.use(identity, account => this.registry.get(platformId).withSession(account, async session => {
      const availability = await session.probe(capabilityId);
      if (availability.state === 'unavailable') throw new CliError('AUTH', availability.reason);
      return (await session.execute(capabilityId, prepared, readContext(account))).value;
    }));
    return { effect: 'read', value } as const;
  }
  async refresh(id: string): Promise<PublishJob> {
    return withFileLock(join(this.home, 'tasks', jobName(id) + '.lock'), async () => {
      const job = await this.get(id);
      for (const target of job.targets) {
        const capability = this.registry.capability(target.identity.platformId, job.capabilityId);
        if (!target.remote || capability.effect !== 'remote-write' || !capability.inspect) continue;
        try {
          const platform = this.registry.get(target.identity.platformId);
          if (platform.driver.id !== target.driver.id || platform.driver.version !== target.driver.version) throw new CliError('INPUT', '回查所需驱动版本不匹配。');
          target.prepared = parseInput(capability.preparedSchema, target.prepared);
          await this.accounts.use(target.identity, account => this.registry.get(target.identity.platformId).withSession(account, async session => {
            const result = await session.inspect(job.capabilityId, target.remote!, target.prepared, readContext(account));
            target.status = uncertain(target.steps) && !capability.successStates.includes(result.status) ? 'unknown' : result.status;
            target.remote = result.remote; target.message = result.message;
            await this.save(job);
          }));
        } catch (error) { target.message = error instanceof Error ? error.message : String(error); await this.save(job); }
      }
      return job;
    });
  }
}
