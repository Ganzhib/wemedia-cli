import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { AccountScope, OperationContext, RemoteReference, OperationResult } from '../core/types.js';
import type { PlatformRegistry } from '../core/registry.js';
import { parseInput } from '../core/validation.js';
import { validateWorkflow } from '../core/workflow.js';
import { AccountRepository } from '../runtime/accounts.js';
import { readJson, withFileLock, writeJson } from '../runtime/storage.js';
import { PlanningService, type PlanTarget } from './planning.js';
import { PreparationContext } from '../content/preparation.js';
import { PublicationService } from './publications.js';
import { OperationRepository, WorkflowExecutor, operationId, type OperationRecord, type StepRecord } from './operations.js';
import { CliError } from '../shared/errors.js';

const jobIndexSchema = z.object({ schema: z.literal(4), id: z.string().regex(/^[a-f0-9]{32}$/), planId: z.string(), createdAt: z.string() });
export type TargetJob = PlanTarget & {
  operationId: string; status: string; steps: Record<string, StepRecord>;
  remote?: RemoteReference;
  message?: string; data?: OperationResult['data'];
  observation?: OperationRecord['observations'][number];
};
export interface PublishJob { schema: 4; id: string; planId: string; createdAt: string; capabilityId: string; targets: TargetJob[]; diagnostics: { reason: string; operationId?: string }[] }
export type { StepRecord } from './operations.js';
export { parseTarget } from './planning.js';
function jobName(value: string): string {
  if (!/^[a-f0-9]{32}$/.test(value)) throw new CliError('INPUT', '无效任务 ID。');
  return value;
}
export class PublishingService {
  readonly accounts: AccountRepository; readonly planning: PlanningService; readonly operations: OperationRepository; readonly publications: PublicationService;
  private readonly executor: WorkflowExecutor;
  constructor(readonly home: string, readonly registry: PlatformRegistry) {
    this.accounts = new AccountRepository(home); this.planning = new PlanningService(home, registry);
    this.operations = new OperationRepository(home); this.executor = new WorkflowExecutor(this.operations); this.publications = new PublicationService(home);
  }
  private file(id: string) { return join(this.home, 'jobs', jobName(id), 'job.json'); }
  private project(target: PlanTarget, id: string, operation?: OperationRecord): TargetJob {
    return { ...target, operationId: id, status: operation?.result?.status ?? operation?.status ?? 'planned', steps: operation?.steps ?? {},
      remote: operation?.result?.remote ?? operation?.references.at(-1), message: operation?.message, data: operation?.result?.data, observation: operation?.observations.at(-1) };
  }
  async get(id: string): Promise<PublishJob> {
    const stored = await readJson(this.file(id));
    if (!stored) throw new CliError('INPUT', '找不到当前格式的任务。', { job_id: id });
    const index = parseInput(jobIndexSchema, stored);
    if (index.id !== id) throw new CliError('INPUT', '任务 ID 不匹配。');
    const plan = await this.planning.get(index.planId);
    const targets = [];
    for (const target of plan.targets) { const id = operationId(plan, target); targets.push(this.project(target, id, await this.operations.find(id))); }
    return { ...index, capabilityId: plan.capabilityId, targets, diagnostics: [] };
  }
  prepare(capabilityId: string, input: unknown, targets: string[]) { return this.planning.prepare(capabilityId, input, targets); }
  async create(capabilityId: string, input: unknown, destinations: string[], newCopy = false): Promise<PublishJob> { return this.start((await this.planning.create(capabilityId, input, destinations, newCopy)).id); }
  async start(planId: string): Promise<PublishJob> {
    const plan = await this.planning.get(planId); const id = createHash('sha256').update(plan.id).digest('hex').slice(0, 32);
    return withFileLock(join(this.home, 'jobs', id + '.lock'), async () => {
      if (!await readJson(this.file(id))) await writeJson(this.file(id), { schema: 4, id, planId: plan.id, createdAt: new Date().toISOString() });
      return this.get(id);
    });
  }
  private context(account: AccountScope, record: OperationRecord): OperationContext {
    return { account, artifacts: this.planning.objects, remember: async remote => {
      if (!record.references.some(existing => JSON.stringify(existing) === JSON.stringify(remote))) record.references.push(remote);
      await this.operations.save(record);
    } };
  }
  private async projection(job: PublishJob): Promise<void> {
    for (const target of job.targets) {
      const record = await this.operations.find(target.operationId);
      if (!record) continue;
      try { await this.publications.update(record); }
      catch { job.diagnostics.push({ reason: 'publication_index_failed', operationId: record.id }); }
    }
    try { await writeJson(join(this.home, 'jobs', job.id, 'summary.json'), job); }
    catch { job.diagnostics.push({ reason: 'summary_projection_failed' }); }
    try { await appendFile(join(this.home, 'jobs', job.id, 'events.jsonl'), JSON.stringify({ time: new Date().toISOString(), operations: job.targets.map(target => ({ id: target.operationId, status: target.status })) }) + '\n', { mode: 0o600 }); }
    catch { job.diagnostics.push({ reason: 'event_log_failed' }); }
  }
  async run(id: string): Promise<PublishJob> {
    return withFileLock(join(this.home, 'jobs', jobName(id) + '.lock'), async () => {
      const job = await this.get(id); const plan = await this.planning.get(job.planId);
      for (const target of plan.targets) {
        const capability = this.registry.capability(target.identity.platformId, plan.capabilityId);
        if (capability.effect !== 'remote-write') throw new CliError('INPUT', '计划未引用写入能力。');
        const record = await this.operations.find(operationId(plan, target));
        if (record?.result && capability.successStates.includes(record.result.status)) continue;
        const platform = this.registry.get(target.identity.platformId);
        const frozen = record?.target ?? target;
        if (platform.driver.id !== frozen.driver.id || platform.driver.version !== frozen.driver.version) throw new CliError('INPUT', '计划驱动版本已改变。');
        validateWorkflow(record?.workflow ?? target.workflow, capability.handlers);
        const { prepared } = await this.planning.variant(frozen);
        await capability.preflight(parseInput(capability.preparedSchema, prepared), this.planning.objects);
      }
      for (let index = 0; index < plan.targets.length; index++) {
        const target = plan.targets[index]; const platform = this.registry.get(target.identity.platformId);
        const capability = this.registry.capability(platform.id, plan.capabilityId);
        if (capability.effect !== 'remote-write') throw new Error('Validated plan contains a read capability');
        try {
          await this.accounts.use(target.identity, account => this.operations.use(plan, target, async record => {
            if (!record.result || !capability.successStates.includes(record.result.status)) {
              if (record.target.driver.id !== platform.driver.id || record.target.driver.version !== platform.driver.version) throw new CliError('INPUT', '原操作驱动版本不匹配。');
              await platform.withSession(account, async session => {
                const availability = await session.probe(plan.capabilityId);
                if (availability.state === 'unavailable') throw new CliError('AUTH', availability.reason);
                await this.executor.run(record, capability, session, this.context(account, record));
              });
            }
            job.targets[index] = this.project(target, record.id, record);
          }));
        } catch (error) {
          const record = await this.operations.find(operationId(plan, target));
          job.targets[index] = this.project(target, operationId(plan, target), record);
          if (!record?.result) { job.targets[index].status = record?.status === 'running' ? 'unknown' : (record?.status === 'planned' ? 'rejected' : record?.status) ?? 'rejected'; job.targets[index].message = error instanceof Error ? error.message : String(error); }
        }
      }
      await this.projection(job); return job;
    });
  }
  async invoke(platformId: string, alias: string, capabilityId: string, input: unknown, newCopy = false) {
    const capability = this.registry.capability(platformId, capabilityId);
    if (capability.effect === 'remote-write') return { effect: capability.effect, value: await this.run((await this.create(capabilityId, input, [platformId + ':' + alias], newCopy)).id) } as const;
    const prepared = await capability.prepare(input, new PreparationContext(this.home)); const identity = await this.accounts.resolve(platformId, alias);
    const value = await this.accounts.use(identity, account => this.registry.get(platformId).withSession(account, async session => {
      const availability = await session.probe(capabilityId); if (availability.state === 'unavailable') throw new CliError('AUTH', availability.reason);
      return session.read(capabilityId, prepared, { account, artifacts: this.planning.objects, remember: async () => { throw new Error('Read capability cannot record a write'); } });
    }));
    return { effect: 'read', value } as const;
  }
  async refresh(id: string): Promise<PublishJob> {
    return withFileLock(join(this.home, 'jobs', jobName(id) + '.lock'), async () => {
      const job = await this.get(id); const plan = await this.planning.get(job.planId);
      for (let index = 0; index < plan.targets.length; index++) {
        const target = plan.targets[index]; const capability = this.registry.capability(target.identity.platformId, plan.capabilityId);
        if (capability.effect !== 'remote-write' || !capability.inspect) continue;
        const existing = await this.operations.find(operationId(plan, target)); if (!existing) continue;
        const remote = existing.result?.remote ?? existing.references.at(-1); if (!remote) continue;
        try {
          const platform = this.registry.get(target.identity.platformId);
          if (platform.driver.id !== existing.target.driver.id || platform.driver.version !== existing.target.driver.version) throw new CliError('INPUT', '回查所需驱动版本不匹配。');
          const { prepared } = await this.planning.variant(existing.target); const payload = parseInput(capability.preparedSchema, prepared);
          await this.accounts.use(target.identity, account => this.operations.use(plan, target, record => platform.withSession(account, async session => {
            const result = await session.inspect(plan.capabilityId, remote, payload, this.context(account, record));
            record.observations.push({ time: new Date().toISOString(), result }); await this.operations.save(record);
            job.targets[index] = this.project(target, record.id, record);
          })));
        } catch (error) { job.targets[index].message = error instanceof Error ? error.message : String(error); }
      }
      await this.projection(job); return job;
    });
  }
}
