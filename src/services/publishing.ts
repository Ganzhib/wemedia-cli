import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { AccountScope, OperationContext } from '../core/types.js';
import { accountIdentitySchema, outcomeSchema, remoteReferenceSchema } from '../core/types.js';
import type { PlatformRegistry } from '../core/registry.js';
import { parseInput } from '../core/capability.js';
import { AccountRepository } from '../runtime/accounts.js';
import { readJson, withFileLock, writeJson } from '../runtime/storage.js';
import { PlanningService } from './planning.js';
import { PreparationContext } from '../content/preparation.js';
import { CliError } from '../shared/errors.js';

const stepSchema = z.object({ phase: z.enum(['running', 'done', 'rejected', 'unknown', 'waiting_for_verification']), value: z.unknown().optional() });
const targetSchema = z.object({
  identity: accountIdentitySchema, alias: z.string(), driver: z.object({ id: z.string(), version: z.string() }),
  variantId: z.string(), revisionId: z.string(), contentDigest: z.string(), workflow: z.object({ id: z.string(), version: z.string(), steps: z.array(z.string()) }), steps: z.record(z.string(), stepSchema), status: z.union([z.literal('planned'), z.literal('running'), outcomeSchema]),
  remote: remoteReferenceSchema.optional(), message: z.string().optional(),
  data: z.json().optional(),
});
const jobSchema = z.strictObject({ schema: z.literal(3), planId: z.string(), id: z.string().regex(/^[a-f0-9]{32}$/), createdAt: z.string(), capabilityId: z.string(), targets: z.array(targetSchema) });
export type PublishJob = z.infer<typeof jobSchema>;
export type TargetJob = z.infer<typeof targetSchema>;
export type StepRecord = z.infer<typeof stepSchema>;
const uncertain = (steps: TargetJob['steps']) => Object.values(steps).some(step => ['running', 'unknown', 'waiting_for_verification'].includes(step.phase));

export { parseTarget } from './planning.js';
function jobName(value: string): string {
  if (!/^[a-f0-9]{32}$/.test(value)) throw new CliError('INPUT', '无效任务 ID。');
  return value;
}
function readContext(account: AccountScope, artifacts: OperationContext['artifacts']): OperationContext {
  return { account, artifacts, step: async () => { throw new Error('Read capability cannot start a write step'); }, remember: async () => { throw new Error('Read capability cannot record a write'); } };
}

