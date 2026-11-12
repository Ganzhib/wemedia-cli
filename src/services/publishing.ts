import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Intent, OperationContext, OperationResult, PreparedArticle, RemoteReference } from '../core/types.js';
import type { PlatformRegistry } from '../core/registry.js';
import { digest, readDocument } from '../content/document.js';
import { AccountStore, validateName } from '../runtime/accounts.js';
import { readJson, withFileLock, writeJson } from '../runtime/storage.js';
import { CliError } from '../shared/errors.js';
import { VERSION } from '../package.js';

export interface StepRecord { phase: 'running' | 'done' | 'rejected' | 'unknown' | 'waiting_for_verification'; value?: unknown }
export interface TargetJob {
  platform: string;
  account: string;
  driver: string;
  version: string;
  article: PreparedArticle;
  steps: Record<string, StepRecord>;
  status: 'planned' | 'running' | OperationResult['status'];
  remote?: RemoteReference;
  message?: string;
}
export interface PublishJob {
  schema: 1;
  id: string;
  createdAt: string;
  source: { file: string; digest: string };
  intent: Intent;
  targets: TargetJob[];
}

export function parseTarget(value: string): { platform: string; account: string } {
  const parts = value.split(':');
  if (parts.length > 2) throw new CliError('INPUT', '目标格式应为 platform:account。');
  return { platform: validateName(parts[0]), account: validateName(parts[1] ?? 'main') };
}

function jobName(value: string): string {
  if (!/^[a-f0-9]{32}$/.test(value)) throw new CliError('INPUT', '无效任务 ID。');
  return value;
}

export class PublishingService {
  constructor(readonly home: string, readonly registry: PlatformRegistry) {}

  private file(id: string): string { return join(this.home, 'jobs', jobName(id), 'job.json'); }
  private save(job: PublishJob): Promise<void> { return writeJson(this.file(job.id), job); }

  async get(id: string): Promise<PublishJob> {
    const job = await readJson<PublishJob>(this.file(id));
    if (!job) throw new CliError('INPUT', '找不到任务：' + id);
    if (job.schema !== 1 || job.id !== id) throw new CliError('INPUT', '任务文件版本或 ID 不匹配。');
    return job;
  }

  async prepare(file: string, targets: string[], intent: Intent, overrides: Record<string, unknown> = {}) {
    if (!targets.length) throw new CliError('INPUT', '至少指定一个目标平台。');
    const document = await readDocument(file);
    const prepared: TargetJob[] = [];
    for (const value of [...new Set(targets)]) {
      const target = parseTarget(value);
      const adapter = this.registry.get(target.platform);
      if (!adapter.operations[intent]) throw new CliError('UNSUPPORTED', adapter.name + ' 当前不支持此操作：' + intent);
      if (prepared.some(entry => entry.platform === target.platform && entry.account === target.account)) continue;
      const options = { ...document.metadata, ...document.platforms[target.platform], ...overrides };
      const article = await adapter.prepare(document, options);
      prepared.push({ ...target, driver: adapter.driver, version: adapter.version, article, steps: {}, status: 'planned' });
    }
    return { document, targets: prepared };
  }

  async create(file: string, targets: string[], intent: Intent, overrides: Record<string, unknown> = {}, newCopy = false): Promise<PublishJob> {
    // Prepare every destination before the first authenticated request or upload.
    const prepared = await this.prepare(file, targets, intent, overrides);
    // Destination order changes presentation, not the user's publication intent.
    const targetsByName = [...prepared.targets].sort((a, b) => (a.platform + ':' + a.account).localeCompare(b.platform + ':' + b.account));
    const identity = { source: prepared.document.sourceDigest, file: prepared.document.file, intent, targets: targetsByName, cli: VERSION };
    const nonce = newCopy ? randomUUID() : '';
    const id = digest(JSON.stringify(identity) + nonce).slice(0, 32);
    return withFileLock(join(this.home, 'jobs', id + '.lock'), async () => {
      const existing = await readJson<PublishJob>(this.file(id));
      if (existing) return existing;
      const job: PublishJob = {
        schema: 1, id, intent, createdAt: new Date().toISOString(),
        source: { file: prepared.document.file, digest: prepared.document.sourceDigest }, targets: prepared.targets,
      };
      await this.save(job);
      return job;
    });
  }

