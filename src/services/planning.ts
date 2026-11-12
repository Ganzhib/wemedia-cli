import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { accountIdentitySchema } from '../core/types.js';
import { digestSchema, artifactSchema, variantSchema, revisionSchema, type PreparedVariant } from '../core/content.js';
import type { PlatformRegistry } from '../core/registry.js';
import { workflowSchema } from '../core/workflow.js';
import { parseInput } from '../core/validation.js';
import { PreparationContext, immutableJson } from '../content/preparation.js';
import { AccountRepository, validateName } from '../runtime/accounts.js';
import { ObjectStore, canonicalJson, semanticDigest } from '../runtime/objects.js';
import { readJson } from '../runtime/storage.js';
import { contentChanges } from '../content/resources.js';
import { CliError } from '../shared/errors.js';

export const planTargetSchema = z.object({
  identity: accountIdentitySchema, alias: z.string(), variantId: digestSchema,
  revisionId: digestSchema, contentDigest: digestSchema,
  driver: z.object({ id: z.string(), version: z.string() }),
  workflow: workflowSchema,
});
export const planSchema = z.object({
  schema: z.literal(2), id: digestSchema, integrity: digestSchema, input: artifactSchema, createdAt: z.string(), capabilityId: z.string(),
  copyNonce: z.string(), targets: z.array(planTargetSchema),
});
export type PublishPlan = z.infer<typeof planSchema>;
export type PlanTarget = z.infer<typeof planTargetSchema>;
export function parseTarget(value: string) {
  const parts = value.split(':');
  if (parts.length > 2) throw new CliError('INPUT', '目标格式应为 platform:account。');
  return { platform: validateName(parts[0]), alias: validateName(parts[1] ?? 'main') };
}
function planIdentity(plan: Pick<PublishPlan, 'capabilityId' | 'copyNonce' | 'targets'>) {
  const targets = plan.targets.map(({ identity, revisionId, contentDigest }) => ({ identity, revisionId, contentDigest }));
  targets.sort((a, b) => a.identity.bindingId.localeCompare(b.identity.bindingId));
  return { contract: 'workflow-plan-v2', capabilityId: plan.capabilityId, copyNonce: plan.copyNonce, targets };
}

export class PlanningService {
  readonly objects: ObjectStore;
  readonly accounts: AccountRepository;
  constructor(readonly home: string, readonly registry: PlatformRegistry) {
    this.objects = new ObjectStore(home); this.accounts = new AccountRepository(home);
  }
  async prepare(capabilityId: string, input: unknown, destinations: string[]) {
    if (!destinations.length) throw new CliError('INPUT', '至少指定一个目标平台。');
    const batch = new PreparationContext(this.home);
    const targets = [];
    const unique = new Map(destinations.map(value => { const target = parseTarget(value); return [target.platform + ':' + target.alias, target]; }));
    for (const target of unique.values()) {
      const platform = this.registry.get(target.platform);
      const capability = this.registry.capability(target.platform, capabilityId);
      const context = batch.fork();
      const prepared = await capability.prepare(input, context);
      const variant = await context.freeze(prepared, platform.driver);
      targets.push({ ...target, prepared, variant });
    }
    return targets;
  }
  async create(capabilityId: string, input: unknown, destinations: string[], newCopy = false): Promise<PublishPlan> {
    // Prepare every target before binding or executing any of them; a later invalid target writes nothing remotely.
    const prepared = await this.prepare(capabilityId, input, destinations);
    const targets: PlanTarget[] = [];
    for (const target of prepared) {
      const platform = this.registry.get(target.platform);
      const capability = this.registry.capability(target.platform, capabilityId);
      if (capability.effect !== 'remote-write') throw new CliError('INPUT', '只读能力无需建立发布计划。');
      const identity = await this.accounts.resolve(target.platform, target.alias);
      if (targets.some(entry => entry.identity.bindingId === identity.bindingId)) continue;
      targets.push({ identity, alias: target.alias, variantId: target.variant.id, revisionId: target.variant.revisionId, contentDigest: target.variant.digest,
        driver: { ...platform.driver }, workflow: capability.compile(target.prepared) });
    }
    const base = { capabilityId, copyNonce: newCopy ? randomUUID() : '', targets };
    const inputArtifact = await this.objects.put(Buffer.from(canonicalJson(input)), 'application/json', '.json');
    const record = { schema: 2 as const, id: semanticDigest(planIdentity(base)), input: inputArtifact, createdAt: new Date().toISOString(), ...base };
    const plan: PublishPlan = { ...record, integrity: semanticDigest(record) };
    return immutableJson(this.home, 'plans', plan.id, plan);
  }
  async get(id: string): Promise<PublishPlan> {
    parseInput(digestSchema, id);
    const stored = await readJson(join(this.home, 'plans', id + '.json'));
    if (!stored) throw new CliError('INPUT', '找不到发布计划。', { plan_id: id });
    const plan = parseInput(planSchema, stored);
    const { integrity, ...record } = plan;
    if (semanticDigest(record) !== integrity) throw new CliError('INPUT', '发布计划记录损坏。');
    if (plan.id !== id || semanticDigest(planIdentity(plan)) !== id) throw new CliError('INPUT', '发布计划摘要不匹配。');
    return plan;
  }
  async diff(beforeId: string, afterId: string) {
    const before = await this.get(beforeId); const after = await this.get(afterId);
    const identities = new Set([...before.targets, ...after.targets].map(target => target.identity.bindingId));
    const targets = [];
    for (const bindingId of identities) {
      const previous = before.targets.find(target => target.identity.bindingId === bindingId);
      const next = after.targets.find(target => target.identity.bindingId === bindingId);
      const previousContent = previous && await this.variant(previous);
      const nextContent = next && await this.variant(next);
      targets.push({ identity: (next ?? previous)!.identity,
        changes: contentChanges(previousContent?.prepared, nextContent?.prepared),
        outputs: contentChanges(previousContent?.variant.outputs, nextContent?.variant.outputs) });
    }
    return { before: before.id, after: after.id, targets };
  }
  async variant(target: PlanTarget): Promise<{ variant: PreparedVariant; prepared: unknown }> {
    const variant = parseInput(variantSchema, await readJson(join(this.home, 'variants', target.variantId + '.json')));
    const { schema: _schema, id, ...semantic } = variant;
    if (id !== target.variantId || semanticDigest(semantic) !== id || variant.digest !== target.contentDigest || variant.revisionId !== target.revisionId) throw new CliError('INPUT', '平台产物摘要不匹配。');
    const revision = parseInput(revisionSchema, await readJson(join(this.home, 'revisions', variant.revisionId + '.json')));
    const { schema: _revisionSchema, id: revisionId, ...revisionInput } = revision;
    if (revisionId !== variant.revisionId || semanticDigest(revisionInput) !== revisionId) throw new CliError('INPUT', '内容修订摘要不匹配。');
    for (const artifact of [...variant.artifacts, ...variant.outputs.map(output => output.artifact)]) await this.objects.verify(artifact);
    const prepared: unknown = JSON.parse((await this.objects.read(variant.payload)).toString('utf8'));
    return { variant, prepared };
  }
}