export class PublishingService {
  readonly accounts: AccountRepository;
  readonly planning: PlanningService;
  constructor(readonly home: string, readonly registry: PlatformRegistry) { this.accounts = new AccountRepository(home); this.planning = new PlanningService(home, registry); }
  private file(id: string) { return join(this.home, 'jobs', jobName(id), 'job.json'); }
  private save(job: PublishJob) { return writeJson(this.file(job.id), job); }
  async get(id: string): Promise<PublishJob> {
    const value = await readJson(this.file(id));
    if (!value) throw new CliError('INPUT', '找不到当前格式的任务：' + id);
    const job = parseInput(jobSchema, value);
    if (job.id !== id) throw new CliError('INPUT', '任务 ID 不匹配。');
    return job;
  }
  prepare(capabilityId: string, input: unknown, targets: string[]) { return this.planning.prepare(capabilityId, input, targets); }
  async create(capabilityId: string, input: unknown, destinations: string[], newCopy = false): Promise<PublishJob> {
    return this.start((await this.planning.create(capabilityId, input, destinations, newCopy)).id);
  }
  async start(planId: string): Promise<PublishJob> {
    const plan = await this.planning.get(planId);
    const id = createHash('sha256').update(plan.id).digest('hex').slice(0, 32);
    return withFileLock(join(this.home, 'jobs', id + '.lock'), async () => {
      if (await readJson(this.file(id))) return this.get(id);
      const targets = plan.targets.map(target => ({ ...target, steps: {}, status: 'planned' as const }));
      const job: PublishJob = { schema: 3, id, planId: plan.id, createdAt: new Date().toISOString(), capabilityId: plan.capabilityId, targets };
      await this.save(job);
      return job;
    });
  }
  private async event(job: PublishJob, target: TargetJob, stage: string, phase: string) {
    await appendFile(join(this.home, 'jobs', job.id, 'events.jsonl'), JSON.stringify({
      time: new Date().toISOString(), binding_id: target.identity.bindingId, stage, phase,
    }) + '\n', { mode: 0o600 });
  }
  private context(job: PublishJob, target: TargetJob, account: AccountScope): OperationContext {
    return {
      account, artifacts: this.planning.objects, remember: async remote => { target.remote = remote; await this.save(job); },
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
    return withFileLock(join(this.home, 'jobs', jobName(id) + '.lock'), async () => {
      const job = await this.get(id);
      const plan = await this.planning.get(job.planId);
      if (job.capabilityId !== plan.capabilityId || job.targets.length !== plan.targets.length || new Set(job.targets.map(target => target.identity.bindingId)).size !== job.targets.length) throw new CliError('INPUT', '任务范围与冻结计划不一致。');
      const preparedTargets = new Map<string, unknown>();
      // Validate all pending payloads before the first session or write, without rereading completed sources.
      for (const target of job.targets) {
        const platform = this.registry.get(target.identity.platformId);
        const capability = this.registry.capability(platform.id, job.capabilityId);
        if (capability.effect !== 'remote-write') throw new CliError('INPUT', '任务引用的能力不是写入能力。');
        if (capability.successStates.some(state => state === target.status)) continue;
        if (platform.driver.id !== target.driver.id || platform.driver.version !== target.driver.version) throw new CliError('INPUT', '任务驱动版本已改变，请先核对原任务。');
        const frozen = plan.targets.find(entry => entry.identity.bindingId === target.identity.bindingId);
        if (!frozen || frozen.variantId !== target.variantId || frozen.driver.id !== target.driver.id || frozen.driver.version !== target.driver.version) throw new CliError('INPUT', '任务目标与冻结计划不一致。');
        const { prepared } = await this.planning.variant(frozen);
        const payload = parseInput(capability.preparedSchema, prepared);
        await capability.preflight(payload, this.planning.objects);
        preparedTargets.set(target.identity.bindingId, payload);
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
              const result = await session.execute(job.capabilityId, preparedTargets.get(target.identity.bindingId), context);
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
    const prepared = await capability.prepare(input, new PreparationContext(this.home));
    const identity = await this.accounts.resolve(platformId, alias);
    const value = await this.accounts.use(identity, account => this.registry.get(platformId).withSession(account, async session => {
      const availability = await session.probe(capabilityId);
      if (availability.state === 'unavailable') throw new CliError('AUTH', availability.reason);
      return (await session.execute(capabilityId, prepared, readContext(account, this.planning.objects))).value;
    }));
    return { effect: 'read', value } as const;
  }
  async refresh(id: string): Promise<PublishJob> {
    return withFileLock(join(this.home, 'jobs', jobName(id) + '.lock'), async () => {
      const job = await this.get(id);
      for (const target of job.targets) {
        const capability = this.registry.capability(target.identity.platformId, job.capabilityId);
        if (!target.remote || capability.effect !== 'remote-write' || !capability.inspect) continue;
        try {
          const platform = this.registry.get(target.identity.platformId);
          if (platform.driver.id !== target.driver.id || platform.driver.version !== target.driver.version) throw new CliError('INPUT', '回查所需驱动版本不匹配。');
          const plan = await this.planning.get(job.planId);
          const frozen = plan.targets.find(entry => entry.identity.bindingId === target.identity.bindingId)!;
          const { prepared } = await this.planning.variant(frozen);
          const payload = parseInput(capability.preparedSchema, prepared);
          await this.accounts.use(target.identity, account => this.registry.get(target.identity.platformId).withSession(account, async session => {
            const result = await session.inspect(job.capabilityId, target.remote!, payload, readContext(account, this.planning.objects));
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