  private async event(job: PublishJob, target: TargetJob, stage: string, phase: string): Promise<void> {
    const directory = join(this.home, 'jobs', job.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendFile(join(directory, 'events.jsonl'), JSON.stringify({
      time: new Date().toISOString(), platform: target.platform, account: target.account, stage, phase,
    }) + '\n', { mode: 0o600 });
  }

  private context(job: PublishJob, target: TargetJob, account: AccountStore): OperationContext {
    return { account, remember: async remote => { target.remote = remote; await this.save(job); }, step: async <T>(name: string, action: () => Promise<T>): Promise<T> => {
      const previous = target.steps[name];
      if (previous?.phase === 'done') return previous.value as T;
      if (previous && ['running', 'unknown', 'waiting_for_verification'].includes(previous.phase)) {
        throw new CliError('UNKNOWN', '上次写入结果尚未确认，不会重发。', { job_id: job.id, step: name });
      }
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
      try {
        await this.save(job);
        await this.event(job, target, name, 'confirmed');
      } catch {
        throw new CliError('UNKNOWN', '远端步骤已完成，但本地回执保存失败，请勿重复提交。', { job_id: job.id, step: name });
      }
      return value;
    } };
  }

  async run(id: string): Promise<PublishJob> {
    return withFileLock(join(this.home, 'jobs', jobName(id) + '.lock'), async () => {
      const job = await this.get(id);
      // Tasks freeze both document bytes and local assets; editing a file requires a new plan.
      if (digest(await readFile(job.source.file)) !== job.source.digest) throw new CliError('INPUT', '源文件已改变，请重新创建任务。');
      for (const target of job.targets) {
        for (const asset of [...target.article.assets, ...(target.article.cover ? [target.article.cover] : [])]) {
          if (asset.path && digest(await readFile(asset.path)) !== asset.digest) throw new CliError('INPUT', '图片已改变，请重新创建任务：' + asset.path);
        }
      }
      for (const target of job.targets) {
        if (target.status === 'published' || target.status === 'submitted' || (job.intent === 'draft' && target.status === 'draft_saved')) continue;
        const adapter = this.registry.get(target.platform);
        if (adapter.driver !== target.driver || adapter.version !== target.version) throw new CliError('INPUT', '任务驱动版本已改变，请核对旧任务后新建计划。');
        if (Object.values(target.steps).some(step => ['running', 'unknown', 'waiting_for_verification'].includes(step.phase))) {
          target.status = 'unknown';
          target.message = '存在结果未确认的写入。先执行 wm job refresh，不会自动重发。';
          await this.save(job);
          continue;
        }
        const operation = adapter.operations[job.intent];
        if (!operation) throw new CliError('UNSUPPORTED', '此驱动不支持任务操作。');
        const account = new AccountStore(this.home, target.platform, target.account);
        try {
          await account.lock(async () => {
            if (!await account.profile()) throw new CliError('AUTH', '此目标尚未登录，请运行 wm auth login ' + adapter.id);
            await account.verify(await adapter.status(account));
            target.status = 'running';
            delete target.message;
            await this.save(job);
            const result = await operation.run(this.context(job, target, account), target.article);
            target.status = result.status;
            target.remote = result.remote;
            target.message = result.message;
            await this.save(job);
          });
        } catch (error) {
          const steps = Object.values(target.steps);
          const uncertain = steps.some(step => ['unknown', 'running'].includes(step.phase));
          target.status = uncertain ? 'unknown' : 'rejected';
          if (error instanceof CliError && error.code === 'UNKNOWN') target.status = 'unknown';
          if (error instanceof CliError && error.code === 'VERIFICATION') target.status = 'waiting_for_verification';
          target.message = error instanceof Error ? error.message : String(error);
          await this.save(job);
        }
      }
      return job;
    });
  }

  async refresh(id: string): Promise<PublishJob> {
    return withFileLock(join(this.home, 'jobs', jobName(id) + '.lock'), async () => {
      const job = await this.get(id);
      for (const target of job.targets) {
        const adapter = this.registry.get(target.platform);
        if (!target.remote || !adapter.inspect) continue;
        const account = new AccountStore(this.home, target.platform, target.account);
        await account.lock(async () => {
          await account.verify(await adapter.status(account));
          const result = await adapter.inspect!(account, target.remote!, target.article);
          const uncertainPublish = job.intent === 'publish' && result.status === 'draft_saved' && Object.values(target.steps).some(step => ['running', 'unknown', 'waiting_for_verification'].includes(step.phase));
          target.status = uncertainPublish ? 'unknown' : result.status;
          target.message = result.message;
          target.remote = result.remote;
          await this.save(job);
        });
      }
      return job;
    });
  }
}
